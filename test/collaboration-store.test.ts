// The session's persistence (ADR 0026): node:sqlite schema and migrations, transactions with the outbox, the run
// queue's claim, lease and serial rule, the session directory and its blobs, never through a symbolic link.
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Collaboration as C } from '@domaintrail/collaboration/generated/index';
import type { Stores } from '@domaintrail/collaboration/application/ports';
import { agentRunCommands, sessionCommands } from '@domaintrail/collaboration/domain/commands';
import { createFileBlobs, openSessionBlobs } from '@domaintrail/collaboration/infrastructure/blobs';
import { UnsafeSessionPath } from '@domaintrail/collaboration/infrastructure/session-dir';
import {
    MIGRATIONS,
    NewerSchema,
    createUnitOfWork,
    decodeJson,
    encodeJson,
    openDatabase,
    openSessionDatabase,
} from '@domaintrail/collaboration/infrastructure/sqlite';

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
const sessionId = C.makeSessionId('00000000-0000-4000-8000-000000000001');
const otherSession = C.makeSessionId('00000000-0000-4000-8000-000000000002');
const request = C.makeRequestId('00000000-0000-4000-8000-000000000010');
const revision = C.makeRevisionId('00000000-0000-4000-8000-000000000020');

function openSession(stores: Stores, id: C.SessionId): void {
    const { Open } = value(sessionCommands.start(id, facilitator, value(C.makeDisplayName('Ada')), at));
    stores.sessions.save(Open.aggregate);
    stores.outbox.append(id, [Open.events.SessionStarted], at);
}

function queued(id: number, session: C.SessionId = sessionId): C.QueuedAgentRun {
    return {
        state: 'Queued',
        id: C.makeAgentRunId(`00000000-0000-4000-8000-0000000001${String(id).padStart(2, '0')}`),
        session,
        input: {
            requests: [{ request, author: facilitator, target: { target: { kind: 'Workspace' }, sourceRevision: revision }, body: value(C.makeText('x')) }],
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
        target: { target: { kind: 'Workspace' }, sourceRevision: revision },
        body: value(C.makeText('x')),
        sentAt: at,
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
            'facilitator_links',
            'facilitators',
            'outbox',
            'requests',
            'restore_operations',
            'revisions',
            'run_requests',
            'sessions',
            'sign_ins',
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
        const running = value(agentRunCommands.start(runs[0], revision, at)).Running.aggregate;
        await uow.transaction((s) => {
            s.runs.save(running);
            s.runs.endLease(running.id, 'done');
        });
        // no lease left, but a running run: no claim
        expect(await uow.transaction((s) => s.runs.claimNext(sessionId, lease('t2'), at))).toBeUndefined();
        expect((await uow.transaction((s) => s.runs.active(sessionId, at)))?.run.id).toBe(running.id);
        const second = value(agentRunCommands.start(runs[1], revision, at)).Running.aggregate;
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
    test('the database is .domaintrail/session/session.db, next to a .gitignore that ignores everything', async () => {
        const root = await tempDir();
        const db = await openSessionDatabase(root);
        db.close();
        expect((await lstat(path.join(root, '.domaintrail', 'session', 'session.db'))).isFile()).toBe(true);
        expect(await readFile(path.join(root, '.domaintrail', 'session', '.gitignore'), 'utf8')).toBe('*\n');
    });

    test('nothing is written through a symbolic link', async () => {
        const outside = await tempDir();
        const linkedTop = await tempDir();
        await symlink(outside, path.join(linkedTop, '.domaintrail'));
        expect(await thrown(openSessionDatabase(linkedTop))).toMatchObject(errorLike(UnsafeSessionPath));

        const linkedSession = await tempDir();
        await mkdir(path.join(linkedSession, '.domaintrail'));
        await symlink(outside, path.join(linkedSession, '.domaintrail', 'session'));
        expect(await thrown(openSessionDatabase(linkedSession))).toMatchObject(errorLike(UnsafeSessionPath));

        const linkedDb = await tempDir();
        await mkdir(path.join(linkedDb, '.domaintrail', 'session'), { recursive: true });
        await symlink(path.join(outside, 'x.db'), path.join(linkedDb, '.domaintrail', 'session', 'session.db'));
        expect(await thrown(openSessionDatabase(linkedDb))).toMatchObject(errorLike(UnsafeSessionPath));

        const linkedBlobs = await tempDir();
        await mkdir(path.join(linkedBlobs, '.domaintrail', 'session'), { recursive: true });
        await symlink(outside, path.join(linkedBlobs, '.domaintrail', 'session', 'blobs'));
        const blobs = await openSessionBlobs(linkedBlobs);
        const bytes = new TextEncoder().encode('context A {}');
        expect(await thrown(blobs.put([{ hash: createHash('sha256').update(bytes).digest('hex'), bytes }]))).toMatchObject(errorLike(UnsafeSessionPath));
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
