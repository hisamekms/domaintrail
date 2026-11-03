// The move of an older version's `.domaintrail/` to the workspace's state and cache directories: the session's
// database with its WAL (what was not checkpointed kept), the blobs, the manifest and the layouts; refused while an
// older server runs; never over a session already there; idempotent; finished by the next run when one stopped half
// way; never through a link; files that are not dt's kept.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { moveLegacyState } from './legacy-state.js';
import { StateDirError, type StateEnvironment, workspaceDirs } from './state-dirs.js';
import { openWorkspaceState } from './workspace-state.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
    const d = await realpath(await mkdtemp(path.join(tmpdir(), 'domaintrail-legacy-')));
    dirs.push(d);
    return d;
}

const environment = (base: string): StateEnvironment => ({
    env: { XDG_STATE_HOME: path.join(base, 'state'), XDG_CACHE_HOME: path.join(base, 'cache') },
    platform: process.platform,
    home: path.join(base, 'home'),
});
const modeOf = async (p: string): Promise<number> => (await lstat(p)).mode & 0o777;
const exists = async (p: string): Promise<boolean> => (await lstat(p).catch(() => undefined)) !== undefined;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
/** A process ID no process has (one that ran and ended). */
const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid ?? 999_999;

/**
 * A workspace with what an older version left in `.domaintrail/`: a session database in WAL mode with rows not
 * checkpointed (the WAL copied while its connection was open, as a server killed would leave it), a blob, the
 * manifest, the layouts, the ignore files, a stopped server's address and an old credential.
 */
async function legacyWorkspace(base: string): Promise<{ ws: string; legacy: string; blob: string }> {
    const ws = path.join(base, 'shop');
    const legacy = path.join(ws, '.domaintrail');
    const session = path.join(legacy, 'session');
    await mkdir(session, { recursive: true, mode: 0o755 });
    const live = path.join(base, 'live');
    await mkdir(live);
    const db = new DatabaseSync(path.join(live, 'session.db'));
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA wal_autocheckpoint = 0');
    db.exec('CREATE TABLE requests (text TEXT)');
    db.exec("INSERT INTO requests VALUES ('hello'), ('again')");
    for (const f of ['session.db', 'session.db-wal', 'session.db-shm']) await cp(path.join(live, f), path.join(session, f));
    db.close();
    const blob = 'context Sales {}\n';
    await mkdir(path.join(session, 'blobs', sha(blob).slice(0, 2)), { recursive: true });
    await writeFile(path.join(session, 'blobs', sha(blob).slice(0, 2), sha(blob)), blob, { mode: 0o644 });
    await writeFile(path.join(legacy, 'generated.json'), JSON.stringify({ version: 1, files: ['generated/a.ts'] }));
    await writeFile(path.join(legacy, 'layout.json'), '{"version":1}');
    await writeFile(path.join(legacy, '.gitignore'), '*\n');
    await writeFile(path.join(session, '.gitignore'), '*\n');
    await writeFile(path.join(session, 'server.json'), JSON.stringify({ url: 'http://127.0.0.1:1/', session: 's', pid: deadPid() }));
    await writeFile(path.join(session, 'agent.json'), '{"token":"old"}');
    return { ws, legacy, blob };
}

/** The rows of the session database in `dir`. */
function rows(dir: string): unknown[] {
    const db = new DatabaseSync(path.join(dir, 'session.db'));
    try {
        return db
            .prepare('SELECT text FROM requests ORDER BY rowid')
            .all()
            .map((r) => r.text);
    } finally {
        db.close();
    }
}

