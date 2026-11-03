// The session's persistence (ADR 0026): node:sqlite schema and migrations, transactions with the outbox, the run
// queue's claim, lease and serial rule, the session directory and its blobs, never through a symbolic link.
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Collaboration as C } from '../generated/index.js';
import type { Stores } from '../application/ports.js';
import { agentRunCommands, sessionCommands } from '../domain/commands.js';
import { createFileBlobs, openSessionBlobs } from './blobs.js';
import { writeServerAddress } from './session-files.js';
import { UnsafeSessionPath } from './session-dir.js';
import {
    CREDENTIAL_TABLES,
    MIGRATIONS,
    NewerSchema,
    cleanMovedDatabase,
    createUnitOfWork,
    decodeJson,
    encodeJson,
    openDatabase,
    openSessionDatabase,
} from './sqlite.js';
import { knownAgentRunId, knownInterviewId, knownRequestId, knownRevisionId, knownSessionId } from '../domain/ids.js';

/** The error a promise rejects with (fails when it resolves). */
async function thrown(p: Promise<unknown>): Promise<Error> {
    const e = await p.then(
        () => undefined,
        (x: unknown) => x,
    );
    if (!(e instanceof Error)) throw new Error('expected a rejection with an Error');
    return e;
}
/** What `thrown`'s error must be: an instance of a class, or have a message matching. */
const errorLike = (what: string | RegExp | (new (message?: string) => Error)): object =>
    typeof what === 'function' ? expect.any(what) : { message: typeof what === 'string' ? expect.stringContaining(what) : expect.stringMatching(what) };

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-session-'));
    dirs.push(dir);
    return dir;
}

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
    return r.value;
};
const at = new Date('2026-10-31T09:00:00Z');
const plus = (ms: number): Date => new Date(at.getTime() + ms);
const facilitator = value(C.makeParticipantId('facilitator'));
const sessionId = knownSessionId('00000000-0000-4000-8000-000000000001');
const otherSession = knownSessionId('00000000-0000-4000-8000-000000000002');
const request = knownRequestId('00000000-0000-4000-8000-000000000010');
const revision = knownRevisionId('00000000-0000-4000-8000-000000000020');

function openSession(stores: Stores, id: C.SessionId): void {
    const { Open } = value(sessionCommands.start({ id, facilitator, name: value(C.makeDisplayName('Ada')), mode: 'Collab', startedAt: at }));
    stores.sessions.save(Open.aggregate);
    stores.outbox.append(id, [Open.events.SessionStarted], at);
}

function queued(id: number, session: C.SessionId = sessionId): C.QueuedAgentRun {
    return {
        state: 'Queued',
        id: knownAgentRunId(`00000000-0000-4000-8000-0000000001${String(id).padStart(2, '0')}`),
        session,
        input: {
            requests: [{ request, author: facilitator, targets: [], body: value(C.makeText('x')) }],
        },
        queuedBy: facilitator,
        queuedAt: at,
    };
}

function sendRequest(stores: Stores, session: C.SessionId = sessionId): void {
    stores.requests.save({
        state: 'Sent',
        id: request,
        session,
        author: facilitator,
        targets: [],
        body: value(C.makeText('x')),
        sentAt: at,
        mentions: [],
    });
}

const lease = (token: string, ms = 1000) => ({ owner: 'subscriber', token, expiresAt: plus(ms) });

