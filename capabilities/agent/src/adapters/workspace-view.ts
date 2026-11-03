// What the answerer role may read (ADR 0030, as built in M4 and M4b; the maintainer's decision of 2026-11-03): any file
// of the workspace — the model, READMEs, notes, code — but nothing outside the workspace's root, never `.domaintrail/`
// (the session's state: the agent API's credential) nor `.git` (a directory, or a submodule's or worktree's file), at
// any depth, and no file git ignores (`.env`, build outputs, `node_modules`). Claude Code's permission rules cannot say
// "not ignored by git", so the answerer does not run in the workspace: it runs in a **view**, a private directory (0700,
// outside the workspace) holding copies of the readable files only, refreshed before each of its turns (a file copied
// again only when its size or time changed; one gone, removed). Its process reads only inside its working directory
// (`claudeArguments`: no settings loaded, `dontAsk`), so nothing else is reachable.
//
// Which files are readable is an allowlist from git itself when git speaks for the root (`list`: `git ls-files -co
// --exclude-standard`, so `core.excludesFile` and `.git/info/exclude` apply as in git); otherwise (no repository, or a
// root its repository ignores) the tree is walked with `ignores` (`GitIgnore` with the user's excludes file). Symbolic
// links (the file or a directory above it) and special files are never copied; a file larger than `maxFileBytes` is
// left out, and a workspace with more than `maxFiles` readable files is refused (as the scan of runs).
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/** Names never in the view, at any depth: as a directory or as a file (a submodule's `.git` is one). */
const NEVER = new Set(['.domaintrail', '.git', 'node_modules']);

export interface WorkspaceViewOptions {
    readonly root: string;
    /**
     * The readable files, relative to the root and `/`-separated (git's allowlist); `undefined`: git does not speak for
     * the root, and the tree is walked with `ignores`. Absent: always walked.
     */
    readonly list?: () => Promise<readonly string[] | undefined>;
    /** Whether a path below the root is ignored (`directory`: it is one), when walked. Absent: nothing is. */
    readonly ignores?: (absolutePath: string, directory: boolean) => boolean;
    /** The largest file copied (default 2 MiB). */
    readonly maxFileBytes?: number;
    /** Most files in the view (default 20,000). */
    readonly maxFiles?: number;
    /** Where the view's directory is made (default the system's temporary directory). */
    readonly parent?: string;
}

export interface WorkspaceView {
    /** Brings the view up to date with the workspace; its directory. */
    refresh(): Promise<string>;
    /** Removes the view. */
    dispose(): Promise<void>;
}

/** A listed path that stays below the root, names a file (no trailing `/`), and has no part in `NEVER`. */
const listedFile = (p: string): boolean => {
    if (!p || p.endsWith('/') || path.isAbsolute(p) || /[\0]/.test(p)) return false;
    return !p.split('/').some((s) => s === '' || s === '.' || s === '..' || NEVER.has(s));
};

