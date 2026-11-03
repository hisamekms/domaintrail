// What the answerer role may read (ADR 0030, as built in M4; the maintainer's decision of 2026-11-03): any file of the
// workspace — the model, READMEs, notes, code — but nothing outside the workspace's root, never `.domaintrail/` (the
// session's state: the agent API's credential), never `.git/`, and no file `.gitignore` ignores (`.env`, build
// outputs, `node_modules`). Claude Code's permission rules cannot say "not ignored by git", so the answerer does not
// run in the workspace: it runs in a **view**, a private directory (0700, outside the workspace) holding copies of the
// readable files only, refreshed before each of its turns (a file copied again only when its size or time changed;
// one gone, removed). Its process reads only inside its working directory (`claudeArguments`: no settings loaded,
// `dontAsk`), so nothing else is reachable. Symbolic links and special files are never copied; a file larger than
// `maxFileBytes` is left out, and a workspace with more than `maxFiles` readable files is refused (as the scan of runs).
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/** Directory names never in the view, at any depth. */
const NEVER = new Set(['.domaintrail', '.git', 'node_modules']);

export interface WorkspaceViewOptions {
    readonly root: string;
    /** Whether a path below the root is ignored by `.gitignore` (`directory`: it is one). Absent: nothing is. */
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

    const update = async (): Promise<string> => {
        const view = await make();
        const seen = new Set<string>();
        const walk = async (from: string, rel: string): Promise<void> => {
            for (const entry of await readdir(from, { withFileTypes: true })) {
                const full = path.join(from, entry.name);
                const relPath = rel ? `${rel}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    if (NEVER.has(entry.name) || options.ignores?.(full, true)) continue;
                    await walk(full, relPath);
                    continue;
                }
                // regular files only: a link may point anywhere
                if (!entry.isFile() || options.ignores?.(full, false)) continue;
                const s = await lstat(full, { bigint: true }).catch(() => undefined);
                if (!s?.isFile() || s.size > BigInt(maxFileBytes)) continue;
                if (seen.size >= maxFiles) throw new Error(`More than ${maxFiles} readable files below ${root}: too many for the answerer's view`);
                seen.add(relPath);
                const print = `${s.size}|${s.mtimeNs}|${s.ctimeNs}`;
                if (copied.get(relPath) === print) continue;
                const target = path.join(view, ...relPath.split('/'));
                await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
                await copyFile(full, target);
                copied.set(relPath, print);
            }
        };
        await walk(root, '');
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

/** Most ignored entries `ignoredEntries` gives (deny rules of the runner's process). */
export const MAX_IGNORED_ENTRIES = 500;

/**
 * The runner works in the workspace itself (it edits it), so what git ignores is kept from it by deny rules
 * (`deniedRules`): the topmost ignored files and directories present now (relative, `/`-separated; nothing below an
 * ignored directory, nor `.domaintrail/` and `.git/`, which are always denied). Past `MAX_IGNORED_ENTRIES`, the rest
 * is left out (the ADR's residual risk).
 */
export async function ignoredEntries(root: string, ignores: (absolutePath: string, directory: boolean) => boolean): Promise<string[]> {
    const out: string[] = [];
    const walk = async (from: string, rel: string): Promise<void> => {
        for (const entry of await readdir(from, { withFileTypes: true })) {
            if (out.length >= MAX_IGNORED_ENTRIES) return;
            const full = path.join(from, entry.name);
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            const directory = entry.isDirectory();
            if (directory && (entry.name === '.domaintrail' || entry.name === '.git')) continue;
            if (ignores(full, directory)) {
                out.push(relPath);
                continue;
            }
            if (directory) await walk(full, relPath);
        }
    };
    await walk(path.resolve(root), '');
    return out;
}