describe('schema and transactions', () => {
    test('a new database gets every migration; a newer one is refused', async () => {
        const dir = await tempDir();
        const file = path.join(dir, 'x.db');
        const db = openDatabase(file);
        expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .all()
            .map((r) => r.name);
        expect(tables).toEqual([
            'agent_runs',
            'approvals',
            'facilitator_links',
            'facilitators',
            'interviews',
            'invites',
            'marks',
            'outbox',
            'proposals',
            'requests',
            'restore_operations',
            'revisions',
            'run_requests',
            'sessions',
            'sign_ins',
            'slash_commands',
            'triages',
        ]);
        db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
        db.close();
        expect(() => openDatabase(file)).toThrow(NewerSchema);
    });

    test('aggregates and events keep their dates through JSON', () => {
        expect(decodeJson(encodeJson({ a: at, b: [at], c: { $date: 1 }, d: 'x' }))).toEqual({ a: at, b: [at], c: { $date: 1 }, d: 'x' });
    });

    test('the outbox is written in the transaction of the aggregates: a failure rolls both back', async () => {
        const uow = createUnitOfWork(openDatabase(':memory:'));
        expect(
            await thrown(
                uow.transaction((stores) => {
                    openSession(stores, sessionId);
                    throw new Error('boom');
                }),
            ),
        ).toMatchObject(errorLike('boom'));
        expect(await uow.transaction((s) => [s.sessions.load(sessionId), s.outbox.readAfter(0, 10)])).toEqual([undefined, []]);
        await uow.transaction((s) => openSession(s, sessionId));
        const [entry] = await uow.transaction((s) => s.outbox.readAfter(0, 10));
        expect(entry).toMatchObject({ session: sessionId, event: { type: 'SessionStarted', startedAt: at } });
        expect(await uow.transaction((s) => s.outbox.readAfter(entry.seq, 10))).toEqual([]);
    });

    test('transactions run one at a time, in order, even when their work waits', async () => {
        const uow = createUnitOfWork(openDatabase(':memory:'));
        const order: string[] = [];
        await Promise.all([
            uow.transaction(async (s) => {
                order.push('a:start');
                await new Promise((r) => setTimeout(r, 10));
                openSession(s, sessionId);
                order.push('a:end');
            }),
            uow.transaction((s) => {
                order.push(`b:${s.sessions.load(sessionId) ? 'sees a' : 'sees nothing'}`);
            }),
        ]);
        expect(order).toEqual(['a:start', 'a:end', 'b:sees a']);
    });

    test('the outbox reads after a cursor, per session', async () => {
        const uow = createUnitOfWork(openDatabase(':memory:'));
        await uow.transaction((s) => {
            openSession(s, sessionId);
            openSession(s, otherSession);
        });
        const all = await uow.transaction((s) => s.outbox.readAfter(0, 10));
        expect(all.map((e) => e.session)).toEqual([sessionId, otherSession]);
        expect((await uow.transaction((s) => s.outbox.readAfter(0, 10, otherSession))).map((e) => e.seq)).toEqual([all[1].seq]);
        expect(await uow.transaction((s) => s.outbox.readAfter(0, 1))).toHaveLength(1);
    });
});

describe('the run queue', () => {
    async function queue(): Promise<{ db: DatabaseSync; uow: ReturnType<typeof createUnitOfWork>; runs: C.QueuedAgentRun[] }> {
        const db = openDatabase(':memory:');
        const uow = createUnitOfWork(db);
        const runs = [queued(1), queued(2)];
        await uow.transaction((s) => {
            openSession(s, sessionId);
            sendRequest(s);
            for (const r of runs) s.runs.enqueue(r);
        });
        return { db, uow, runs };
    }

    test('a claim takes the first queued run, once: a second claim waits while the first lease lives', async () => {
        const { db, uow, runs } = await queue();
        expect(await uow.transaction((s) => s.runs.claimNext(sessionId, lease('t1'), at))).toBe(runs[0].id);
        expect(await uow.transaction((s) => s.runs.claimNext(sessionId, lease('t2'), plus(10)))).toBeUndefined();
        expect((await uow.transaction((s) => s.runs.active(sessionId, plus(10))))?.lease).toEqual(lease('t1'));
        // the requests a run bundles are rows of their own
        expect(
            db
                .prepare('SELECT run_id FROM run_requests ORDER BY run_id')
                .all()
                .map((r) => r.run_id),
        ).toEqual([runs[0].id, runs[1].id]);
    });

    test('heartbeats extend a live lease only; a released claim goes back to the queue', async () => {
        const { uow, runs } = await queue();
        await uow.transaction((s) => s.runs.claimNext(sessionId, lease('t1'), at));
        expect(await uow.transaction((s) => s.runs.extend(runs[0].id, 't1', plus(500), plus(5000)))).toBe(true);
        expect(await uow.transaction((s) => s.runs.extend(runs[0].id, 'other', plus(500), plus(5000)))).toBe(false);
        expect(await uow.transaction((s) => s.runs.extend(runs[0].id, 't1', plus(6000), plus(9000)))).toBe(false);
        expect(await uow.transaction((s) => s.runs.release(runs[0].id, 'other'))).toBe(false);
        expect(await uow.transaction((s) => s.runs.release(runs[0].id, 't1'))).toBe(true);
        expect(await uow.transaction((s) => s.runs.claimNext(sessionId, lease('t2', 6000), plus(10)))).toBe(runs[0].id);
    });

    test('an expired claim of a queued run is dropped by the next claim', async () => {
        const { uow, runs } = await queue();
        await uow.transaction((s) => s.runs.claimNext(sessionId, lease('t1', 100), at));
        expect((await uow.transaction((s) => s.runs.expired(plus(100)))).map((r) => r.run.id)).toEqual([runs[0].id]);
        expect(await uow.transaction((s) => s.runs.claimNext(sessionId, { owner: 'b', token: 't2', expiresAt: plus(1000) }, plus(200)))).toBe(runs[0].id);
    });

    test('serial: a running run blocks claims, and the store refuses a second running run or lease of a session', async () => {
        const { uow, runs } = await queue();
        await uow.transaction((s) => s.runs.claimNext(sessionId, lease('t1'), at));
        const running = value(agentRunCommands.start(runs[0], { baseRevision: revision, startedAt: at })).Running.aggregate;
        await uow.transaction((s) => {
            s.runs.save(running);
            s.runs.endLease(running.id, 'done');
        });
        // no lease left, but a running run: no claim
        expect(await uow.transaction((s) => s.runs.claimNext(sessionId, lease('t2'), at))).toBeUndefined();
        expect((await uow.transaction((s) => s.runs.active(sessionId, at)))?.run.id).toBe(running.id);
        const second = value(agentRunCommands.start(runs[1], { baseRevision: revision, startedAt: at })).Running.aggregate;
        expect(await thrown(uow.transaction((s) => s.runs.save(second)))).toMatchObject(errorLike(/UNIQUE/));
        expect((await uow.transaction((s) => s.runs.load(runs[1].id)))?.run.state).toBe('Queued');
    });

    test('ending a lease records the token it ended with', async () => {
        const { uow, runs } = await queue();
        await uow.transaction((s) => s.runs.claimNext(sessionId, lease('t1'), at));
        await uow.transaction((s) => s.runs.endLease(runs[0].id, 't1'));
        expect(await uow.transaction((s) => s.runs.load(runs[0].id))).toEqual({ run: runs[0], lease: undefined, completedWith: 't1' });
        expect(await thrown(uow.transaction((s) => s.runs.save(queued(9))))).toMatchObject(errorLike('never queued'));
    });
});

