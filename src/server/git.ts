import { execFile, spawn } from 'node:child_process';
import * as path from 'node:path';
import type { SourceFile } from '../core/analyze.js';
import { sourceMatcher } from '../core/config.js';

/**
 * Read-only access to the git repository around a Live View workspace, for comparing the model with a revision. Every
 * call runs `git` without a shell, and a ref given by the user is resolved with `--end-of-options`, so that it is never
 * read as an option.
 */

/** A resolved revision. */
export interface GitCommit {
    /** Full object name. */
    hash: string;
    subject: string;
    /** Committer date (ISO 8601). */
    date: string;
}

/** Revisions offered as baselines: branches, tags and the latest commits of HEAD. */
export interface GitRefs {
    branches: string[];
    tags: string[];
    commits: (GitCommit & { short: string })[];
}

/** A ref the repository does not have (or that does not name a commit). */
export class UnknownRevisionError extends Error {}

const MAX_BUFFER = 64 * 1024 * 1024;

function git(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
}

/** The git directories to watch for moving refs (`HEAD`, branches), or undefined when `root` is not in a repository. */
export async function gitDirs(root: string): Promise<string[] | undefined> {
    try {
        const [gitDir, commonDir] = (await git(root, ['rev-parse', '--absolute-git-dir', '--git-common-dir'])).trim().split('\n');
        return [...new Set([gitDir, path.resolve(root, commonDir)])];
    } catch {
        return undefined;
    }
}

/** Resolves `ref` to a commit; throws `UnknownRevisionError` when it names none. */
export async function resolveCommit(root: string, ref: string): Promise<GitCommit> {
    let hash: string;
    try {
        hash = (await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])).trim();
    } catch {
        throw new UnknownRevisionError(`Unknown revision '${ref}'`);
    }
    const [subject = '', date = ''] = (await git(root, ['log', '-1', '--format=%s%x00%cI', hash])).trimEnd().split('\0');
    return { hash, subject, date };
}

/** Branches, tags and the last `limit` commits of HEAD; empty lists outside a repository or before the first commit. */
export async function listRefs(root: string, limit = 30): Promise<GitRefs> {
    const lines = (out: string) => out.split('\n').filter(Boolean);
    const refs = (pattern: string) => git(root, ['for-each-ref', '--format=%(refname:short)', pattern]).then(lines, () => []);
    const [branches, tags, log] = await Promise.all([
        refs('refs/heads'),
        refs('refs/tags'),
        git(root, ['log', `-${limit}`, '--format=%H%x00%h%x00%s%x00%cI', 'HEAD', '--']).then(lines, () => []),
    ]);
    const commits = log.map((l) => {
        const [hash, short, subject, date] = l.split('\0');
        return { hash, short, subject, date };
    });
    return { branches, tags, commits };
}

/**
 * The sources of the workspace as they are in `commit`: the files below `root` that match `sources` (paths relative to
 * `root`, sorted). Files ignored by `.gitignore` are not committed, so it is not consulted.
 */
export async function sourcesAt(root: string, commit: string, sources: readonly string[]): Promise<SourceFile[]> {
    const matches = sourceMatcher(sources);
    // run in `root`: paths are listed relative to it, and only those below it
    const entries = (await git(root, ['ls-tree', '-r', '-z', commit, '--']))
        .split('\0')
        .filter(Boolean)
        .map((line) => {
            const tab = line.indexOf('\t');
            const [, type, oid] = line.slice(0, tab).split(' ');
            return { type, oid, path: line.slice(tab + 1) };
        })
        .filter((e) => e.type === 'blob' && matches(e.path))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (entries.length === 0) return [];
    const blobs = await catBlobs(
        root,
        entries.map((e) => e.oid),
    );
    return entries.map((e, i) => ({ path: e.path, text: blobs[i] }));
}

/** The contents of blobs, in order, read through one `git cat-file --batch`. */
function catBlobs(cwd: string, oids: string[]): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['cat-file', '--batch'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
        const chunks: Buffer[] = [];
        child.stdout.on('data', (c: Buffer) => chunks.push(c));
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) return reject(new Error(`git cat-file exited with ${code}`));
            const out = Buffer.concat(chunks);
            const texts: string[] = [];
            let at = 0;
            for (const oid of oids) {
                const eol = out.indexOf(0x0a, at);
                const header = out.subarray(at, eol).toString('utf8').split(' ');
                if (header[0] !== oid || header[1] !== 'blob') return reject(new Error(`git cat-file: unexpected object ${header.join(' ')}`));
                const size = Number(header[2]);
                texts.push(out.subarray(eol + 1, eol + 1 + size).toString('utf8'));
                at = eol + 1 + size + 1; // the content is followed by a newline
            }
            resolve(texts);
        });
        child.stdin.end(oids.map((o) => `${o}\n`).join(''));
    });
}
