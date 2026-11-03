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

/** Paths below the root that are git's own or ours (`.git`, `.domaintrail` at any depth): never listed. */
const OWN = new Set(['.git', '.domaintrail']);

/** A relative path git gave that stays below the root and is neither git's nor ours. */
const listable = (p: string): boolean => {
    const parts = p.replace(/\/$/, '').split('/');
    return !path.isAbsolute(p) && !parts.some((s) => s === '' || s === '.' || s === '..' || OWN.has(s));
};

/**
 * The files below `root` git does not ignore (tracked, and untracked but not ignored), relative to the root and
 * `/`-separated: `git ls-files -co --exclude-standard`. A directory git does not descend into (an untracked nested
 * repository, a submodule) is given with a trailing `/` or as its own path; the caller copies regular files only.
 * Nothing in a `.git` or `.domaintrail` directory, at any depth. `undefined`: git does not speak for the root.
 */
export async function gitReadableFiles(root: string, options: GitFilesOptions = {}): Promise<string[] | undefined> {
    root = path.resolve(root);
    if (!(await gitSpeaksFor(root, options))) return undefined;
    return (await lsFiles(root, ['-c', '-o', '--exclude-standard'], options)).filter(listable);
}

/**
 * The ignored files and directories present below `root` (untracked; a wholly ignored directory once, not what is
 * below it), relative to the root, `/`-separated, without a trailing `/`: `git ls-files -o -i --exclude-standard
 * --directory`. Nothing in a `.git` or `.domaintrail` directory (always denied). `undefined`: git does not speak for
 * the root.
 */
export async function gitIgnoredEntries(root: string, options: GitFilesOptions = {}): Promise<string[] | undefined> {
    root = path.resolve(root);
    if (!(await gitSpeaksFor(root, options))) return undefined;
    const entries = (await lsFiles(root, ['-o', '-i', '--exclude-standard', '--directory'], options)).filter(listable).map((p) => p.replace(/\/$/, ''));
    // git may name a file below a directory it already gave: the directory covers it
    const listed = new Set(entries);
    const covered = (p: string): boolean => {
        for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) if (listed.has(p.slice(0, i))) return true;
        return false;
    };
    return [...listed].filter((p) => !covered(p));
}
