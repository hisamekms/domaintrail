// What git itself says of a workspace's files (ADR 0030, as built in M4b): which ones it does not ignore, and which
// ignored ones are present, asked of `git ls-files` rather than worked out from the `.gitignore` files, so that every
// source git reads applies — the `.gitignore` files, `.git/info/exclude` and `core.excludesFile` (by default
// `$XDG_CONFIG_HOME/git/ignore`, i.e. `~/.config/git/ignore`). `GitIgnore` reimplements only the first two.
//
// Both answer `undefined` when git cannot speak for the root: it is in no git repository, or the enclosing repository
// ignores the root itself (a copy of a project inside an ignored directory, checked with `-r`: to git, all of it is
// ignored). The caller then falls back to `GitIgnore` (with the user's excludes file: `userExcludes`). Inside a
// repository, git failing (not installed, `safe.directory`, a broken index) is an error, never a fallback.
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import * as path from 'node:path';
import { repositoryTop } from './gitignore.js';

/** Options of the git commands: the environment (default this process's). */
export interface GitFilesOptions {
    readonly env?: NodeJS.ProcessEnv;
}

interface GitResult {
    readonly code: number;
    readonly stdout: Buffer;
    readonly stderr: string;
}

/** Runs `git` in `cwd` (an argument array, no shell); no hook or fsmonitor command of the repository runs. */
function git(cwd: string, args: readonly string[], options: GitFilesOptions): Promise<GitResult> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...args], {
            cwd,
            env: { ...(options.env ?? process.env), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const out: Buffer[] = [];
        let err = '';
        child.stdout.on('data', (c: Buffer) => out.push(c));
        child.stderr.on('data', (c: Buffer) => {
            if (err.length < 4096) err += c.toString('utf8');
        });
        child.on('error', (e) => reject(new Error(`git could not be run in ${cwd} (${e.message})`)));
        child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err.trim() }));
    });
}

/** Whether git speaks for `root`: inside a repository that does not ignore the root itself. */
async function gitSpeaksFor(root: string, options: GitFilesOptions): Promise<boolean> {
    if (!repositoryTop(root)) return false;
    // 0: the root is ignored; 1: it is not; anything else: git failed
    const r = await git(root, ['check-ignore', '-q', '.'], options);
    if (r.code === 0) return false;
    if (r.code === 1) return true;
    throw new Error(`git check-ignore failed in ${root}: ${r.stderr || `exit ${r.code}`}`);
}

async function lsFiles(root: string, args: readonly string[], options: GitFilesOptions): Promise<string[]> {
    const r = await git(root, ['ls-files', '-z', ...args], options);
    if (r.code !== 0) throw new Error(`git ls-files failed in ${root}: ${r.stderr || `exit ${r.code}`}`);
    return r.stdout
        .toString('utf8')
        .split('\0')
        .filter((p) => p !== '');
}

/** Paths below the root that are git's own or ours (`.git`, `.domaintrail` at any depth). */
const OWN = new Set(['.git', '.domaintrail']);
/**
 * What is left out of what may be read: `.git` and `.domaintrail` in any case and Unicode form (NFC, lower case), since
 * on a case-insensitive file system `.GIT/config`, an index entry git may hold, opens `.git/config`.
 */
const ownFolded = (name: string): boolean => OWN.has(name.normalize('NFC').toLowerCase());
/** What is left out of what is denied: exactly `.git` and `.domaintrail` (the static deny rules); a case variant stays. */
const ownExact = (name: string): boolean => OWN.has(name);

/** A relative path git gave that stays below the root and has no part `own` says is git's or ours. */
const listable =
    (own: (name: string) => boolean) =>
    (p: string): boolean => {
        const parts = p.replace(/\/$/, '').split('/');
        return !path.isAbsolute(p) && !parts.some((s) => s === '' || s === '.' || s === '..' || own(s));
    };

/**
 * The files below `root` git does not ignore (tracked, and untracked but not ignored), relative to the root and
 * `/`-separated: `git ls-files -co --exclude-standard`. A directory git does not descend into (an untracked nested
 * repository, a submodule) is given with a trailing `/` or as its own path; the caller copies regular files only.
 * Nothing in a `.git` or `.domaintrail` directory (in any case), at any depth. `undefined`: git does not speak for the root.
 */