describe('moving .domaintrail/', () => {
    test.skipIf(process.platform === 'win32')(
        'everything of dt moves, the WAL with its database (rows kept), private; .domaintrail/ is deleted and that is said once',
        async () => {
            const base = await scratch();
            const { ws, legacy, blob } = await legacyWorkspace(base);
            const lines: string[] = [];
            const d = await openWorkspaceState(ws, { environment: environment(base), log: (l) => lines.push(l) });
            expect(lines).toEqual([`Moved .domaintrail/ to ${d.state}${path.sep}`]);
            expect(await exists(legacy)).toBe(false);
            expect(rows(d.state)).toEqual(['hello', 'again']);
            const blobFile = path.join(d.state, 'blobs', sha(blob).slice(0, 2), sha(blob));
            expect(await readFile(blobFile, 'utf8')).toBe(blob);
            expect(JSON.parse(await readFile(path.join(d.state, 'generated.json'), 'utf8')).files).toEqual(['generated/a.ts']);
            expect(await readFile(path.join(d.cache, 'layout.json'), 'utf8')).toBe('{"version":1}');
            // a stopped server's address, an old credential and the ignore files are not kept
            expect((await readdir(d.state)).sort()).toEqual(['blobs', 'generated.json', 'session.db', 'session.db-shm', 'session.db-wal', 'workspace.json']);
            for (const p of [d.state, path.join(d.state, 'blobs'), path.dirname(blobFile)]) expect(await modeOf(p)).toBe(0o700);
            for (const p of ['session.db', 'session.db-wal', 'generated.json', 'workspace.json']) expect(await modeOf(path.join(d.state, p))).toBe(0o600);
            expect(await modeOf(blobFile)).toBe(0o600);
            expect(JSON.parse(await readFile(path.join(d.state, 'workspace.json'), 'utf8'))).toEqual({ version: 1, path: ws, movedFrom: legacy });
            expect(await readdir(ws)).toEqual([]);

            // already moved: nothing to do, nothing said
            lines.length = 0;
            await openWorkspaceState(ws, { environment: environment(base), log: (l) => lines.push(l) });
            expect(lines).toEqual([]);
            expect(rows(d.state)).toEqual(['hello', 'again']);
        },
    );

    test('no .domaintrail/, or one that is a link or a file: nothing moves, nothing is touched', async () => {
        const base = await scratch();
        const ws = path.join(base, 'shop');
        await mkdir(ws);
        expect(await moveLegacyState(workspaceDirs(ws, environment(base)), () => {})).toBe('none');
        const outside = path.join(base, 'outside');
        await mkdir(path.join(outside, 'session'), { recursive: true });
        await writeFile(path.join(outside, 'session', 'session.db'), 'x');
        await symlink(outside, path.join(ws, '.domaintrail'));
        expect(await moveLegacyState(workspaceDirs(ws, environment(base)), () => {})).toBe('none');
        expect(await readFile(path.join(outside, 'session', 'session.db'), 'utf8')).toBe('x');
    });

    test('refused while a server of an older version runs on it (its server.json names a live process)', async () => {
        const base = await scratch();
        const { ws, legacy } = await legacyWorkspace(base);
        await writeFile(path.join(legacy, 'session', 'server.json'), JSON.stringify({ url: 'http://127.0.0.1:1/', session: 's', pid: process.ppid }));
        const e = await openWorkspaceState(ws, { environment: environment(base) }).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(StateDirError);
        expect(String(e)).toContain(`A session server of an older dt (pid ${process.ppid}) runs on this workspace`);
        expect(await exists(path.join(legacy, 'session', 'session.db'))).toBe(true);
        expect(await exists(workspaceDirs(ws, environment(base)).state)).toBe(false);
    });

    test('a state directory that holds a session already is never overwritten: .domaintrail/ is kept, and that is said', async () => {
        const base = await scratch();
        const { ws, legacy } = await legacyWorkspace(base);
        const d = workspaceDirs(ws, environment(base));
        await mkdir(d.state, { recursive: true });
        await writeFile(path.join(d.state, 'workspace.json'), JSON.stringify({ version: 1, path: ws }));
        await writeFile(path.join(d.state, 'session.db'), 'newer');
        const lines: string[] = [];
        await openWorkspaceState(ws, { environment: environment(base), log: (l) => lines.push(l) });
        expect(lines).toEqual([`Kept .domaintrail/ as it is: ${d.state} already holds this workspace's files (remove one of them to choose).`]);
        expect(await readFile(path.join(d.state, 'session.db'), 'utf8')).toBe('newer');
        expect(await exists(path.join(legacy, 'session', 'session.db'))).toBe(true);
    });

    test('a state directory with its record only gives way', async () => {
        const base = await scratch();
        const { ws } = await legacyWorkspace(base);
        const d = workspaceDirs(ws, environment(base));
        await mkdir(d.state, { recursive: true });
        await writeFile(path.join(d.state, 'workspace.json'), JSON.stringify({ version: 1, path: ws }));
        await openWorkspaceState(ws, { environment: environment(base) });
        expect(rows(d.state)).toEqual(['hello', 'again']);
    });

    test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
        'a run that fails half way leaves .domaintrail/ whole and no copy; the next run moves it',
        async () => {
            const base = await scratch();
            const { ws, legacy } = await legacyWorkspace(base);
            const d = workspaceDirs(ws, environment(base));
            // the copy of the manifest fails: nothing is in place, nothing is deleted
            await chmod(path.join(legacy, 'generated.json'), 0o000);
            expect(await openWorkspaceState(ws, { environment: environment(base) }).catch((x: unknown) => x)).toBeInstanceOf(Error);
            expect(await exists(d.state)).toBe(false);
            expect((await readdir(d.roots.state)).filter((n) => n.includes('.moving-'))).toEqual([]);
            expect(await exists(path.join(legacy, 'session', 'session.db-wal'))).toBe(true);
            await chmod(path.join(legacy, 'generated.json'), 0o600);
            await openWorkspaceState(ws, { environment: environment(base) });
            expect(rows(d.state)).toEqual(['hello', 'again']);
            expect(await exists(legacy)).toBe(false);
        },
    );

    test('a copy left by a run that was killed half way is removed, and the move done again', async () => {
        const base = await scratch();
        const { ws, legacy } = await legacyWorkspace(base);
        const d = workspaceDirs(ws, environment(base));
        const leftover = path.join(d.roots.state, `.${d.name}.moving-${deadPid()}-0badc0de`);
        await mkdir(leftover, { recursive: true });
        await writeFile(path.join(leftover, 'session.db'), 'half');
        await openWorkspaceState(ws, { environment: environment(base) });
        expect(await exists(leftover)).toBe(false);
        expect(rows(d.state)).toEqual(['hello', 'again']);
        expect(await exists(legacy)).toBe(false);
    });

    test('a run killed after the move, before deleting .domaintrail/: the next run recognizes the copies and deletes it', async () => {
        const base = await scratch();
        const { ws, legacy } = await legacyWorkspace(base);
        const saved = path.join(base, 'saved');
        await cp(legacy, saved, { recursive: true });
        const d = await openWorkspaceState(ws, { environment: environment(base) });
        // what the killed run left: both copies (and part of .domaintrail/ already deleted)
        await cp(saved, legacy, { recursive: true });
        await rm(path.join(legacy, 'layout.json'));
        const lines: string[] = [];
        await openWorkspaceState(ws, { environment: environment(base), log: (l) => lines.push(l) });
        expect(lines).toEqual([]);
        expect(await exists(legacy)).toBe(false);
        expect(rows(d.state)).toEqual(['hello', 'again']);
        // but copies that differ (the session went on since) are another session: kept, and said
        await cp(saved, legacy, { recursive: true });
        await writeFile(path.join(d.state, 'generated.json'), '{"version":1,"files":[]}');
        await openWorkspaceState(ws, { environment: environment(base), log: (l) => lines.push(l) });
        expect(lines.at(-1)).toContain('Kept .domaintrail/ as it is');
        expect(await exists(path.join(legacy, 'session', 'session.db'))).toBe(true);
    });

    test('files that are not dt’s, and links, are neither moved nor deleted, nor followed: .domaintrail/ is kept with them', async () => {
        const base = await scratch();
        const { ws, legacy } = await legacyWorkspace(base);
        const outside = path.join(base, 'outside');
        await mkdir(outside);
        await writeFile(path.join(outside, 'victim.json'), 'keep');
        await writeFile(path.join(legacy, 'notes.txt'), 'mine');
        await rm(path.join(legacy, 'generated.json'));
        await symlink(path.join(outside, 'victim.json'), path.join(legacy, 'generated.json'));
        const lines: string[] = [];
        const d = await openWorkspaceState(ws, { environment: environment(base), log: (l) => lines.push(l) });
        expect(lines).toContain(`Kept .domaintrail/: it holds files that are not dt's (generated.json, notes.txt).`);
        expect(rows(d.state)).toEqual(['hello', 'again']);
        expect(await exists(path.join(d.state, 'generated.json'))).toBe(false);
        expect((await readdir(legacy)).sort()).toEqual(['generated.json', 'notes.txt']);
        expect(await readFile(path.join(outside, 'victim.json'), 'utf8')).toBe('keep');
    });

    test('a .domaintrail/ with nothing to keep (an older dt view’s ignore file) is removed, and that is said', async () => {
        const base = await scratch();
        const ws = path.join(base, 'shop');
        await mkdir(path.join(ws, '.domaintrail'), { recursive: true });
        await writeFile(path.join(ws, '.domaintrail', '.gitignore'), '*\n');
        const lines: string[] = [];
        await openWorkspaceState(ws, { environment: environment(base), log: (l) => lines.push(l) });
        expect(lines).toEqual(['Removed .domaintrail/ (nothing in it to keep).']);
        expect(await readdir(ws)).toEqual([]);
    });
});