describe('the session directory and blobs', () => {
    test('the database is session.db in the session directory given (made if absent, its parent must exist)', async () => {
        const dir = path.join(await tempDir(), 'shop-01234567');
        const db = await openSessionDatabase(dir);
        db.close();
        expect((await lstat(path.join(dir, 'session.db'))).isFile()).toBe(true);
        expect(await thrown(openSessionDatabase(path.join(await tempDir(), 'missing', 'shop-01234567')))).toMatchObject(errorLike(/ENOENT/));
    });

    test('nothing is written through a symbolic link', async () => {
        const outside = await tempDir();
        const linkedDir = path.join(await tempDir(), 'shop-01234567');
        await symlink(outside, linkedDir);
        expect(await thrown(openSessionDatabase(linkedDir))).toMatchObject(errorLike(UnsafeSessionPath));

        const linkedDb = await tempDir();
        await symlink(path.join(outside, 'x.db'), path.join(linkedDb, 'session.db'));
        expect(await thrown(openSessionDatabase(linkedDb))).toMatchObject(errorLike(UnsafeSessionPath));

        const linkedWal = await tempDir();
        await symlink(path.join(outside, 'x.db-wal'), path.join(linkedWal, 'session.db-wal'));
        expect(await thrown(openSessionDatabase(linkedWal))).toMatchObject(errorLike(UnsafeSessionPath));

        const linkedBlobs = await tempDir();
        await symlink(outside, path.join(linkedBlobs, 'blobs'));
        const blobs = await openSessionBlobs(linkedBlobs);
        const bytes = new TextEncoder().encode('context A {}');
        expect(await thrown(blobs.put([{ hash: createHash('sha256').update(bytes).digest('hex'), bytes }]))).toMatchObject(errorLike(UnsafeSessionPath));

        const linkedServer = await tempDir();
        await symlink(path.join(outside, 'victim.json'), path.join(linkedServer, 'server.json'));
        expect(await thrown(writeServerAddress(linkedServer, { url: 'http://127.0.0.1:1', session: 's', pid: process.pid }))).toMatchObject(
            errorLike(UnsafeSessionPath),
        );
        expect(await readdir(outside)).toEqual([]);
    });

    test('blobs are stored once by content hash, and read back only with that content', async () => {
        const dir = path.join(await tempDir(), 'blobs');
        const blobs = createFileBlobs(dir);
        const bytes = new TextEncoder().encode('storming A {}');
        const hash = createHash('sha256').update(bytes).digest('hex');
        await blobs.put([
            { hash, bytes },
            { hash, bytes },
        ]);
        expect(await blobs.get(hash)).toEqual(bytes);
        expect(await blobs.get('0'.repeat(64))).toBeUndefined();
        expect(await thrown(blobs.put([{ hash: '0'.repeat(64), bytes }]))).toMatchObject(errorLike('another hash'));
        expect(await thrown(blobs.get('../x'))).toMatchObject(errorLike('Not a SHA-256'));
        await writeFile(path.join(dir, hash.slice(0, 2), hash), 'tampered');
        expect(await blobs.get(hash)).toBeUndefined();
    });
});

