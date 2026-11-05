// Redacting messages (redaction.ts) over the real store (SQLite): the message's body and its copies — the run that
// froze it, the reply quoting it, its `RequestSent` in the outbox — become the redacted body; the row stays; a message
// of another session than named, unknown, or redacted already is left as it is.
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Collaboration as C, type Result } from '../generated/index.js';
import { sha256Hex } from '../domain/sha256.js';
import { REDACTED_BODY } from '../domain/redaction.js';
import { createUnitOfWork, openDatabase } from '../infrastructure/sqlite.js';
import type { Actor } from './actor.js';
import type { CollaborationDeps } from './ports.js';
import { createRedaction } from './redaction.js';
import { createCollaboration } from './use-cases.js';

const value = <T, E>(r: Result<T, E>): T => {
    if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
    return r.value;
};

const facilitatorId = value(C.makeParticipantId('local:facilitator'));
const facilitator: Actor = { kind: 'participant', participant: facilitatorId, role: 'Facilitator' };
const text = (t: string): C.Text => value(C.makeText(t));

async function open(file = ':memory:') {
    let t = Date.parse('2026-11-05T09:00:00Z');
    let n = 0;
    const db = openDatabase(file);
    const uow = createUnitOfWork(db);
    const clock = { now: () => new Date((t += 1000)) };
    const deps: CollaborationDeps = {
        uow,
        workspace: {
            read: async () => ({ files: [{ path: 'a.dt', bytes: new Uint8Array(), hash: sha256Hex(new Uint8Array()) }], symlinks: [] }),
            write: async () => ({ ok: true }),
        },
        blobs: { put: async () => undefined, get: async () => undefined },
        validator: { validate: async () => ({ diagnostics: [], model: undefined, stormings: [], stormingsComplete: true }) },
        clock,
        ids: { newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` },
    };
    const use = createCollaboration(deps);
    const session = value(await use.openSession({ mode: 'Collab', facilitator: facilitatorId, name: value(C.makeDisplayName('Ada')) })).session.id;
    return { use, session, uow, db, redaction: createRedaction({ uow, clock }) };
}

describe('redactMessages', () => {
    test('redacts the body, the run that froze it, the reply quoting it and the outbox; keeps the row', async () => {
        const { use, session, uow, redaction } = await open();
        const said = value(await use.sendMessage({ session, actor: facilitator, targets: [], body: text('山田さんの携帯は 090-0000-0000') })).request;
        const reply = value(
            await use.sendMessage({
                session,
                actor: facilitator,
                targets: [],
                body: text('それは控えておきます'),
                replyTo: { kind: 'Message', request: said.id },
            }),
        ).request;
        value(await use.queueRun({ session, requests: [said.id, reply.id], actor: facilitator }));

        const done = await redaction.redactMessages([{ session, message: said.id }]);
        expect(done).toEqual({ requests: [said.id], sessions: [session] });

        const state = value(await use.sessionState({ session }));
        const kept = state.requests.find((r) => r.id === said.id);
        expect(kept).toMatchObject({ id: said.id, author: facilitatorId, body: REDACTED_BODY, sentAt: said.sentAt });
        expect(kept?.redactedAt).toBeInstanceOf(Date);
        // the reply itself is not redacted
        expect(state.requests.find((r) => r.id === reply.id)?.body).toBe(text('それは控えておきます'));
        const frozen = state.runs[0]?.input.requests;
        expect(frozen?.map((r) => r.body)).toEqual([REDACTED_BODY, text('それは控えておきます')]);
        expect(frozen?.[1]?.replyTo).toMatchObject({ kind: 'Message', request: said.id, body: REDACTED_BODY });
        const outbox = await uow.transaction((s) => s.outbox.readAfter(0, 100, session));
        const sent = outbox.flatMap((e) => (e.event.type === 'RequestSent' ? [[e.event.requestId, e.event.body]] : []));
        expect(sent).toEqual([
            [said.id, REDACTED_BODY],
            [reply.id, text('それは控えておきます')],
        ]);
        expect(JSON.stringify(outbox)).not.toContain('090-0000-0000');
    });

    test('leaves what it does not hold, of another session, or redacted already', async () => {
        const { use, session, redaction } = await open();
        const said = value(await use.sendMessage({ session, actor: facilitator, targets: [], body: text('一度だけ') })).request;
        expect(
            await redaction.redactMessages([
                { session: 'another-session', message: said.id },
                { session, message: 'not-a-uuid' },
                { session, message: '00000000-0000-4000-8000-0000000000ff' },
            ]),
        ).toEqual({ requests: [], sessions: [] });
        expect((await redaction.redactMessages([{ session, message: said.id }])).requests).toEqual([said.id]);
        const first = value(await use.sessionState({ session })).requests[0]?.redactedAt;
        expect((await redaction.redactMessages([{ session, message: said.id }])).requests).toEqual([]);
        expect(value(await use.sessionState({ session })).requests[0]?.redactedAt).toEqual(first);
    });

    test('leaves no copy of the text in the database file or its WAL', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-redaction-'));
        try {
            const file = path.join(dir, 'session.db');
            const { use, session, db, redaction } = await open(file);
            const secret = '山田さんの携帯は 090-1234-5678';
            const said = value(await use.sendMessage({ session, actor: facilitator, targets: [], body: text(secret) })).request;
            value(await use.queueRun({ session, requests: [said.id], actor: facilitator }));
            // many more messages, so that pages are rewritten and freed
            for (let i = 0; i < 50; i++)
                value(await use.sendMessage({ session, actor: facilitator, targets: [], body: text(`メッセージ ${i} ${'あ'.repeat(200)}`) }));
            const bytes = async (): Promise<Buffer> =>
                Buffer.concat(await Promise.all([file, `${file}-wal`].map((f) => readFile(f).catch(() => Buffer.alloc(0)))));
            expect((await bytes()).includes(Buffer.from('090-1234-5678'))).toBe(true);
            await redaction.redactMessages([{ session, message: said.id }]);
            expect((await bytes()).includes(Buffer.from('090-1234-5678'))).toBe(false);
            db.close();
            expect((await bytes()).includes(Buffer.from('090-1234-5678'))).toBe(false);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