export async function gitReadableFiles(root: string, options: GitFilesOptions = {}): Promise<string[] | undefined> {
    root = path.resolve(root);
    if (!(await gitSpeaksFor(root, options))) return undefined;
    return (await lsFiles(root, ['-c', '-o', '--exclude-standard'], options)).filter(listable(ownFolded));
}

/**
 * The ignored files and directories present below `root` (untracked; a wholly ignored directory once, not what is
 * below it), relative to the root, `/`-separated, without a trailing `/`: `git ls-files -o -i --exclude-standard
 * --directory`. Nothing in an exact `.git` or `.domaintrail` directory (always denied by the static rules; a case
 * variant is listed, to be denied by a rule of its own). `undefined`: git does not speak for
 * the root.
 */
export async function gitIgnoredEntries(root: string, options: GitFilesOptions = {}): Promise<string[] | undefined> {
    root = path.resolve(root);
    if (!(await gitSpeaksFor(root, options))) return undefined;
    const entries = (await lsFiles(root, ['-o', '-i', '--exclude-standard', '--directory'], options))
        .filter(listable(ownExact))
        .map((p) => p.replace(/\/$/, ''));
    // git may name a file below a directory it already gave: the directory covers it
    const listed = new Set(entries);
    const covered = (p: string): boolean => {
        for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) if (listed.has(p.slice(0, i))) return true;
        return false;
    };
    return [...listed].filter((p) => !covered(p));
}

/**
 * The nested repositories below `root`, relative, `/`-separated, without a trailing `/`: the submodules (gitlinks,
 * mode 160000 in `git ls-files --stage`) and the untracked repositories git does not descend into (given by `git
 * ls-files -o --exclude-standard` with a trailing `/`). git applies none of their own ignores for the root's
 * repository, so the runner is denied each as a whole (the answerer's view has none of their files already). An
 * ignored one is among `gitIgnoredEntries`. `undefined`: git does not speak for the root.
 */
export async function gitNestedRepositories(root: string, options: GitFilesOptions = {}): Promise<string[] | undefined> {
    root = path.resolve(root);
    if (!(await gitSpeaksFor(root, options))) return undefined;
    const gitlinks = (await lsFiles(root, ['--stage'], options))
        .map((line) => /^160000 [0-9a-f]+ \d+\t(.+)$/.exec(line)?.[1])
        .filter((p): p is string => p !== undefined);
    const untracked = (await lsFiles(root, ['-o', '--exclude-standard'], options)).filter((p) => p.endsWith('/')).map((p) => p.replace(/\/$/, ''));
    const found: string[] = [];
    for (const p of new Set([...gitlinks, ...untracked].filter(listable(ownExact)))) {
        // only a directory present: a gitlink not checked out has nothing to read
        if ((await lstat(path.join(root, ...p.split('/'))).catch(() => undefined))?.isDirectory()) found.push(p);
    }
    return found;
}

/**
 * Whether git would commit the file `file` (absolute): `tracked`, `unignored` (untracked and not ignored: `git add .`
 * takes it) or `ignored`; `undefined`: it is in no git repository. For the local override of the configuration, which
 * must never be committed.
 */
export async function gitFileState(file: string, options: GitFilesOptions = {}): Promise<'tracked' | 'unignored' | 'ignored' | undefined> {
    const dir = path.dirname(path.resolve(file));
    if (!repositoryTop(dir)) return undefined;
    const name = path.basename(file);
    const tracked = await git(dir, ['ls-files', '--error-unmatch', '--', name], options);
    if (tracked.code === 0) return 'tracked';
    const ignored = await git(dir, ['check-ignore', '-q', '--', name], options);
    if (ignored.code === 0) return 'ignored';
    if (ignored.code === 1) return 'unignored';
    throw new Error(`git check-ignore failed in ${dir}: ${ignored.stderr || `exit ${ignored.code}`}`);
}