/** The permission bits of `p` (not following a link). */
const modeOf = async (p: string): Promise<number> => (await lstat(p)).mode & 0o777;

describe('the session is private to the user', () => {
    const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

    test.skipIf(process.platform === 'win32')('its directories are 0700 and its files 0600, whatever the umask', async () => {
        const session = path.join(await tempDir(), 'shop-01234567');
        const umask = process.umask(0o000);
        try {
            const db = await openSessionDatabase(session);
            db.exec('CREATE TABLE IF NOT EXISTS probe (x)');
            const blobs = await openSessionBlobs(session);
            const bytes = new TextEncoder().encode('context A {}');
            await blobs.put([{ hash: sha(bytes), bytes }]);
            await writeServerAddress(session, { url: 'http://127.0.0.1:1', session: 's', pid: process.pid });
            const blobDir = path.join(session, 'blobs', sha(bytes).slice(0, 2));
            for (const dir of [session, path.join(session, 'blobs'), blobDir]) expect({ dir, mode: await modeOf(dir) }).toEqual({ dir, mode: 0o700 });
            const files = [
                path.join(session, 'session.db'),
                path.join(session, 'session.db-wal'),
                path.join(session, 'session.db-shm'),
                path.join(session, 'server.json'),
                path.join(blobDir, sha(bytes)),
            ];
            for (const file of files) expect({ file, mode: await modeOf(file) }).toEqual({ file, mode: 0o600 });
            db.close();
        } finally {
            process.umask(umask);
        }
    });

    test.skipIf(process.platform === 'win32')('directories and files an older version left readable by others are tightened when opened', async () => {
        const session = await tempDir();
        const old = await openSessionDatabase(session);
        const blobs = await openSessionBlobs(session);
        const bytes = new TextEncoder().encode('context B {}');
        await blobs.put([{ hash: sha(bytes), bytes }]);
        old.close();
        const blobDir = path.join(session, 'blobs', sha(bytes).slice(0, 2));
        const dirs = [session, path.join(session, 'blobs'), blobDir];
        const files = [path.join(session, 'session.db'), path.join(blobDir, sha(bytes))];
        for (const dir of dirs) await chmod(dir, 0o755);
        for (const file of files) await chmod(file, 0o644);

        const db = await openSessionDatabase(session);
        await openSessionBlobs(session);
        db.close();
        for (const dir of dirs) expect({ dir, mode: await modeOf(dir) }).toEqual({ dir, mode: 0o700 });
        for (const file of files) expect({ file, mode: await modeOf(file) }).toEqual({ file, mode: 0o600 });
    });
});

