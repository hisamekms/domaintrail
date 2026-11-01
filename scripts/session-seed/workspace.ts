// The scratch workspace a seed runs in: a fresh copy of examples/shop (without its layout cache, session or generated
// code), its config with the session's port and the mock classifier, committed to a git repository of its own so that
// `git diff` shows what the runs changed. A directory is wiped only when it is one a seed made (`--reset`).
import { spawnSync } from 'node:child_process';
import { access, chmod, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { readServerAddress } from '@domaintrail/collaboration/infrastructure/session-files';

/** The file a seed leaves in the directories it makes: only those are wiped by `--reset`. */
export const SEED_MARKER = '.dt-session-seed';
/** The account the mock classifier is configured with (any 32 hexadecimal digits: the mock answers for any). */
const MOCK_ACCOUNT = '0'.repeat(32);
/** The environment variable the seeded config names for the classifier's token (never a real token). */
export const SEED_TOKEN_ENV = 'DT_SEED_CLASSIFIER_TOKEN';

const exists = (p: string): Promise<boolean> =>
    access(p).then(
        () => true,
        () => false,
    );

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e instanceof Error && 'code' in e && e.code === 'EPERM';
    }
}

/** Why the seed refuses `dir`, if it does; wipes it first when `reset` and it is a seed's directory. */
export async function prepareDir(dir: string, reset: boolean): Promise<void> {
    if (!(await exists(dir))) return;
    const entries = await readdir(dir);
    if (entries.length === 0) return;
    const server = await readServerAddress(dir).catch(() => undefined);
    if (server && processAlive(server.pid))
        throw new Error(`A session server (pid ${server.pid}) is running on ${dir}: stop it (Ctrl+C) before seeding again.`);
    const seeded = entries.includes(SEED_MARKER);
    const session = await exists(path.join(dir, '.domaintrail', 'session'));
    if (!reset) {
        throw new Error(
            session
                ? `${dir} already has a session: pass --reset to wipe it and seed again, or --dir for another directory.`
                : `${dir} is not empty: pass --dir for a new directory${seeded ? ', or --reset to wipe it' : ''}.`,
        );
    }
    if (!seeded) throw new Error(`${dir} was not made by the seed (no ${SEED_MARKER}): refusing to wipe it. Pass --dir for a new directory.`);
    await rm(dir, { recursive: true, force: true });
}

/** `config` with the `session` section added (the file is JSONC: the section goes before its last brace). */
export function withSession(config: string, session: object): string {
    const end = config.lastIndexOf('}');
    if (end < 0) throw new Error('The workspace config is not an object');
    const before = config.slice(0, end).trimEnd();
    const comma = before.endsWith(',') || before.endsWith('{') ? '' : ',';
    return `${before}${comma}\n  // added by scripts/session-seed.ts\n  "session": ${JSON.stringify(session)},\n}\n`;
}

function git(dir: string, args: string[]): void {
    const r = spawnSync('git', ['-c', 'user.name=session-seed', '-c', 'user.email=session-seed@localhost', '-c', 'commit.gpgsign=false', ...args], {
        cwd: dir,
        encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr || r.error?.message}`);
}

/** Copies `source` into `dir` (made), writes its session config and commits it. */
export async function copyWorkspace(source: string, dir: string, options: { port: number; classifier: boolean }): Promise<void> {
    if (!(await exists(path.join(source, 'domaintrail.jsonc')))) throw new Error(`${source} has no domaintrail.jsonc: not a workspace to copy.`);
    await mkdir(dir, { recursive: true });
    await cp(source, dir, {
        recursive: true,
        filter: (src) => {
            const rel = path.relative(source, src).split(path.sep);
            return !rel.includes('.domaintrail') && !rel.includes('generated') && !rel.includes('node_modules');
        },
    });
    const file = path.join(dir, 'domaintrail.jsonc');
    const session = {
        port: options.port,
        ...(options.classifier && { classifier: { enabled: true, accountId: MOCK_ACCOUNT, apiTokenEnv: SEED_TOKEN_ENV } }),
    };
    await writeFile(file, withSession(await readFile(file, 'utf8'), session));
    await writeFile(path.join(dir, '.gitignore'), '.domaintrail/\ngenerated/\n');
    await writeFile(path.join(dir, SEED_MARKER), 'Made by scripts/session-seed.ts; `--reset` may wipe this directory.\n');
    git(dir, ['init', '-q']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'before the session']);
}

/** Writes who was seeded, with their cookies, for the person and the browser checks (private: mode 600). */
export async function writeSeedFile(dir: string, data: object): Promise<string> {
    const file = path.join(dir, '.domaintrail', 'seed.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    return file;
}

/** Replaces `pattern` in a file of the workspace; fails loudly when it is not there (the scenarios rely on the shop's model). */
export async function editFile(root: string, file: string, pattern: RegExp | string, replacement: string): Promise<void> {
    const p = path.join(root, file);
    const text = await readFile(p, 'utf8');
    const found = typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
    if (!found) throw new Error(`${file} has no ${String(pattern)}: the scenario expects examples/shop's model`);
    await writeFile(p, text.replace(pattern, replacement));
}

/** Writes a file of the workspace (made or replaced). */
export async function writeSource(root: string, file: string, text: string): Promise<void> {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
}
