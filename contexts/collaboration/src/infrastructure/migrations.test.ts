// Databases written by earlier versions, upgraded in place: before marks and emoji reactions (migration 4), before
// replies (migration 5), before replies to messages (migration 7), before approvals (migration 8), with confirmed
// revisions (migration 9), before undoing runs (migration 10). The store itself: sqlite.test.ts.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Collaboration as C } from '../generated/index.js';
import { makeEmoji, markKey, VOTE, type MarkTargetData } from '../domain/marks.js';
import { createUnitOfWork, MIGRATIONS, openDatabase } from './sqlite.js';
import { knownAgentRunId, knownMarkId, knownRequestId, knownRevisionId, knownSessionId } from '../domain/ids.js';

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
        const sid = knownSessionId(id);
        expect(await uow.transaction((s) => [s.sessions.load(sid)?.state, s.marks.placedBySession(sid)])).toEqual(['Open', []]);

        // one placed mark per participant, target and sign, whatever the code above does
        const mark: C.PlacedMark = {
            state: 'Placed',
            id: knownMarkId('00000000-0000-4000-8000-000000000002'),
            session: sid,
            participant: value(C.makeParticipantId('ann')),
            target: { kind: 'Message', request: knownRequestId('00000000-0000-4000-8000-000000000003') },
            sign: react('❤️'),
            placedAt: new Date('2026-11-01T09:00:00Z'),
        };
        await uow.transaction((s) => s.marks.save(mark));
        const duplicate = await uow
            .transaction((s) => s.marks.save({ ...mark, id: knownMarkId('00000000-0000-4000-8000-000000000004') }))
            .then(
                () => 'saved',
                () => 'refused',
            );
        expect(duplicate).toBe('refused');
        // removed, it stays as a row; another can be placed
        await uow.transaction((s) => s.marks.save({ ...mark, state: 'Removed', removedAt: new Date('2026-11-01T09:01:00Z') }));
        await uow.transaction((s) => s.marks.save({ ...mark, id: knownMarkId('00000000-0000-4000-8000-000000000005') }));
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
        const id = knownSessionId(sid);
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
        const again: C.PlacedMark = { ...placed[0], id: knownMarkId('00000000-0000-4000-8000-000000000200') };
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
        expect(MIGRATIONS.length).toBe(10);
        const uow = createUnitOfWork(db);
        const loaded = await uow.transaction((s) => s.requests.load(knownRequestId(rid)));
        expect(loaded).toMatchObject({ state: 'Sent', body: 'Add cancel.' });
        expect(loaded?.replyTo).toBeUndefined();
        // a run frozen before picks were recorded loads as it was: no pick
        const oldRun = await uow.transaction((s) => s.runs.load(knownAgentRunId(runId))?.run);
        expect(oldRun?.input).toEqual(run.input as unknown as C.RunInput);
        expect(db.prepare('SELECT reply_to FROM requests WHERE id = ?').get(rid)).toEqual({ reply_to: null });

        // a reply keeps its run in the column; a reply to a run the database does not hold is refused
        const reply: C.SentRequest = {
            state: 'Sent',
            id: knownRequestId('00000000-0000-4000-8000-000000000004'),
            session: knownSessionId(sid),
            author: value(C.makeParticipantId('local:facilitator')),
            targets: [],
            body: text('Why?'),
            sentAt: new Date('2026-11-01T09:00:00Z'),
            replyTo: { kind: 'Run', run: knownAgentRunId(runId) },
            mentions: [],
        };
        await uow.transaction((s) => s.requests.save(reply));
        expect(db.prepare('SELECT reply_to FROM requests WHERE id = ?').get(reply.id)).toEqual({ reply_to: runId });
        expect(await uow.transaction((s) => s.requests.load(reply.id)?.replyTo)).toEqual({ kind: 'Run', run: knownAgentRunId(runId) });
        const dangling = await uow
            .transaction((s) =>
                s.requests.save({
                    ...reply,
                    id: knownRequestId('00000000-0000-4000-8000-000000000005'),
                    replyTo: { kind: 'Run', run: knownAgentRunId('00000000-0000-4000-8000-0000000000aa') },
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

describe('the reply_to_request column (migration 7)', () => {
    test('a database of the schema before replies to messages: a reply to a run reads as one, the run and its event too; replies to messages keep their message', async () => {
        const dir = await workspace({});
        const file = path.join(dir, 'session.db');
        // the schema before replies to messages (6 migrations): a reply to a run as it was written, by the run's ID alone
        const old = new DatabaseSync(file);
        for (const m of MIGRATIONS.slice(0, 6)) old.exec(m);
        old.exec('PRAGMA user_version = 6');
        const sid = '00000000-0000-4000-8000-000000000001';
        const rid = '00000000-0000-4000-8000-000000000002';
        const runId = '00000000-0000-4000-8000-000000000003';
        const replyId = '00000000-0000-4000-8000-000000000004';
        const replyRunId = '00000000-0000-4000-8000-000000000005';
        const at = { $date: '2026-10-31T09:00:00.000Z' };
        const who = 'local:facilitator';
        const session = {
            state: 'Open',
            id: sid,
            facilitator: who,
            participants: [{ id: who, name: 'Facilitator', role: 'Facilitator', joinedAt: at }],
            startedAt: at,
        };
        const request = { state: 'Sent', id: rid, session: sid, author: who, targets: [], body: 'Add cancel.', sentAt: at, mentions: [] };
        const reply = { ...request, id: replyId, body: 'Why?', replyTo: runId };
        const frozen = (r: typeof request) => ({ request: r.id, author: who, targets: [], body: r.body });
        const ended = { state: 'Cancelled', session: sid, queuedBy: who, queuedAt: at, cancelledBy: who, cancelledAt: at };
        const run = { ...ended, id: runId, input: { requests: [frozen(request)] } };
        const replyRun = { ...ended, id: replyRunId, input: { requests: [{ ...frozen(reply), replyTo: runId }] } };
        old.prepare('INSERT INTO sessions (id, state, data) VALUES (?, ?, ?)').run(sid, 'Open', JSON.stringify(session));
        const insertRequest = old.prepare('INSERT INTO requests (id, session_id, seq, state, data, reply_to) VALUES (?, ?, ?, ?, ?, ?)');
        const insertRun = old.prepare('INSERT INTO agent_runs (id, session_id, seq, state, data) VALUES (?, ?, ?, ?, ?)');
        insertRequest.run(rid, sid, 1, 'Sent', JSON.stringify(request), null);
        insertRun.run(runId, sid, 1, 'Cancelled', JSON.stringify(run));
        insertRequest.run(replyId, sid, 2, 'Sent', JSON.stringify(reply), runId);
        insertRun.run(replyRunId, sid, 2, 'Cancelled', JSON.stringify(replyRun));
        old.prepare('INSERT INTO outbox (session_id, type, payload, recorded_at) VALUES (?, ?, ?, ?)').run(
            sid,
            'RequestSent',
            JSON.stringify({
                type: 'RequestSent',
                requestId: replyId,
                session: sid,
                author: who,
                targets: [],
                body: 'Why?',
                sentAt: at,
                replyTo: runId,
                mentions: [],
            }),
            '2026-10-31T09:00:00.000Z',
        );
        old.close();

        const db = openDatabase(file);
        expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
        const uow = createUnitOfWork(db);
        const toRun = { kind: 'Run', run: runId };
        const stored = JSON.stringify(db.prepare('SELECT data FROM requests').all());
        const read = await uow.transaction((s) => ({
            plain: s.requests.load(knownRequestId(rid)),
            reply: s.requests.load(knownRequestId(replyId)),
            run: s.runs.load(knownAgentRunId(replyRunId))?.run,
            events: s.outbox.readAfter(0, 10, knownSessionId(sid)),
        }));
        expect(read.plain?.replyTo).toBeUndefined();
        expect(read.reply?.replyTo).toEqual(toRun as C.ReplyTarget);
        expect(read.run?.input.requests[0].replyTo).toEqual(toRun as C.FrozenReplyTarget);
        expect(read.events.map((e) => (e.event.type === 'RequestSent' ? e.event.replyTo : undefined))).toEqual([toRun as C.ReplyTarget]);
        // reading rewrites nothing
        expect(JSON.stringify(db.prepare('SELECT data FROM requests').all())).toBe(stored);
        expect(db.prepare('SELECT reply_to_request FROM requests WHERE id = ?').get(replyId)).toEqual({ reply_to_request: null });

        // a reply to a message keeps the message in its column (not the run's); one to a message the database does not hold is refused
        const toMessage: C.SentRequest = {
            state: 'Sent',
            id: knownRequestId('00000000-0000-4000-8000-000000000006'),
            session: knownSessionId(sid),
            author: value(C.makeParticipantId(who)),
            targets: [],
            body: text('Same here.'),
            sentAt: new Date('2026-11-01T09:00:00Z'),
            replyTo: { kind: 'Message', request: knownRequestId(rid) },
            mentions: [],
        };
        await uow.transaction((s) => s.requests.save(toMessage));
        expect(db.prepare('SELECT reply_to, reply_to_request FROM requests WHERE id = ?').get(toMessage.id)).toEqual({ reply_to: null, reply_to_request: rid });
        expect(await uow.transaction((s) => s.requests.load(toMessage.id)?.replyTo)).toEqual({ kind: 'Message', request: knownRequestId(rid) });
        const dangling = await uow
            .transaction((s) =>
                s.requests.save({
                    ...toMessage,
                    id: knownRequestId('00000000-0000-4000-8000-000000000007'),
                    replyTo: { kind: 'Message', request: knownRequestId('00000000-0000-4000-8000-0000000000aa') },
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

describe('the approvals table (migration 8)', () => {
    test('a database of the schema before approvals is upgraded in place: its runs load as they were, with no approvals; one approval per assumption from then on', async () => {
        const dir = await workspace({});
        const file = path.join(dir, 'session.db');
        // the schema before approvals (7 migrations), with a completed run that made two assumptions
        const old = new DatabaseSync(file);
        for (const m of MIGRATIONS.slice(0, 7)) old.exec(m);
        old.exec('PRAGMA user_version = 7');
        const sid = '00000000-0000-4000-8000-000000000001';
        const rid = '00000000-0000-4000-8000-000000000002';
        const runId = '00000000-0000-4000-8000-000000000003';
        const rev = '00000000-0000-4000-8000-000000000004';
        const at = { $date: '2026-10-31T09:00:00.000Z' };
        const who = 'local:facilitator';
        const session = {
            state: 'Open',
            id: sid,
            facilitator: who,
            participants: [{ id: who, name: 'Facilitator', role: 'Facilitator', joinedAt: at }],
            startedAt: at,
        };
        const assumption = (t: string) => ({ text: t, requests: [rid], alternatives: [{ id: 'other', label: 'Other' }] });
        const run = {
            state: 'Completed',
            id: runId,
            session: sid,
            input: { requests: [{ request: rid, author: who, targets: [], body: 'Add cancel.' }] },
            queuedBy: who,
            queuedAt: at,
            baseRevision: rev,
            startedAt: at,
            report: { exitCode: 0, formatted: true, checked: true, newDtErrors: 0, unparsedDtes: 0 },
            resultRevision: rev,
            changed: false,
            reply: { summary: 'Added cancel.', requests: [], questions: [], assumptions: [assumption('Only drafts.'), assumption('Keeps the order.')] },
            finishedAt: at,
        };
        old.prepare('INSERT INTO sessions (id, state, data) VALUES (?, ?, ?)').run(sid, 'Open', JSON.stringify(session));
        old.prepare('INSERT INTO agent_runs (id, session_id, seq, state, data) VALUES (?, ?, ?, ?, ?)').run(runId, sid, 1, 'Completed', JSON.stringify(run));
        old.close();

        const db = openDatabase(file);
        expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
        const uow = createUnitOfWork(db);
        const session8 = knownSessionId(sid);
        const before = await uow.transaction((s) => ({ run: s.runs.load(knownAgentRunId(runId))?.run, approvals: s.approvals.listBySession(session8) }));
        expect(before.run?.state).toBe('Completed');
        expect(before.approvals).toEqual([]);

        const approval = (id: string, index: number): C.AssumptionApproval => ({
            state: 'Approved',
            id: value(C.makeAssumptionApprovalId(id)),
            session: session8,
            assumption: { run: knownAgentRunId(runId), assumption: value(C.makeTally(index)) },
            approvedBy: value(C.makeParticipantId(who)),
            approvedAt: new Date('2026-11-01T09:00:00Z'),
        });
        const first = approval('00000000-0000-4000-8000-000000000005', 1);
        await uow.transaction((s) => s.approvals.save(first));
        expect(await uow.transaction((s) => s.approvals.listBySession(session8))).toEqual([first]);
        // a second approval of the same assumption is refused by the store; another assumption is approved
        const twice = await uow
            .transaction((s) => s.approvals.save(approval('00000000-0000-4000-8000-000000000006', 1)))
            .then(
                () => 'saved',
                () => 'refused',
            );
        expect(twice).toBe('refused');
        const second = approval('00000000-0000-4000-8000-000000000007', 0);
        await uow.transaction((s) => s.approvals.save(second));
        expect(await uow.transaction((s) => s.approvals.listBySession(session8))).toEqual([first, second]);
        db.close();
    });
});

describe('no confirmed revisions (migration 9)', () => {
    test('a database with a confirmed revision: it loads as the recorded one it was, and its RevisionConfirmed event is gone', async () => {
        const dir = await workspace({});
        const file = path.join(dir, 'session.db');
        // the schema with confirmations (8 migrations): a recorded revision, a confirmed one and their events
        const old = new DatabaseSync(file);
        for (const m of MIGRATIONS.slice(0, 8)) old.exec(m);
        old.exec('PRAGMA user_version = 8');
        const sid = '00000000-0000-4000-8000-000000000001';
        const recorded = '00000000-0000-4000-8000-000000000002';
        const confirmed = '00000000-0000-4000-8000-000000000003';
        const at = { $date: '2026-10-31T09:00:00.000Z' };
        const who = 'local:facilitator';
        const session = {
            state: 'Open',
            id: sid,
            facilitator: who,
            participants: [{ id: who, name: 'Facilitator', role: 'Facilitator', joinedAt: at }],
            startedAt: at,
        };
        const validation = { dtErrors: 0, dtesErrors: 0, dtesWarnings: 0, linkWarnings: 0, stale: false };
        const revision = (id: string) => ({
            state: 'Recorded',
            id,
            session: sid,
            origin: { kind: 'SessionStart', session: sid },
            contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            files: [],
            validation,
            takenAt: at,
        });
        const confirmedRow = { ...revision(confirmed), state: 'Confirmed', confirmedBy: who, confirmedAt: { $date: '2026-10-31T10:00:00.000Z' } };
        old.prepare('INSERT INTO sessions (id, state, data) VALUES (?, ?, ?)').run(sid, 'Open', JSON.stringify(session));
        const insert = old.prepare('INSERT INTO revisions (id, session_id, seq, state, origin, content_hash, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
        insert.run(recorded, sid, 1, 'Recorded', 'SessionStart', revision(recorded).contentHash, JSON.stringify(revision(recorded)));
        insert.run(confirmed, sid, 2, 'Confirmed', 'SessionStart', confirmedRow.contentHash, JSON.stringify(confirmedRow));
        const outbox = old.prepare('INSERT INTO outbox (session_id, type, payload, recorded_at) VALUES (?, ?, ?, ?)');
        outbox.run(sid, 'RevisionRecorded', JSON.stringify({ type: 'RevisionRecorded', revisionId: recorded }), '2026-10-31T09:00:00.000Z');
        outbox.run(
            sid,
            'RevisionConfirmed',
            JSON.stringify({ type: 'RevisionConfirmed', revisionId: confirmed, confirmedBy: who, confirmedAt: at }),
            '2026-10-31T10:00:00.000Z',
        );
        old.close();

        const db = openDatabase(file);
        expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
        expect(db.prepare('SELECT id, state FROM revisions ORDER BY seq').all()).toEqual([
            { id: recorded, state: 'Recorded' },
            { id: confirmed, state: 'Recorded' },
        ]);
        const uow = createUnitOfWork(db);
        const read = await uow.transaction((s) => ({
            revision: s.revisions.load(knownRevisionId(confirmed)),
            events: s.outbox.readAfter(0, 10, knownSessionId(sid)),
        }));
        expect(read.revision).toEqual({ ...revision(confirmed), takenAt: new Date('2026-10-31T09:00:00.000Z') } as unknown as C.Revision);
        expect(read.events.map((e) => e.event.type)).toEqual(['RevisionRecorded']);
        db.close();
    });
});

describe('the undoes column (migration 10)', () => {
    test('a database of the schema before undoing runs is upgraded in place: its requests load as they were; an undo keeps its run, and the database refuses an unknown one', async () => {
        const dir = await workspace({});
        const file = path.join(dir, 'session.db');
        // the schema before undoing runs (9 migrations), with a request and the completed run that bundled it
        const old = new DatabaseSync(file);
        for (const m of MIGRATIONS.slice(0, 9)) old.exec(m);
        old.exec('PRAGMA user_version = 9');
        const sid = '00000000-0000-4000-8000-000000000001';
        const rid = '00000000-0000-4000-8000-000000000002';
        const runId = '00000000-0000-4000-8000-000000000003';
        const at = { $date: '2026-10-31T09:00:00.000Z' };
        const who = 'local:facilitator';
        const session = {
            state: 'Open',
            id: sid,
            facilitator: who,
            participants: [{ id: who, name: 'Facilitator', role: 'Facilitator', joinedAt: at }],
            startedAt: at,
        };
        const request = { state: 'Sent', id: rid, session: sid, author: who, targets: [], body: 'Add cancel.', sentAt: at, mentions: [] };
        const run = {
            state: 'Queued',
            id: runId,
            session: sid,
            input: { requests: [{ request: rid, author: who, targets: [], body: 'Add cancel.' }] },
            queuedBy: who,
            queuedAt: at,
        };
        old.prepare('INSERT INTO sessions (id, state, data) VALUES (?, ?, ?)').run(sid, 'Open', JSON.stringify(session));
        old.prepare('INSERT INTO requests (id, session_id, seq, state, data) VALUES (?, ?, ?, ?, ?)').run(rid, sid, 1, 'Sent', JSON.stringify(request));
        old.prepare('INSERT INTO agent_runs (id, session_id, seq, state, data) VALUES (?, ?, ?, ?, ?)').run(runId, sid, 1, 'Queued', JSON.stringify(run));
        old.close();

        const db = openDatabase(file);
        expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
        const uow = createUnitOfWork(db);
        const loaded = await uow.transaction((s) => s.requests.load(knownRequestId(rid)));
        expect(loaded?.undoes).toBeUndefined();
        expect(loaded?.body).toBe(text('Add cancel.'));

        const undo = (id: string, undoes: string): C.Request => ({
            state: 'Sent',
            id: knownRequestId(id),
            session: knownSessionId(sid),
            author: value(C.makeParticipantId(who)),
            targets: [],
            body: text('Undo the changes of Add cancel.'),
            sentAt: new Date('2026-11-03T09:00:00Z'),
            mentions: [],
            undoes: knownAgentRunId(undoes),
        });
        const kept = undo('00000000-0000-4000-8000-000000000004', runId);
        await uow.transaction((s) => s.requests.save(kept));
        expect(await uow.transaction((s) => s.requests.load(kept.id))).toEqual(kept);
        expect(db.prepare('SELECT undoes FROM requests WHERE id = ?').get(kept.id)).toEqual({ undoes: runId });
        const unknown = await uow
            .transaction((s) => s.requests.save(undo('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-0000000000ff')))
            .then(
                () => 'saved',
                () => 'refused',
            );
        expect(unknown).toBe('refused');
        db.close();
    });
});