describe('rows written before requests had several targets', () => {
    // a request, a run's frozen request and the RequestSent event held one `target` (0.6.0): read as a list, nothing rewritten
    test('are read as a list of targets: none for the whole workspace, else that one', async () => {
        const fixture = JSON.parse(await readFile(path.join(import.meta.dir, '..', '..', 'test-fixtures', 'session', 'legacy-rows.json'), 'utf8')) as {
            session: { id: string; state: string; data: unknown };
            requests: { id: string; state: string; data: unknown }[];
            runs: { id: string; state: string; data: unknown }[];
            outbox: { type: string; payload: unknown }[];
        };
        const db = openDatabase(':memory:');
        const raw = (o: unknown): string => JSON.stringify(o);
        db.prepare('INSERT INTO sessions (id, state, data) VALUES (?, ?, ?)').run(fixture.session.id, fixture.session.state, raw(fixture.session.data));
        fixture.requests.forEach((r, i) =>
            db
                .prepare('INSERT INTO requests (id, session_id, seq, state, data) VALUES (?, ?, ?, ?, ?)')
                .run(r.id, fixture.session.id, i + 1, r.state, raw(r.data)),
        );
        for (const r of fixture.runs)
            db.prepare('INSERT INTO agent_runs (id, session_id, seq, state, data) VALUES (?, ?, 1, ?, ?)').run(r.id, fixture.session.id, r.state, raw(r.data));
        for (const e of fixture.outbox)
            db.prepare('INSERT INTO outbox (session_id, type, payload, recorded_at) VALUES (?, ?, ?, ?)').run(
                fixture.session.id,
                e.type,
                raw(e.payload),
                at.toISOString(),
            );
        const stored = JSON.stringify(db.prepare('SELECT data FROM requests').all());
        const uow = createUnitOfWork(db);
        const session = knownSessionId(fixture.session.id);
        const element: unknown = {
            target: { kind: 'DtElement', element: 'Billing.Invoice' },
            sourceRevision: revision,
            label: '請求書 (Billing.Invoice)',
            range: { path: 'billing/invoice.dt', startLine: 6, startColumn: 1, endLine: 25, endColumn: 3 },
        };
        const { requests, runs, events } = await uow.transaction((st) => ({
            requests: st.requests.listBySession(session),
            runs: st.runs.listBySession(session),
            events: st.outbox.readAfter(0, 10, session),
        }));
        // compared as plain data: the fixture's JSON
        const plain = (v: unknown): unknown => v;
        expect(plain(requests.map((r) => [r.state, r.targets]))).toEqual([
            ['Sent', []],
            ['Dismissed', [element]],
        ]);
        expect(requests.every((r) => !('target' in r) && C.checkRequest(r).length === 0)).toBe(true);
        expect(requests[1].sentAt).toEqual(new Date('2026-10-31T11:48:36.979Z'));
        expect(plain(runs[0].input.requests.map((r) => r.targets))).toEqual([[], [element]]);
        expect(plain(runs[0].input.note)).toBe('税込で固定');
        expect(plain(events.map((e) => (e.event.type === 'RequestSent' ? e.event.targets : undefined)))).toEqual([[], [element]]);
        // reading changes nothing in the database; a request saved again is written in the new shape
        expect(JSON.stringify(db.prepare('SELECT data FROM requests').all())).toBe(stored);
        await uow.transaction((st) => st.requests.save(requests[0]));
        expect(JSON.parse((db.prepare('SELECT data FROM requests WHERE id = ?').get(requests[0].id) as { data: string }).data)).toMatchObject({ targets: [] });
        expect(Object.keys(requests[1])).toEqual(['state', 'id', 'session', 'author', 'targets', 'body', 'sentAt', 'dismissedBy', 'dismissedAt', 'mentions']);
        // written before people could be mentioned: they mention no one, the event too
        expect(requests.map((r) => r.mentions)).toEqual([[], []]);
        expect(events.map((e) => (e.event.type === 'RequestSent' ? e.event.mentions : undefined))).toEqual([[], []]);
        // written before messages carried the view they were sent from: none, in the request, the run and the event
        expect(requests.map((r) => r.viewedAt)).toEqual([undefined, undefined]);
        expect(runs[0].input.requests.map((r) => r.viewedAt)).toEqual([undefined, undefined]);
        expect(events.map((e) => (e.event.type === 'RequestSent' ? e.event.viewedAt : undefined))).toEqual([undefined, undefined]);
    });

    test('a request with the view it was sent from keeps it through the store', async () => {
        const uow = createUnitOfWork(openDatabase(':memory:'));
        const viewedAt: C.ViewedAt = {
            view: {
                kind: 'Storming',
                storming: value(C.makeStormingName('OrderToCash')),
                level: 'DesignLevel',
                stage: value(C.makeStageName('Payment')),
                exceptions: false,
            },
            states: value(C.makeElementName('Sales.Order')),
        };
        const loaded = await uow.transaction((st) => {
            openSession(st, sessionId);
            st.requests.save({
                state: 'Sent',
                id: request,
                session: sessionId,
                author: facilitator,
                targets: [],
                body: value(C.makeText('x')),
                sentAt: at,
                mentions: [],
                viewedAt,
            });
            return st.requests.load(request);
        });
        expect(loaded?.viewedAt).toEqual(viewedAt);
    });
});

describe("an interview's question with its choices", () => {
    test('keeps them through the store, after the database is opened again; one stored without them loads as before', async () => {
        const file = path.join(await tempDir(), 'session.db');
        const interviewId = knownInterviewId('00000000-0000-4000-8000-000000000030');
        const question = knownRequestId('00000000-0000-4000-8000-000000000011');
        const asking = (asked?: C.AskedQuestion): C.AskingInterview => ({
            state: 'Asking',
            id: interviewId,
            session: sessionId,
            command: 'Es',
            startedBy: facilitator,
            opening: request,
            language: 'Ja',
            startedAt: at,
            ...(asked && { asked }),
        });
        const asked: C.AskedQuestion = { question, choices: ['返品', '交換'].map((c) => value(C.makeAnswerChoice(c))), multiple: true };
        const db = openDatabase(file);
        await createUnitOfWork(db).transaction((st) => {
            openSession(st, sessionId);
            sendRequest(st);
            st.interviews.save(asking(asked));
        });
        db.close();
        const again = createUnitOfWork(openDatabase(file));
        expect(await again.transaction((st) => st.interviews.load(interviewId))).toEqual(asking(asked));
        await again.transaction((st) => st.interviews.save(asking()));
        expect((await again.transaction((st) => st.interviews.load(interviewId))) as unknown).toEqual(asking());
    });
});

