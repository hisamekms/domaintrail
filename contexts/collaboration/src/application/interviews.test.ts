// The use cases of the `/` commands' interviews (the plan's round 5) over the real store (in-memory SQLite): start (the
// facilitator only, one at a time), the starter's messages going to the interview without triage while others are
// triaged, the interviewer's questions and brief, confirm (a run whose input carries the brief) and stop, and what the
// session so far says of them.
import { describe, expect, test } from 'bun:test';
import { Collaboration as C, type Result } from '../generated/index.js';
import { AI_PARTICIPANT_ID } from '../domain/ai.js';
import { sha256Hex } from '../domain/sha256.js';
import { createUnitOfWork, openDatabase } from '../infrastructure/sqlite.js';
import type { Actor } from './actor.js';
import type { CollaborationDeps } from './ports.js';
import { createCollaboration, type CollaborationUseCases } from './use-cases.js';

const value = <T, E>(r: Result<T, E>): T => {
    if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
    return r.value;
};
const error = <T, E>(r: Result<T, E>): E => {
    if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.value)}`);
    return r.error;
};

const text = (t: string): C.Text => value(C.makeText(t));
const facilitatorId = value(C.makeParticipantId('local:facilitator'));
const bobId = value(C.makeParticipantId('dev:bob'));
const facilitator: Actor = { kind: 'participant', participant: facilitatorId, role: 'Facilitator' };
const bob: Actor = { kind: 'participant', participant: bobId, role: 'Participant' };
const name = value(C.makeDisplayName('Ada'));

function collaboration(): { use: CollaborationUseCases; db: ReturnType<typeof openDatabase> } {
    const files = new Map<string, Uint8Array>([['sales/order.dt', new TextEncoder().encode('context Sales {}\n')]]);
    const blobs = new Map<string, Uint8Array>();
    let t = Date.parse('2026-11-03T09:00:00Z');
    let n = 0;
    const db = openDatabase(':memory:');
    const deps: CollaborationDeps = {
        uow: createUnitOfWork(db),
        workspace: {
            read: async () => ({ files: [...files].map(([path, bytes]) => ({ path, bytes, hash: sha256Hex(bytes) })), symlinks: [] }),
            write: async () => ({ ok: true }),
        },
        blobs: {
            put: async (fs) => {
                for (const f of fs) blobs.set(f.hash, f.bytes);
            },
            get: async (hash) => blobs.get(hash),
        },
        validator: { validate: async () => ({ diagnostics: [], model: undefined, stormings: [], stormingsComplete: true }) },
        clock: { now: () => new Date((t += 1000)) },
        ids: { newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` },
    };
    return { use: createCollaboration(deps), db };
}

/** A Collab session with Bob joined. */
async function collab(): Promise<{ use: CollaborationUseCases; session: C.SessionId }> {
    const { use } = collaboration();
    const opened = value(await use.openSession({ mode: 'Collab', facilitator: facilitatorId, name }));
    value(await use.joinSession({ session: opened.session.id, participant: bobId, name: value(C.makeDisplayName('Bob')) }));
    return { use, session: opened.session.id };
}

const say = (
    use: CollaborationUseCases,
    session: C.SessionId,
    actor: Actor,
    body: string,
    extra: { mentions?: C.ParticipantId[]; replyTo?: C.ReplyTarget } = {},
) => use.sendMessage({ session, actor, targets: [], body: text(body), ...extra });

const brief = (over: Partial<C.InterviewBrief> = {}): C.InterviewBrief => ({
    name: value(C.makeBriefName('Returns')),
    label: value(C.makeBriefLabel('返品')),
    isNew: true,
    replaces: false,
    text: value(C.makeBriefText('目的: 返金を早める\n範囲: 申請から返金まで\n使い道: モデリングへ\nレベル: Big Picture')),
    ...over,
});

async function solo(): Promise<{ use: CollaborationUseCases; session: C.SessionId; db: ReturnType<typeof openDatabase> }> {
    const { use, db } = collaboration();
    const session = value(await use.openSession({ mode: 'Solo', facilitator: facilitatorId, name })).session.id;
    return { use, session, db };
}

