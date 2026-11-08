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
/** The app's cleaning of a moved database stands in here (the collaboration's is tested with its schema): accepted. */
const cleanDatabase = (): boolean => true;
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
    await chmod(legacy, 0o755);
    await chmod(session, 0o755);
    db.close();
    const blob = 'context Sales {}\n';
    await mkdir(path.join(session, 'blobs', sha(blob).slice(0, 2)), { recursive: true });
    await writeFile(path.join(session, 'blobs', sha(blob).slice(0, 2), sha(blob)), blob, { mode: 0o644 });
    for (const d of [path.join(session, 'blobs'), path.join(session, 'blobs', sha(blob).slice(0, 2))]) await chmod(d, 0o755);
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
            const d = await openWorkspaceState(ws, { cleanDatabase, environment: environment(base), log: (l) => lines.push(l) });
            expect(lines).toEqual([`Moved .domaintrail/ to ${d.state}${path.sep}`]);
            expect(await exists(legacy)).toBe(false);
            expect(rows(d.state)).toEqual(['hello', 'again']);
            const blobFile = path.join(d.state, 'blobs', sha(blob).slice(0, 2), sha(blob));
            expect(await readFile(blobFile, 'utf8')).toBe(blob);
            expect(await readFile(path.join(d.cache, 'layout.json'), 'utf8')).toBe('{"version":1}');
            // a stopped server's address, an old credential, the ignore files and the record of dt generate ts are not
            // kept (the WAL files, checkpointed when the credentials were cleaned, may be left empty)
            expect((await readdir(d.state)).filter((n) => !/-(wal|shm)$/.test(n)).sort()).toEqual(['blobs', 'session.db', 'workspace.json']);
            for (const p of [d.state, path.join(d.state, 'blobs'), path.dirname(blobFile)]) expect(await modeOf(p)).toBe(0o700);
            for (const p of ['session.db', 'workspace.json']) expect(await modeOf(path.join(d.state, p))).toBe(0o600);
            expect(await modeOf(blobFile)).toBe(0o600);
            const record = JSON.parse(await readFile(path.join(d.state, 'workspace.json'), 'utf8'));
            expect(record).toMatchObject({ version: 1, path: ws, movedFrom: legacy });
            expect(Object.keys(record.moved).sort()).toEqual([
                `session/blobs/${sha(blob).slice(0, 2)}/${sha(blob)}`,
                'session/session.db',
                'session/session.db-shm',
                'session/session.db-wal',
            ]);
            expect(await readdir(ws)).toEqual([]);

            // already moved: nothing to do, nothing said
            lines.length = 0;
            await openWorkspaceState(ws, { cleanDatabase, environment: environment(base), log: (l) => lines.push(l) });
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
        const e = await openWorkspaceState(ws, { cleanDatabase, environment: environment(base) }).catch((x: unknown) => x);
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
        await openWorkspaceState(ws, { cleanDatabase, environment: environment(base), log: (l) => lines.push(l) });
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
        await openWorkspaceState(ws, { cleanDatabase, environment: environment(base) });
        expect(rows(d.state)).toEqual(['hello', 'again']);
    });

    test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
        'a run that fails half way leaves .domaintrail/ whole and no copy; the next run moves it',
        async () => {
            const base = await scratch();
            const { ws, legacy } = await legacyWorkspace(base);
            const d = workspaceDirs(ws, environment(base));
            // the copy of a blob fails: nothing is in place, nothing is deleted
            const blobDir = path.join(legacy, 'session', 'blobs');
            const [sub] = await readdir(blobDir);
            const [blobName] = await readdir(path.join(blobDir, sub));
            await chmod(path.join(blobDir, sub, blobName), 0o000);
            expect(await openWorkspaceState(ws, { cleanDatabase, environment: environment(base) }).catch((x: unknown) => x)).toBeInstanceOf(Error);
            expect(await exists(d.state)).toBe(false);
            expect((await readdir(d.roots.state)).filter((n) => n.includes('.moving-'))).toEqual([]);
            expect(await exists(path.join(legacy, 'session', 'session.db-wal'))).toBe(true);
            await chmod(path.join(blobDir, sub, blobName), 0o600);
            await openWorkspaceState(ws, { cleanDatabase, environment: environment(base) });
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
        await openWorkspaceState(ws, { cleanDatabase, environment: environment(base) });
        expect(await exists(leftover)).toBe(false);
        expect(rows(d.state)).toEqual(['hello', 'again']);
        expect(await exists(legacy)).toBe(false);
    });

    test('a run killed after the move, before deleting .domaintrail/: the next run recognizes the copies and deletes it', async () => {
        const base = await scratch();
        const { ws, legacy } = await legacyWorkspace(base);
        const saved = path.join(base, 'saved');
        await cp(legacy, saved, { recursive: true });
        const d = await openWorkspaceState(ws, { cleanDatabase, environment: environment(base) });
        // what the killed run left: both copies (and part of .domaintrail/ already deleted)
        await cp(saved, legacy, { recursive: true });
        await rm(path.join(legacy, 'layout.json'));
        const lines: string[] = [];
        await openWorkspaceState(ws, { cleanDatabase, environment: environment(base), log: (l) => lines.push(l) });
        expect(lines).toEqual([]);
        expect(await exists(legacy)).toBe(false);
        expect(rows(d.state)).toEqual(['hello', 'again']);
        // but a .domaintrail/ other than the one moved (another blob) is another session: kept, and said
        await cp(saved, legacy, { recursive: true });
        const blobs = path.join(legacy, 'session', 'blobs');
        const [sub] = await readdir(blobs);
        const [name] = await readdir(path.join(blobs, sub));
        await writeFile(path.join(blobs, sub, name), 'another');
        await openWorkspaceState(ws, { cleanDatabase, environment: environment(base), log: (l) => lines.push(l) });
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
        await symlink(path.join(outside, 'victim.json'), path.join(legacy, 'seed.json'));
        const lines: string[] = [];
        const d = await openWorkspaceState(ws, { cleanDatabase, environment: environment(base), log: (l) => lines.push(l) });
        expect(lines).toContain(`Kept .domaintrail/: it holds files that are not dt's (notes.txt, seed.json).`);
        expect(rows(d.state)).toEqual(['hello', 'again']);
        expect(await exists(path.join(d.state, 'seed.json'))).toBe(false);
        expect((await readdir(legacy)).sort()).toEqual(['notes.txt', 'seed.json']);
        expect(await readFile(path.join(outside, 'victim.json'), 'utf8')).toBe('keep');
    });

    test('a .domaintrail/ with nothing to keep (an older dt view’s ignore file) is removed, and that is said', async () => {
        const base = await scratch();
        const ws = path.join(base, 'shop');
        await mkdir(path.join(ws, '.domaintrail'), { recursive: true });
        await writeFile(path.join(ws, '.domaintrail', '.gitignore'), '*\n');
        const lines: string[] = [];
        await openWorkspaceState(ws, { cleanDatabase, environment: environment(base), log: (l) => lines.push(l) });
        expect(lines).toEqual(['Removed .domaintrail/ (nothing in it to keep).']);
        expect(await readdir(ws)).toEqual([]);
    });

    test('a .domaintrail/ that git tracks, or does not ignore, is not moved: left as it is, a new session started, and said', async () => {
        const base = await scratch();
        const { ws, legacy } = await legacyWorkspace(base);
        const git = (...args: string[]): void => {
            const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: ws });
            expect(r.status).toBe(0);
        };
        git('init', '-q');
        // not ignored: no .gitignore makes it so (dt's own is removed)
        await rm(path.join(legacy, '.gitignore'));
        const lines: string[] = [];
        const d = await openWorkspaceState(ws, { cleanDatabase, environment: environment(base), log: (l) => lines.push(l) });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toStartWith('Not moving .domaintrail/: git tracks or does not ignore ');
        expect(lines[0]).toContain('this workspace starts a new session');
        expect(await exists(path.join(legacy, 'session', 'session.db'))).toBe(true);
        expect(await readdir(d.state)).toEqual(['workspace.json']);
        // tracked, though ignored now
        await writeFile(path.join(legacy, '.gitignore'), '*\n');
        git('add', '-f', '.domaintrail/session/session.db');
        lines.length = 0;
        await openWorkspaceState(ws, { cleanDatabase, environment: environment(base), log: (l) => lines.push(l) });
        expect(lines[0]).toContain('.domaintrail/session/session.db');
        expect(lines[0]).toContain('git rm -r --cached .domaintrail');
        // ignored by dt's own .gitignore and tracked by nothing: moved
        git('rm', '-q', '--cached', '.domaintrail/session/session.db');
        lines.length = 0;
        await openWorkspaceState(ws, { cleanDatabase, environment: environment(base), log: (l) => lines.push(l) });
        expect(lines).toEqual([`Moved .domaintrail/ to ${d.state}${path.sep}`]);
        expect(rows(d.state)).toEqual(['hello', 'again']);
    });

    test.skipIf(process.platform === 'win32')(
        'files in a directory others can write are not moved (the database with its WAL files all or none), and said',
        async () => {
            const base = await scratch();
            const { ws, legacy, blob } = await legacyWorkspace(base);
            const blobDir = path.join(legacy, 'session', 'blobs', sha(blob).slice(0, 2));
            await chmod(blobDir, 0o777);
            const lines: string[] = [];
            const d = await openWorkspaceState(ws, { cleanDatabase, environment: environment(base), log: (l) => lines.push(l) });
            expect(lines).toContain(
                `Not moving 1 file(s) of .domaintrail/ (not a plain file of yours, or in a directory others can write): session/blobs/${sha(blob).slice(0, 2)}/${sha(blob)}. They stay there.`,
            );
            expect(rows(d.state)).toEqual(['hello', 'again']);
            expect(await exists(path.join(blobDir, sha(blob)))).toBe(true);
            // the session's directory writable by the group: nothing of it moves, the layouts do
            const other = await scratch();
            const second = await legacyWorkspace(other);
            await chmod(path.join(second.legacy, 'session'), 0o775);
            const said: string[] = [];
            const d2 = await openWorkspaceState(second.ws, { cleanDatabase, environment: environment(other), log: (l) => said.push(l) });
            expect(said[0]).toStartWith('Not moving 4 file(s) of .domaintrail/');
            expect(await exists(path.join(d2.state, 'session.db'))).toBe(false);
            expect(await readFile(path.join(d2.cache, 'layout.json'), 'utf8')).toBe('{"version":1}');
            expect(await exists(path.join(second.legacy, 'session', 'session.db'))).toBe(true);
        },
    );

    test('the moved database is cleaned (the app checks and cleans it) in the copy, before it is in place', async () => {
        const base = await scratch();
        const { ws, legacy } = await legacyWorkspace(base);
        const cleaned: { file: string; rows: unknown[] }[] = [];
        const clean = (file: string): boolean => {
            const db = new DatabaseSync(file);
            try {
                cleaned.push({
                    file,
                    rows: db
                        .prepare('SELECT text FROM requests')
                        .all()
                        .map((r) => r.text),
                });
                db.exec("DELETE FROM requests WHERE text = 'again'");
            } finally {
                db.close();
            }
            return true;
        };
        const d = await openWorkspaceState(ws, { cleanDatabase: clean, environment: environment(base) });
        expect(cleaned).toHaveLength(1);
        expect(path.basename(path.dirname(cleaned[0].file))).toStartWith(`.${d.name}.moving-`);
        // the WAL was there beside it
        expect(cleaned[0].rows).toEqual(['hello', 'again']);
        expect(rows(d.state)).toEqual(['hello']);
        expect(await exists(legacy)).toBe(false);
    });

    test('a database the app refuses (not one dt made), or with no app to check it, is not moved, and said; the rest is', async () => {
        for (const clean of [(): boolean => false, undefined]) {
            const base = await scratch();
            const { ws, legacy, blob } = await legacyWorkspace(base);
            const file = path.join(legacy, 'session', 'session.db');
            const lines: string[] = [];
            const d = await openWorkspaceState(ws, { ...(clean && { cleanDatabase: clean }), environment: environment(base), log: (l) => lines.push(l) });
            expect(lines).toContain(
                "Not moving .domaintrail/session/session.db: it is not a session database of dt's (its schema is not one dt made), or it could not be cleaned of its credentials. It stays there.",
            );
            expect((await readdir(d.state)).filter((n) => n.startsWith('session.db'))).toEqual([]);
            expect(await readFile(path.join(d.state, 'blobs', sha(blob).slice(0, 2), sha(blob)), 'utf8')).toBe(blob);
            for (const f of [file, `${file}-wal`, `${file}-shm`]) expect(await exists(f)).toBe(true);
        }
    });

    test('a directory named .domaintrail in another case is not dt’s: never moved', async () => {
        const base = await scratch();
        const ws = path.join(base, 'shop');
        const variant = path.join(ws, '.DomainTrail', 'session');
        await mkdir(variant, { recursive: true });
        await writeFile(path.join(variant, 'session.db'), 'x');
        const lines: string[] = [];
        const d = await openWorkspaceState(ws, { cleanDatabase, environment: environment(base), log: (l) => lines.push(l) });
        expect(await readFile(path.join(variant, 'session.db'), 'utf8')).toBe('x');
        expect(await readdir(d.state)).toEqual(['workspace.json']);
        // said where the file system answers to both names (macOS, Windows)
        if (await exists(path.join(ws, '.domaintrail')))
            expect(lines).toEqual(['Not moving .DomainTrail/: dt only ever wrote .domaintrail/, by that exact name. It stays as it is.']);
    });

    test('generated.json (it says what dt generate ts deletes) is never moved: the next run records its own', async () => {
        const base = await scratch();
        const { ws, legacy } = await legacyWorkspace(base);
        const d = await openWorkspaceState(ws, { cleanDatabase, environment: environment(base) });
        expect(await exists(path.join(d.state, 'generated.json'))).toBe(false);
        expect(await exists(path.join(legacy, 'generated.json'))).toBe(false);
    });
});