describe("rows written before the agent's reply was structured", () => {
    // a run that needs clarification had a plain question, a completed run no reply, an input no answer: read as they are
    test('load as runs without a reply, and still hold the invariants of their state', async () => {
        const fixture = JSON.parse(await readFile(path.join(import.meta.dir, '..', '..', 'test-fixtures', 'session', 'legacy-run-replies.json'), 'utf8')) as {
            session: { id: string; state: string; data: unknown };
            runs: { id: string; state: string; data: unknown }[];
            outbox: { type: string; payload: unknown }[];
        };
        const db = openDatabase(':memory:');
        const raw = (o: unknown): string => JSON.stringify(o);
        db.prepare('INSERT INTO sessions (id, state, data) VALUES (?, ?, ?)').run(fixture.session.id, fixture.session.state, raw(fixture.session.data));
        fixture.runs.forEach((r, i) =>
            db
                .prepare('INSERT INTO agent_runs (id, session_id, seq, state, data) VALUES (?, ?, ?, ?, ?)')
                .run(r.id, fixture.session.id, i + 1, r.state, raw(r.data)),
        );
        for (const e of fixture.outbox)
            db.prepare('INSERT INTO outbox (session_id, type, payload, recorded_at) VALUES (?, ?, ?, ?)').run(
                fixture.session.id,
                e.type,
                raw(e.payload),
                at.toISOString(),
            );
        const uow = createUnitOfWork(db);
        const session = knownSessionId(fixture.session.id);
        const { runs, events } = await uow.transaction((st) => ({ runs: st.runs.listBySession(session), events: st.outbox.readAfter(0, 10, session) }));
        expect(runs.map((r) => r.state)).toEqual(['NeedsClarification', 'Completed']);
        const [asked, done] = runs;
        expect(asked?.state === 'NeedsClarification' && asked.question).toContain('税区分は');
        for (const r of runs) {
            expect('reply' in r).toBe(false);
            expect(r.input.answer).toBeUndefined();
            expect(C.checkRunInput(r.input)).toEqual([]);
            expect(C.checkAgentRunWith({ serial: () => true })(r)).toEqual([]);
        }
        expect(done?.state === 'Completed' && done.changed).toBe(true);
        expect(events.map((e) => e.event.type)).toEqual(['RunNeedsClarification', 'RunCompleted']);
    });
});