const start = (use: CollaborationUseCases, session: C.SessionId, actor: Actor = facilitator) =>
    use.startInterview({ session, actor, command: 'Es', body: text('ES を始める'), language: 'Ja' });

describe('interviews', () => {
    test('start: the opening message without triage, the first question due; one at a time; Collab: the facilitator only', async () => {
        const { use, session } = await solo();
        const started = value(await start(use, session));
        expect(started.request).toMatchObject({ author: facilitatorId, body: 'ES を始める' });
        expect(started.interview).toMatchObject({ state: 'Asking', command: 'Es', awaiting: started.request.id, opening: started.request.id, language: 'Ja' });
        const state = value(await use.sessionState({ session }));
        expect(state.triages).toEqual([]);
        expect(value(await use.interviewJobs({ session })).map((j) => [j.request.id, j.transcript.length])).toEqual([[started.request.id, 1]]);
        expect(error(await start(use, session))).toEqual({ type: 'InterviewAlreadyRunning' });

        const c = await collab();
        expect(error(await start(c.use, c.session, bob))).toEqual({ type: 'FacilitatorOnly' });
        expect(value(await c.use.sessionState({ session: c.session })).requests).toEqual([]);
        value(await start(c.use, c.session));
    });

    test('while it runs the starter answers it without triage; the others are triaged as usual', async () => {
        const { use, session } = await collab();
        const started = value(await start(use, session));
        const q1 = value(await use.askInInterview({ interview: started.interview.id, answered: started.request.id, question: text('どの業務？') }));
        expect(q1.question).toMatchObject({ author: AI_PARTICIPANT_ID, replyTo: { kind: 'Message', request: started.request.id } });
        expect(q1.interview.awaiting).toBeUndefined();
        expect(value(await use.interviewJobs({ session }))).toEqual([]);
        // the starter's reply to the question: heard, no triage
        const answer = value(await say(use, session, facilitator, '返品', { replyTo: { kind: 'Message', request: q1.question.id } }));
        expect(answer.triage).toBeUndefined();
        expect(answer.interview).toMatchObject({ state: 'Asking', awaiting: answer.request.id });
        // Bob's reply to the AI's question is addressed to the AI: triaged
        const other = value(await say(use, session, bob, 'それって何？', { replyTo: { kind: 'Message', request: q1.question.id } }));
        expect(other.interview).toBeUndefined();
        expect(other.triage).toMatchObject({ addressedBy: 'Reply' });
        const [job] = value(await use.interviewJobs({ session }));
        expect(job.transcript.map((r): string => r.body)).toEqual(['ES を始める', 'どの業務？', '返品']);
        // a question to a message the interview no longer waits for writes nothing
        const again = value(await say(use, session, facilitator, 'やっぱり交換も'));
        expect(error(await use.askInInterview({ interview: started.interview.id, answered: answer.request.id, question: text('?') }))).toEqual({
            type: 'InterviewMovedOn',
        });
        expect(value(await use.interviewJobs({ session })).map((j) => j.request.id)).toEqual([again.request.id]);
    });

    test('a question with choices: kept on the interview until its starter answers (and in the stored session)', async () => {
        const { use, session } = await solo();
        const started = value(await start(use, session));
        const choices = ['返品', '交換'].map((c) => value(C.makeAnswerChoice(c)));
        const q1 = value(await use.askInInterview({ interview: started.interview.id, answered: started.request.id, question: text('どの業務？'), choices }));
        expect(q1.interview.asked).toEqual({ question: q1.question.id, choices, multiple: false });
        const stored = value(await use.sessionState({ session })).interviews?.[0];
        expect(stored).toMatchObject({ state: 'Asking', asked: { question: q1.question.id, choices: ['返品', '交換'], multiple: false } });
        const answer = value(await say(use, session, facilitator, '返品', { replyTo: { kind: 'Message', request: q1.question.id } }));
        expect(answer.interview?.asked).toBeUndefined();
        // `multiple` only with choices
        const q2 = value(await use.askInInterview({ interview: started.interview.id, answered: answer.request.id, question: text('なぜ？'), multiple: true }));
        expect(q2.interview.asked).toEqual({ question: q2.question.id, choices: [], multiple: false });
    });

    test('brief, then confirm: a run whose input carries the brief (edited); the starter only', async () => {
        const { use, session } = await collab();
        const started = value(await start(use, session));
        const briefed = value(await use.briefInterview({ interview: started.interview.id, answered: started.request.id, brief: brief() }));
        expect(briefed).toMatchObject({ state: 'Briefed', answered: started.request.id });
        expect(error(await use.confirmInterview({ interview: started.interview.id, actor: bob }))).toEqual({ type: 'NotTheInterviewer' });
        const edited = value(C.makeBriefText('目的: 返金を3日以内に\n範囲: 申請から返金まで'));
        const confirmed = value(await use.confirmInterview({ interview: started.interview.id, actor: facilitator, text: edited }));
        expect(confirmed.interview).toMatchObject({ state: 'Confirmed', edited: true, run: confirmed.run.id });
        expect(confirmed.run.input.requests.map((r) => r.request)).toEqual([started.request.id]);
        expect(confirmed.run.input.brief).toEqual({ interview: started.interview.id, command: 'Es', brief: { ...brief(), text: edited } });
        // ended: the starter's messages are triaged again
        expect(value(await say(use, session, facilitator, '@AI[p1] ありがとう', { mentions: [AI_PARTICIPANT_ID] })).triage).toBeDefined();
        const soFar = value(await use.sessionSoFar({ session }));
        expect(soFar.text).toContain('started the interview /es:start');
        expect(soFar.text).toContain('confirmed the brief of the interview /es:start after editing it');
        expect(soFar.text).toContain('目的: 返金を3日以内に');
    });

    test('a word on the brief takes it back to asking; stop ends it (the starter only); a reload reads it back', async () => {
        const { use, session, db } = await solo();
        const started = value(await start(use, session));
        value(await use.briefInterview({ interview: started.interview.id, answered: started.request.id, brief: brief() }));
        const more = value(await say(use, session, facilitator, '範囲に交換も入れて'));
        expect(more.interview).toMatchObject({ state: 'Asking', awaiting: more.request.id });
        expect(value(await use.sessionSoFar({ session })).open).toEqual([expect.stringContaining('The interview /es:start')]);
        const stopped = value(await use.stopInterview({ interview: started.interview.id, actor: facilitator }));
        expect(stopped).toMatchObject({ state: 'Stopped', stoppedBy: facilitatorId });
        expect(error(await use.stopInterview({ interview: started.interview.id, actor: facilitator }))).toMatchObject({ type: 'NotAllowed' });
        // stored: another unit of work on the same database reads it
        const again = await createUnitOfWork(db).transaction((s) => s.interviews.listBySession(session));
        expect(again.map((i) => i.state)).toEqual(['Stopped']);
        expect(value(await say(use, session, facilitator, '注文は取り消せる？')).triage).toBeDefined();
    });
});

describe('the view an interview was started from', () => {
    test('kept on its opening message, which the interviewer’s job carries', async () => {
        const { use, session } = await solo();
        const viewedAt: C.ViewedAt = { view: { kind: 'Structure', level: 'Detail', focus: [value(C.makeContextName('Sales'))] } };
        const started = value(
            await use.startInterview({ session, actor: facilitator, command: 'Model', body: text('モデリングを始める'), language: 'Ja', viewedAt }),
        );
        expect(started.request.viewedAt).toEqual(viewedAt);
        expect(value(await use.interviewJobs({ session }))[0]?.request.viewedAt).toEqual(viewedAt);
        const other = await solo();
        expect(value(await start(other.use, other.session)).request.viewedAt).toBeUndefined();
    });
});