export function createWorkspaceView(options: WorkspaceViewOptions): WorkspaceView {
    const root = path.resolve(options.root);
    const maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
    const maxFiles = options.maxFiles ?? 20_000;
    let dir: string | undefined;
    /** The fingerprint of each file copied, by relative path. */
    const copied = new Map<string, string>();
    let tail: Promise<unknown> = Promise.resolve();

    const make = async (): Promise<string> => {
        if (dir) return dir;
        dir = await mkdtemp(path.join(options.parent ?? tmpdir(), 'dt-answerer-'));
        await chmod(dir, 0o700);
        return dir;
    };

    /** The readable files' relative paths: git's allowlist, else a walk of the tree (no link followed). */
    const readable = async (): Promise<string[]> => {
        const listed = await options.list?.();
        if (listed) return listed.filter(listedFile);
        const out: string[] = [];
        const walk = async (from: string, rel: string): Promise<void> => {
            for (const entry of await readdir(from, { withFileTypes: true })) {
                if (NEVER.has(entry.name)) continue;
                const full = path.join(from, entry.name);
                const relPath = rel ? `${rel}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    if (!options.ignores?.(full, true)) await walk(full, relPath);
                } else if (entry.isFile() && !options.ignores?.(full, false)) out.push(relPath);
            }
        };
        await walk(root, '');
        return out;
    };

    const update = async (): Promise<string> => {
        const view = await make();
        const seen = new Set<string>();
        /** Directories below the root known to be real ones (no link) during this refresh. */
        const realDirs = new Map<string, boolean>();
        const realDir = async (rel: string): Promise<boolean> => {
            if (!rel) return true;
            const known = realDirs.get(rel);
            if (known !== undefined) return known;
            const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
            const ok = (await realDir(parent)) && ((await lstat(path.join(root, ...rel.split('/'))).catch(() => undefined))?.isDirectory() ?? false);
            realDirs.set(rel, ok);
            return ok;
        };
        for (const relPath of await readable()) {
            const dirRel = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
            if (!(await realDir(dirRel))) continue;
            const full = path.join(root, ...relPath.split('/'));
            const s = await lstat(full, { bigint: true }).catch(() => undefined);
            // regular files only: a link may point anywhere
            if (!s?.isFile() || s.size > BigInt(maxFileBytes)) continue;
            if (seen.size >= maxFiles) throw new Error(`More than ${maxFiles} readable files below ${root}: too many for the answerer's view`);
            seen.add(relPath);
            const print = `${s.size}|${s.mtimeNs}|${s.ctimeNs}`;
            if (copied.get(relPath) === print) continue;
            const content = await readRegular(full, maxFileBytes);
            if (content === undefined) {
                seen.delete(relPath);
                continue;
            }
            const target = path.join(view, ...relPath.split('/'));
            await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
            await writeFile(target, content, { mode: 0o600 });
            copied.set(relPath, print);
        }
        for (const rel of copied.keys()) {
            if (seen.has(rel)) continue;
            copied.delete(rel);
            await unlink(path.join(view, ...rel.split('/'))).catch(() => undefined);
        }
        return view;
    };

    return {
        refresh() {
            // one refresh at a time
            const next = tail.then(update, update);
            tail = next.catch(() => undefined);
            return next;
        },
        async dispose() {
            await tail;
            if (dir) await rm(dir, { recursive: true, force: true });
            dir = undefined;
            copied.clear();
        },
    };
}

/** The content of a regular file, opened without following a link (one put in its place after `lstat`): else none. */
async function readRegular(file: string, maxBytes: number): Promise<Buffer | undefined> {
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined);
    if (!handle) return undefined;
    try {
        const s = await handle.stat();
        if (!s.isFile() || s.size > maxBytes) return undefined;
        return await handle.readFile();
    } finally {
        await handle.close();
    }
}

/** Most ignored entries `ignoredEntries` gives (deny rules of the runner's process). */
export const MAX_IGNORED_ENTRIES = 500;

/** Where the runner's ignored entries come from: git's list when it speaks for the root, else a walk with `ignores`. */
export interface IgnoredSource {
    /** The ignored entries, relative and `/`-separated (git's); `undefined`: git does not speak for the root. */
    readonly list?: () => Promise<readonly string[] | undefined>;
    readonly ignores: (absolutePath: string, directory: boolean) => boolean;
}

/**
 * The runner works in the workspace itself (it edits it), so what git ignores is kept from it by deny rules
 * (`deniedRules`): the topmost ignored files and directories present now (relative, `/`-separated; nothing below an
 * ignored directory, nor anything in `.domaintrail` and `.git`, which are always denied at any depth). Past
 * `MAX_IGNORED_ENTRIES`, the rest is left out (the ADR's residual risk).
 */
export async function ignoredEntries(root: string, source: IgnoredSource): Promise<string[]> {
    const listed = await source.list?.();
    if (listed) {
        return listed
            .map((p) => p.replace(/\/$/, ''))
            .filter((p) => p && !p.split('/').some((s) => s === '.git' || s === '.domaintrail'))
            .slice(0, MAX_IGNORED_ENTRIES);
    }
    const out: string[] = [];
    const walk = async (from: string, rel: string): Promise<void> => {
        for (const entry of await readdir(from, { withFileTypes: true })) {
            if (out.length >= MAX_IGNORED_ENTRIES) return;
            if (entry.name === '.domaintrail' || entry.name === '.git') continue;
            const full = path.join(from, entry.name);
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            const directory = entry.isDirectory();
            if (source.ignores(full, directory)) {
                out.push(relPath);
                continue;
            }
            if (directory) await walk(full, relPath);
        }
    };
    await walk(path.resolve(root), '');
    return out;
}