describe('change proposals written when a proposal was three texts', () => {
    // a proposal was `{ what, where, how }` and an approval's edit a whole one (ADR 0030, M2): read as a proposal with no
    // targets and no options whose how is the three joined, the edit as the how it edited; nothing rewritten
    test('load with the three texts as their how, in the proposal, its events and the run that followed it', async () => {
        const db = openDatabase(':memory:');
        const raw = (o: unknown): string => JSON.stringify(o);
        const ids = {
            session: '00000000-0000-4000-8000-000000000101',
            request: '00000000-0000-4000-8000-000000000102',
            triage: '00000000-0000-4000-8000-000000000103',
            run: '00000000-0000-4000-8000-000000000104',
            proposal: '00000000-0000-4000-8000-000000000105',
        };
        const former = { what: '取り消しのコマンド', where: '@{Sales.Order}, sales/order.dt', how: 'Confirmed から Cancelled へ' };
        const edited = { what: '取り消しのコマンド', where: '@{Sales.Order}', how: 'Placed からだけ' };
        db.prepare('INSERT INTO sessions (id, state, data) VALUES (?, ?, ?)').run(ids.session, 'Open', raw({}));
        db.prepare('INSERT INTO requests (id, session_id, seq, state, data) VALUES (?, ?, 1, ?, ?)').run(ids.request, ids.session, 'Sent', raw({}));
        db.prepare('INSERT INTO triages (id, session_id, seq, request_id, state, data) VALUES (?, ?, 1, ?, ?, ?)').run(
            ids.triage,
            ids.session,
            ids.request,
            'Decided',
            raw({}),
        );
        const input = { requests: [], proposals: { approved: [{ proposal: ids.proposal, request: ids.request, content: edited }] } };
        db.prepare('INSERT INTO agent_runs (id, session_id, seq, state, data) VALUES (?, ?, 1, ?, ?)').run(
            ids.run,
            ids.session,
            'Queued',
            raw({ state: 'Queued', input }),
        );
        const proposal = {
            state: 'Approved',
            id: ids.proposal,
            session: ids.session,
            triage: ids.triage,
            request: ids.request,
            requestedBy: 'dev:bob',
            content: former,
            proposedAt: at.toISOString(),
            approvedBy: 'local:facilitator',
            approvedAt: at.toISOString(),
            edited,
            run: ids.run,
        };
        db.prepare('INSERT INTO proposals (id, session_id, seq, triage_id, request_id, run_id, state, data) VALUES (?, ?, 1, ?, ?, ?, ?, ?)').run(
            ids.proposal,
            ids.session,
            ids.triage,
            ids.request,
            ids.run,
            'Approved',
            raw(proposal),
        );
        for (const payload of [
            { type: 'ChangeProposed', proposalId: ids.proposal, content: former },
            { type: 'ProposalApproved', proposalId: ids.proposal, edited, run: ids.run },
        ])
            db.prepare('INSERT INTO outbox (session_id, type, payload, recorded_at) VALUES (?, ?, ?, ?)').run(
                ids.session,
                payload.type,
                raw(payload),
                at.toISOString(),
            );
        const stored = JSON.stringify(db.prepare('SELECT data FROM proposals').all());
        const uow = createUnitOfWork(db);
        const session = knownSessionId(ids.session);
        const read = await uow.transaction((st) => ({
            proposals: st.proposals.listBySession(session),
            run: st.runs.load(knownAgentRunId(ids.run))?.run,
            events: st.outbox.readAfter(0, 10, session),
        }));
        const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
        const [p] = read.proposals;
        expect(plain(p?.content)).toEqual({ targets: [], how: '取り消しのコマンド\n@{Sales.Order}, sales/order.dt\nConfirmed から Cancelled へ', options: [] });
        expect(p && C.checkProposalContentWith({ oneRecommended: () => true })(p.content)).toEqual([]);
        expect((p?.state === 'Approved' && [p.editedHow, 'edited' in p, p.option]) as unknown).toEqual([
            '取り消しのコマンド\n@{Sales.Order}\nPlaced からだけ',
            false,
            undefined,
        ]);
        expect(plain(read.run?.input.proposals?.approved)).toEqual([
            { proposal: ids.proposal, request: ids.request, instruction: { targets: [], how: '取り消しのコマンド\n@{Sales.Order}\nPlaced からだけ' } },
        ]);
        expect(plain(read.events.map((e) => (e.event.type === 'ChangeProposed' ? e.event.content : e.event)))).toEqual([
            { targets: [], how: '取り消しのコマンド\n@{Sales.Order}, sales/order.dt\nConfirmed から Cancelled へ', options: [] },
            { type: 'ProposalApproved', proposalId: ids.proposal, run: ids.run, editedHow: '取り消しのコマンド\n@{Sales.Order}\nPlaced からだけ' },
        ]);
        // reading changes nothing in the database
        expect(JSON.stringify(db.prepare('SELECT data FROM proposals').all())).toBe(stored);
        db.close();
    });
});

