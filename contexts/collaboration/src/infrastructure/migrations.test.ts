// Databases written by earlier versions, upgraded in place: before marks and emoji reactions (migration 4), before
// replies (migration 5). The store itself: sqlite.test.ts.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Collaboration as C } from '../generated/index.js';
import { makeEmoji, markKey, VOTE, type MarkTargetData } from '../domain/marks.js';
import { createUnitOfWork, MIGRATIONS, openDatabase } from './sqlite.js';

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
    return r.value;
};

const text = (t: string): C.Text => value(C.makeText(t));

/** A reaction's sign with an emoji (in the form kept). */
const react = (emoji: string): C.MarkSign => ({ kind: 'Reaction', emoji: value(makeEmoji(emoji)) });

async function workspace(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-marks-'));
    dirs.push(root);
    for (const [file, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), text);
    }
    return root;
}

describe('the marks table (migration 4) and reactions as emoji', () => {
    test('a database written before marks is upgraded in place: its session loads, and marks are kept from then on', async () => {
        const dir = await workspace({});
        const file = path.join(dir, 'session.db');
        // the schema before marks, with a session in it
        const old = new DatabaseSync(file);
        for (const m of MIGRATIONS.slice(0, 3)) old.exec(m);
        old.exec('PRAGMA user_version = 3');
        const id = '00000000-0000-4000-8000-000000000001';
        const session = {
            state: 'Open',
            id,
            facilitator: 'local:facilitator',
            participants: [{ id: 'local:facilitator', name: 'Facilitator', role: 'Facilitator', joinedAt: { $date: '2026-10-31T09:00:00.000Z' } }],
            startedAt: { $date: '2026-10-31T09:00:00.000Z' },
        };
        old.prepare('INSERT INTO sessions (id, state, data) VALUES (?, ?, ?)').run(id, 'Open', JSON.stringify(session));
        old.close();

        const db = openDatabase(file);
        expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
        const uow = createUnitOfWork(db);
        const sid = C.makeSessionId(id);
        expect(await uow.transaction((s) => [s.sessions.load(sid)?.state, s.marks.placedBySession(sid)])).toEqual(['Open', []]);

        // one placed mark per participant, target and sign, whatever the code above does
        const mark: C.PlacedMark = {
            state: 'Placed',
            id: C.makeMarkId('00000000-0000-4000-8000-000000000002'),
            session: sid,
            participant: value(C.makeParticipantId('ann')),
            target: { kind: 'Message', request: C.makeRequestId('00000000-0000-4000-8000-000000000003') },
            sign: react('❤️'),
            placedAt: new Date('2026-11-01T09:00:00Z'),
        };
        await uow.transaction((s) => s.marks.save(mark));
        const duplicate = await uow
            .transaction((s) => s.marks.save({ ...mark, id: C.makeMarkId('00000000-0000-4000-8000-000000000004') }))
            .then(
                () => 'saved',
                () => 'refused',
            );
        expect(duplicate).toBe('refused');
        // removed, it stays as a row; another can be placed
        await uow.transaction((s) => s.marks.save({ ...mark, state: 'Removed', removedAt: new Date('2026-11-01T09:01:00Z') }));
        await uow.transaction((s) => s.marks.save({ ...mark, id: C.makeMarkId('00000000-0000-4000-8000-000000000005') }));
        expect(await uow.transaction((s): unknown[] => [s.marks.placedBySession(sid).map((m): string => m.id), s.marks.load(mark.id)?.state])).toEqual([
            ['00000000-0000-4000-8000-000000000005'],
            'Removed',
        ]);
        db.close();
    });

    test('a database with the four named reactions: they become 👍 🤔 ❤️ 👀 in the marks and the outbox, votes stay votes', async () => {
        const dir = await workspace({});
        const file = path.join(dir, 'session.db');
        // the schema with marks, before emoji: the version that added the marks table
        const version = MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE marks')) + 1;
        const old = new DatabaseSync(file);
        for (const m of MIGRATIONS.slice(0, version)) old.exec(m);
        old.exec(`PRAGMA user_version = ${version}`);
        const sid = '00000000-0000-4000-8000-000000000001';
        const target = { kind: 'Message', request: '00000000-0000-4000-8000-000000000003' };
        const vote = { kind: 'QuestionOption', run: '00000000-0000-4000-8000-000000000009', question: 'q1', option: 'a' };
        const at = { $date: '2026-11-01T09:00:00.000Z' };
        const rows: [string, string, string, string, object][] = [
            ['1', 'ann', 'Agree', 'Placed', target],
            ['2', 'ann', 'Doubt', 'Placed', target],
            ['3', 'bob', 'Like', 'Placed', target],
            ['4', 'bob', 'Seen', 'Removed', target],
            ['5', 'bob', 'Vote', 'Placed', vote],
        ];
        old.prepare('INSERT INTO sessions (id, state, data) VALUES (?, ?, ?)').run(sid, 'Open', JSON.stringify({ state: 'Open', id: sid }));
        const insert = old.prepare('INSERT INTO marks (id, session_id, seq, participant, target_key, sign, state, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        const outbox = old.prepare('INSERT INTO outbox (session_id, type, payload, recorded_at) VALUES (?, ?, ?, ?)');
        for (const [n, participant, sign, state, t] of rows) {
            const id = `00000000-0000-4000-8000-00000000010${n}`;
            const data = { state, id, session: sid, participant, target: t, sign, placedAt: at, ...(state === 'Removed' && { removedAt: at }) };
            insert.run(id, sid, Number(n), participant, markKey(t as MarkTargetData), sign, state, JSON.stringify(data));
            const event = { type: 'MarkPlaced', markId: id, session: sid, participant, target: t, sign, placedAt: at };
            outbox.run(sid, 'MarkPlaced', JSON.stringify(event), '2026-11-01T09:00:00.000Z');
        }
        outbox.run(sid, 'RequestDismissed', JSON.stringify({ type: 'RequestDismissed', sign: 'Agree' }), '2026-11-01T09:00:00.000Z');
        old.close();

        const db = openDatabase(file);
        expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
        const columns = db.prepare('SELECT sign, state FROM marks ORDER BY seq').all();
        expect(columns.map((r) => [r.sign, r.state])).toEqual([
            ['👍', 'Placed'],
            ['🤔', 'Placed'],
            ['❤️', 'Placed'],
            ['👀', 'Removed'],
            ['Vote', 'Placed'],
        ]);
        const uow = createUnitOfWork(db);
        const id = C.makeSessionId(sid);
        const placed = await uow.transaction((s) => s.marks.placedBySession(id));
        expect(placed.map((m) => m.sign)).toEqual([react('👍'), react('🤔'), react('❤️'), VOTE]);
        expect(placed[0].placedAt).toEqual(new Date('2026-11-01T09:00:00.000Z'));
        const events = await uow.transaction((s) => s.outbox.readAfter(0, 100, id));
        expect(events.map((e): unknown => ('sign' in e.event ? e.event.sign : undefined))).toEqual([
            react('👍'),
            react('🤔'),
            react('❤️'),
            react('👀'),
            VOTE,
            // another event is left as it was
            'Agree',
        ]);
        // the unique index holds for the emoji: a second 👍 of ann's on the message is refused
        const again: C.PlacedMark = { ...placed[0], id: C.makeMarkId('00000000-0000-4000-8000-000000000200') };
        expect(
            await uow
                .transaction((s) => s.marks.save(again))
                .then(
                    () => 'saved',
                    () => 'refused',
                ),
        ).toBe('refused');
        db.close();
    });
});

describe('the reply_to column (migration 5)', () => {
    test('a database of the schema before replies is upgraded in place: its requests load as they were, replies keep their run', async () => {
        const dir = await workspace({});
        const file = path.join(dir, 'session.db');
        // the schema before replies (4 migrations), with a session, a request and an ended run in it
        const old = new DatabaseSync(file);
        for (const m of MIGRATIONS.slice(0, 4)) old.exec(m);
        old.exec('PRAGMA user_version = 4');
        const sid = '00000000-0000-4000-8000-000000000001';
        const rid = '00000000-0000-4000-8000-000000000002';
        const runId = '00000000-0000-4000-8000-000000000003';
        const at = { $date: '2026-10-31T09:00:00.000Z' };
        const session = {
            state: 'Open',
            id: sid,
            facilitator: 'local:facilitator',
            participants: [{ id: 'local:facilitator', name: 'Facilitator', role: 'Facilitator', joinedAt: at }],
            startedAt: at,
        };
        const request = { state: 'Sent', id: rid, session: sid, author: 'local:facilitator', targets: [], body: 'Add cancel.', sentAt: at };
        const run = {
            state: 'Cancelled',
            id: runId,
            session: sid,
            input: { requests: [{ request: rid, author: 'local:facilitator', targets: [], body: 'Add cancel.' }] },
            queuedBy: 'local:facilitator',
            queuedAt: at,
            cancelledBy: 'local:facilitator',
            cancelledAt: at,
        };
        old.prepare('INSERT INTO sessions (id, state, data) VALUES (?, ?, ?)').run(sid, 'Open', JSON.stringify(session));
        old.prepare('INSERT INTO requests (id, session_id, seq, state, data) VALUES (?, ?, 1, ?, ?)').run(rid, sid, 'Sent', JSON.stringify(request));
        old.prepare('INSERT INTO agent_runs (id, session_id, seq, state, data) VALUES (?, ?, 1, ?, ?)').run(runId, sid, 'Cancelled', JSON.stringify(run));
        old.prepare('INSERT INTO run_requests (run_id, request_id) VALUES (?, ?)').run(runId, rid);
        old.close();

        const db = openDatabase(file);
        expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
        expect(MIGRATIONS.length).toBe(6);
        const uow = createUnitOfWork(db);
        const loaded = await uow.transaction((s) => s.requests.load(C.makeRequestId(rid)));
        expect(loaded).toMatchObject({ state: 'Sent', body: 'Add cancel.' });
        expect(loaded?.replyTo).toBeUndefined();
        // a run frozen before picks were recorded loads as it was: no pick
        const oldRun = await uow.transaction((s) => s.runs.load(C.makeAgentRunId(runId))?.run);
        expect(oldRun?.input).toEqual(run.input as unknown as C.RunInput);
        expect(db.prepare('SELECT reply_to FROM requests WHERE id = ?').get(rid)).toEqual({ reply_to: null });

        // a reply keeps its run in the column; a reply to a run the database does not hold is refused
        const reply: C.SentRequest = {
            state: 'Sent',
            id: C.makeRequestId('00000000-0000-4000-8000-000000000004'),
            session: C.makeSessionId(sid),
            author: value(C.makeParticipantId('local:facilitator')),
            targets: [],
            body: text('Why?'),
            sentAt: new Date('2026-11-01T09:00:00Z'),
            replyTo: C.makeAgentRunId(runId),
            mentions: [],
        };
        await uow.transaction((s) => s.requests.save(reply));
        expect(db.prepare('SELECT reply_to FROM requests WHERE id = ?').get(reply.id)).toEqual({ reply_to: runId });
        expect(await uow.transaction((s) => s.requests.load(reply.id)?.replyTo)).toBe(C.makeAgentRunId(runId));
        const dangling = await uow
            .transaction((s) =>
                s.requests.save({
                    ...reply,
                    id: C.makeRequestId('00000000-0000-4000-8000-000000000005'),
                    replyTo: C.makeAgentRunId('00000000-0000-4000-8000-0000000000aa'),
                }),
            )
            .then(
                () => 'saved',
                () => 'refused',
            );
        expect(dangling).toBe('refused');
        db.close();
    });
});