describe('a database moved from an older .domaintrail/', () => {
    /** A session database as dt makes it, with a session and every kind of credential in it. */
    async function withCredentials(): Promise<string> {
        const dir = await tempDir();
        const db = await openSessionDatabase(dir);
        db.exec(`
            INSERT INTO sessions (id, state, data) VALUES ('s', 'Open', '{}');
            INSERT INTO sign_ins (token_hash, session_id, identity, created_at) VALUES ('t', 's', '{}', 1);
            INSERT INTO facilitator_links (code_hash, session_id, expires_at) VALUES ('c', 's', 1);
            INSERT INTO invites (code_hash, session_id, created_at, expires_at) VALUES ('i', 's', 1, 2);
            INSERT INTO facilitators (session_id, provider, subject, bound_at) VALUES ('s', 'access', 'mallory@example.com', 1);
        `);
        db.close();
        return path.join(dir, 'session.db');
    }
    const count = (file: string, sql: string): number => {
        const db = new DatabaseSync(file);
        try {
            return Number(db.prepare(sql).get()?.n);
        } finally {
            db.close();
        }
    };

    test('one dt made: every credential deleted, the session kept', async () => {
        const file = await withCredentials();
        expect(cleanMovedDatabase(file)).toBe(true);
        for (const t of CREDENTIAL_TABLES) expect([t, count(file, `SELECT count(*) AS n FROM ${t}`)]).toEqual([t, 0]);
        expect(count(file, 'SELECT count(*) AS n FROM sessions')).toBe(1);
    });

    test('one made at an older migration level (without the later credential tables): cleaned too', async () => {
        const level = MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE sign_ins')) + 1;
        expect(level).toBeLessThan(MIGRATIONS.length);
        const file = path.join(await tempDir(), 'session.db');
        const db = new DatabaseSync(file);
        db.exec('PRAGMA foreign_keys = ON');
        for (let v = 0; v < level; v++) db.exec(MIGRATIONS[v]);
        db.exec(`PRAGMA user_version = ${level}`);
        db.exec("INSERT INTO sessions (id, state, data) VALUES ('s', 'Open', '{}')");
        db.exec("INSERT INTO sign_ins (token_hash, session_id, identity, created_at) VALUES ('t', 's', '{}', 1)");
        db.close();
        expect(cleanMovedDatabase(file)).toBe(true);
        expect(count(file, 'SELECT count(*) AS n FROM sign_ins')).toBe(0);
    });

    test('refused (false, nothing to use) unless its schema is exactly one dt made: case variants, triggers, views, extra tables, unknown levels', async () => {
        const crafted = async (sql: string): Promise<string> => {
            const file = await withCredentials();
            const db = new DatabaseSync(file);
            db.exec(sql);
            db.close();
            return file;
        };
        for (const sql of [
            'ALTER TABLE sign_ins RENAME TO tmp; ALTER TABLE tmp RENAME TO SIGN_INS',
            "CREATE TRIGGER keep AFTER DELETE ON sign_ins BEGIN INSERT INTO sign_ins VALUES (old.token_hash || 'x', old.session_id, old.identity, 1, NULL); END",
            'CREATE VIEW v AS SELECT * FROM sign_ins',
            'CREATE TABLE extra (x)',
            'ALTER TABLE sessions ADD COLUMN extra TEXT',
            'PRAGMA user_version = 0',
            `PRAGMA user_version = ${MIGRATIONS.length + 1}`,
            `PRAGMA user_version = ${MIGRATIONS.length - 1}`,
        ])
            expect([sql, cleanMovedDatabase(await crafted(sql))]).toEqual([sql, false]);
        const garbage = path.join(await tempDir(), 'session.db');
        await writeFile(garbage, 'not a database'.repeat(200));
        expect(cleanMovedDatabase(garbage)).toBe(false);
    });
});

describe('a `/` command written when `/guide` was `/es:next` or `/hint`', () => {
    test.each(['EsNext', 'Hint'])('%s is read as a Guide, its SlashCommandStarted too; nothing rewritten', async (kind) => {
        const db = openDatabase(':memory:');
        // the row alone: its session and opening message are beside the point
        db.exec('PRAGMA foreign_keys = OFF');
        const session = knownSessionId('0a7c4f2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b');
        const command = {
            state: 'Answered',
            id: 'c-legacy',
            session,
            kind,
            startedBy: 'p1',
            opening: 'r1',
            language: 'Ja',
            startedAt: { $date: at.toISOString() },
            answer: 'r2',
            next: { status: 'Big Picture まで', steps: [{ text: '例外を洗い出す', reason: '発行に例外がない', command: 'EsExceptions' }] },
            answeredAt: { $date: at.toISOString() },
        };
        db.prepare('INSERT INTO slash_commands (id, session_id, seq, opening_id, run_id, state, data) VALUES (?, ?, 1, ?, NULL, ?, ?)').run(
            command.id,
            session,
            'r1',
            'Answered',
            JSON.stringify(command),
        );
        const started = { type: 'SlashCommandStarted', commandId: 'c-legacy', session, kind, startedBy: 'p1', opening: 'r1', language: 'Ja' };
        db.prepare('INSERT INTO outbox (session_id, type, payload, recorded_at) VALUES (?, ?, ?, ?)').run(
            session,
            started.type,
            JSON.stringify(started),
            at.toISOString(),
        );
        const uow = createUnitOfWork(db);
        const { commands, events } = await uow.transaction((st) => ({
            commands: st.slashCommands.listBySession(session),
            events: st.outbox.readAfter(0, 10, session),
        }));
        expect(commands.map((c) => [c.kind, c.state])).toEqual([['Guide', 'Answered']]);
        // its steps, written before they had places to go: none
        expect(commands[0]?.state === 'Answered' && commands[0].next?.steps[0]?.targets).toEqual([]);
        expect(events.map((e) => (e.event.type === 'SlashCommandStarted' ? e.event.kind : undefined))).toEqual(['Guide']);
        expect(JSON.parse((db.prepare('SELECT data FROM slash_commands').get() as { data: string }).data)).toMatchObject({ kind });
    });
});
