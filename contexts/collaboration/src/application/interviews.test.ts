// The use cases of the `/` commands' interviews (the plan's round 5 and "How journeys begin") over the real store
// (in-memory SQLite) and a journey file in memory: start (anyone, one at a time), the starter's messages going to the
// interview without triage while others are triaged, the interviewer's questions and brief, confirm (the facilitator:
// dt writes the journey — an ES journey created or revised, a modeling journey new or continued — and a new storming
// takes a run; for a participant's interview, the approval), reject and stop, and what the session so far says of them.
import { describe, expect, test } from 'bun:test';
import { Collaboration as C, type Result } from '../generated/index.js';
import { AI_PARTICIPANT_ID } from '../domain/ai.js';
import { sha256Hex } from '../domain/sha256.js';
import { createUnitOfWork, openDatabase } from '../infrastructure/sqlite.js';
import type { Actor } from './actor.js';
import type { CollaborationDeps } from './ports.js';
import { createCollaboration, type CollaborationUseCases } from './use-cases.js';
import { readJourney, writeJourney } from '../domain/journey.js';
import type { JourneyFileStore } from './ports.js';

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
const carolId = value(C.makeParticipantId('dev:carol'));
const facilitator: Actor = { kind: 'participant', participant: facilitatorId, role: 'Facilitator' };
const bob: Actor = { kind: 'participant', participant: bobId, role: 'Participant' };
const carol: Actor = { kind: 'participant', participant: carolId, role: 'Participant' };
const name = value(C.makeDisplayName('Ada'));

/** A journey file in memory: written only over the text read (as the real one). */
function memoryJourneys(initial?: string): JourneyFileStore & { text(): string | undefined } {
    let text = initial;
    return {
        read: async () => text,
        write: async (next, expected) => {
            if (text !== expected) return false;
            text = next;
            return true;
        },
        text: () => text,
    };
}

function collaboration(journeys = memoryJourneys()): { use: CollaborationUseCases; db: ReturnType<typeof openDatabase>; journeys: typeof journeys } {
    const files = new Map<string, Uint8Array>([['sales/order.dt', new TextEncoder().encode('context Sales {}\n')]]);
    const blobs = new Map<string, Uint8Array>();
    let t = Date.parse('2026-11-03T09:00:00Z');
    let n = 0;
    const db = openDatabase(':memory:');
    const deps: CollaborationDeps = {
        uow: createUnitOfWork(db),
        journeys,
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
    return { use: createCollaboration(deps), db, journeys };
}

/** A Collab session with Bob and Carol joined. */
async function collab(): Promise<{
    use: CollaborationUseCases;
    session: C.SessionId;
    db: ReturnType<typeof openDatabase>;
    journeys: ReturnType<typeof memoryJourneys>;
}> {
    const { use, db, journeys } = collaboration();
    const opened = value(await use.openSession({ mode: 'Collab', facilitator: facilitatorId, name }));
    value(await use.joinSession({ session: opened.session.id, participant: bobId, name: value(C.makeDisplayName('Bob')) }));
    value(await use.joinSession({ session: opened.session.id, participant: carolId, name: value(C.makeDisplayName('Carol')) }));
    return { use, session: opened.session.id, db, journeys };
}

const say = (
    use: CollaborationUseCases,
    session: C.SessionId,
    actor: Actor,
    body: string,
    extra: { mentions?: C.ParticipantId[]; replyTo?: C.ReplyTarget } = {},
) => use.sendMessage({ session, actor, targets: [], body: text(body), ...extra });

const esJourney = (over: Partial<C.JourneyBrief> = {}): C.JourneyBrief => ({
    purpose: value(C.makeBriefField('返金を早める')),
    scope: value(C.makeBriefField('申請から返金まで')),
    participants: [value(C.makeRoleName('窓口担当'))],
    use: 'Modeling',
    level: 'BigPicture',
    stormings: [],
    continues: false,
    ...over,
});

const brief = (over: Partial<C.InterviewBrief> = {}): C.InterviewBrief => ({
    name: value(C.makeBriefName('Returns')),
    label: value(C.makeBriefLabel('返品')),
    isNew: true,
    replaces: false,
    text: value(C.makeBriefText('目的: 返金を早める\n範囲: 申請から返金まで\n参加者: 窓口担当')),
    journey: esJourney(),
    description: value(C.makeShortDescription('返品の受付から返金まで')),
    ...over,
});

async function solo(
    journeys = memoryJourneys(),
): Promise<{ use: CollaborationUseCases; session: C.SessionId; db: ReturnType<typeof openDatabase>; journeys: ReturnType<typeof memoryJourneys> }> {
    const { use, db } = collaboration(journeys);
    const session = value(await use.openSession({ mode: 'Solo', facilitator: facilitatorId, name })).session.id;
    return { use, session, db, journeys };
}

const start = (use: CollaborationUseCases, session: C.SessionId, actor: Actor = facilitator) =>
    use.startInterview({ session, actor, command: 'Es', body: text('ES を始める'), language: 'Ja' });

describe('interviews', () => {
    test('start: the opening message without triage, the first question due; one at a time; Collab: anyone', async () => {
        const { use, session } = await solo();
        const started = value(await start(use, session));
        expect(started.request).toMatchObject({ author: facilitatorId, body: 'ES を始める' });
        expect(started.interview).toMatchObject({ state: 'Asking', command: 'Es', awaiting: started.request.id, opening: started.request.id, language: 'Ja' });
        const state = value(await use.sessionState({ session }));
        expect(state.triages).toEqual([]);
        expect(value(await use.interviewJobs({ session })).map((j) => [j.request.id, j.transcript.length])).toEqual([[started.request.id, 1]]);
        expect(error(await start(use, session))).toEqual({ type: 'InterviewAlreadyRunning' });

        // a participant starts one too; then it is the one running
        const c = await collab();
        const bobs = value(await start(c.use, c.session, bob));
        expect(bobs.interview).toMatchObject({ state: 'Asking', startedBy: bobId });
        expect(error(await start(c.use, c.session))).toEqual({ type: 'InterviewAlreadyRunning' });
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

    test('brief, then confirm: dt writes the journey (edited), a new storming takes a run; the facilitator only', async () => {
        const { use, session, journeys } = await collab();
        const started = value(await start(use, session));
        const briefed = value(await use.briefInterview({ interview: started.interview.id, answered: started.request.id, brief: brief() }));
        expect(briefed).toMatchObject({ state: 'Briefed', answered: started.request.id });
        expect(error(await use.confirmInterview({ interview: started.interview.id, actor: bob }))).toEqual({ type: 'FacilitatorOnly' });
        // a line without a known head is refused: nothing typed is lost
        expect(
            error(await use.confirmInterview({ interview: started.interview.id, actor: facilitator, text: value(C.makeBriefText('目的: x\nほか: y')) })),
        ).toMatchObject({
            type: 'InvalidBriefText',
        });
        expect(journeys.text()).toBeUndefined();
        const edited = value(C.makeBriefText('目的: 返金を3日以内に\n範囲: 申請から返金まで\n参加者: 窓口担当、経理'));
        const confirmed = value(await use.confirmInterview({ interview: started.interview.id, actor: facilitator, text: edited }));
        const run = confirmed.run;
        if (!run) throw new Error('a new storming takes a run');
        expect(confirmed.journey).toBe('es:Returns');
        expect(confirmed.interview).toMatchObject({ state: 'Confirmed', edited: true, confirmedBy: facilitatorId, run: run.id });
        expect(run.input.requests.map((r) => r.request)).toEqual([started.request.id]);
        expect(run.input.brief).toMatchObject({
            interview: started.interview.id,
            command: 'Es',
            brief: { name: 'Returns', text: edited, description: '返品の受付から返金まで' },
        });
        // the journey file: written by dt, the why as edited, how far as briefed
        expect(readJourney(journeys.text() ?? '').file.stormings).toEqual({
            Returns: {
                purpose: '返金を3日以内に',
                scope: '申請から返金まで',
                participants: ['窓口担当', '経理'],
                use: 'modeling',
                level: 'BigPicture',
                state: 'active',
                marks: [],
            },
        });
        // it is the session's current journey now
        expect(value(await use.sessionState({ session })).session.currentJourney as string | undefined).toBe('es:Returns');
        // ended: the starter's messages are triaged again
        expect(value(await say(use, session, facilitator, '@AI[p1] ありがとう', { mentions: [AI_PARTICIPANT_ID] })).triage).toBeDefined();
        const soFar = value(await use.sessionSoFar({ session }));
        expect(soFar.text).toContain('started the interview /es:start');
        expect(soFar.text).toContain('confirmed the brief of the interview /es:start after editing it');
        expect(soFar.text).toContain('目的: 返金を3日以内に');
    });

    test('/es:start on a storming with a journey revises its brief: no run, where it stands kept', async () => {
        const file = writeJourney({
            version: 1,
            stormings: { Returns: { purpose: '前の目的', participants: [], use: 'align', level: 'BigPicture', state: 'active', marks: ['questions'] } },
            modeling: [],
        });
        const { use, session, journeys } = await solo(memoryJourneys(file));
        const started = value(await start(use, session));
        const revised = brief({ isNew: false, replaces: true, journey: esJourney({ level: 'DesignLevel' }) });
        value(await use.briefInterview({ interview: started.interview.id, answered: started.request.id, brief: revised }));
        const confirmed = value(await use.confirmInterview({ interview: started.interview.id, actor: facilitator }));
        expect(confirmed.run).toBeUndefined();
        expect(confirmed.interview).toMatchObject({ state: 'Confirmed' });
        expect(readJourney(journeys.text() ?? '').file.stormings.Returns).toEqual({
            purpose: '返金を早める',
            scope: '申請から返金まで',
            participants: ['窓口担当'],
            use: 'modeling',
            level: 'DesignLevel',
            state: 'active',
            marks: ['questions'],
        });
    });

    test('/model:start: a new journey appended (its ID derived), one continued in place; no run either way', async () => {
        const { use, session, journeys } = await solo();
        const model = (b: C.InterviewBrief) => async (): Promise<string> => {
            const started = value(
                await use.startInterview({ session, actor: facilitator, command: 'Model', body: text('モデリングを始める'), language: 'Ja' }),
            );
            value(await use.briefInterview({ interview: started.interview.id, answered: started.request.id, brief: b }));
            const confirmed = value(await use.confirmInterview({ interview: started.interview.id, actor: facilitator }));
            expect(confirmed.run).toBeUndefined();
            return confirmed.journey;
        };
        const journey = (over: Partial<C.JourneyBrief>): C.JourneyBrief => ({
            purpose: value(C.makeBriefField('請求を正す')),
            participants: [],
            stormings: [],
            continues: false,
            pattern: 'OneContext',
            goal: value(C.makeGuideStepKey('invariants')),
            context: value(C.makeContextName('Billing')),
            journeyName: value(C.makeJourneyName('Billing の深掘り')),
            ...over,
        });
        const fresh = brief({ name: value(C.makeBriefName('billing')), label: undefined, description: undefined, journey: journey({}) });
        expect(await model(fresh)()).toBe('billing');
        // another new one of the same name: the next free ID
        expect(await model(fresh)()).toBe('billing-2');
        // continued: its goal changed, in place
        const cont = brief({
            name: value(C.makeBriefName('billing')),
            isNew: false,
            replaces: true,
            label: undefined,
            description: undefined,
            journey: journey({ continues: true, goal: value(C.makeGuideStepKey('commands')) }),
        });
        expect(await model(cont)()).toBe('billing');
        const file = readJourney(journeys.text() ?? '').file;
        expect(file.modeling.map((m) => [m.id, m.name, m.pattern, m.goal, m.from])).toEqual([
            ['billing', 'Billing の深掘り', 'OneContext', 'commands', { context: 'Billing' }],
            ['billing-2', 'Billing の深掘り', 'OneContext', 'invariants', { context: 'Billing' }],
        ]);
        expect(value(await use.sessionState({ session })).session.currentJourney as string | undefined).toBe('billing');
    });

    test('a journey file that does not read: nothing is written over it, the brief waits', async () => {
        const { use, session, journeys } = await solo(memoryJourneys('{ "version": 1, "stormings": { "Returns": {} } }'));
        const started = value(await start(use, session));
        value(await use.briefInterview({ interview: started.interview.id, answered: started.request.id, brief: brief() }));
        expect(error(await use.confirmInterview({ interview: started.interview.id, actor: facilitator }))).toMatchObject({ type: 'JourneyFileInvalid' });
        expect(journeys.text()).toBe('{ "version": 1, "stormings": { "Returns": {} } }');
        expect(value(await use.sessionState({ session })).interviews[0]?.state).toBe('Briefed');
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

describe('an interview a participant started', () => {
    /** Bob's interview, briefed after one answer of his. */
    async function briefedByBob() {
        const c = await collab();
        const started = value(await start(c.use, c.session, bob));
        const q1 = value(await c.use.askInInterview({ interview: started.interview.id, answered: started.request.id, question: text('どの業務？') }));
        // Bob answers (a choice is a message as any): heard; Carol's reply is triaged
        const answer = value(await say(c.use, c.session, bob, '返品', { replyTo: { kind: 'Message', request: q1.question.id } }));
        expect(answer.interview).toMatchObject({ state: 'Asking', awaiting: answer.request.id });
        expect(value(await say(c.use, c.session, carol, 'それって何？', { replyTo: { kind: 'Message', request: q1.question.id } })).interview).toBeUndefined();
        const briefed = value(await c.use.briefInterview({ interview: started.interview.id, answered: answer.request.id, brief: brief() }));
        return { ...c, started, answer, briefed };
    }

    test('its brief waits for the facilitator: the starter cannot confirm it; the facilitator approves it (edited)', async () => {
        const { use, session, started, answer } = await briefedByBob();
        expect(error(await use.confirmInterview({ interview: started.interview.id, actor: bob }))).toEqual({ type: 'FacilitatorOnly' });
        expect(error(await use.rejectInterview({ interview: started.interview.id, actor: bob }))).toEqual({ type: 'FacilitatorOnly' });
        expect(value(await use.sessionSoFar({ session })).open).toContainEqual(expect.stringContaining("awaits the facilitator's confirmation"));
        const edited = value(C.makeBriefText('目的: 返金を3日以内に'));
        const approved = value(await use.confirmInterview({ interview: started.interview.id, actor: facilitator, text: edited }));
        expect(approved.interview).toMatchObject({ state: 'Confirmed', startedBy: bobId, confirmedBy: facilitatorId, edited: true });
        // the new storming's run is queued by the facilitator, on the message the brief answered
        expect(approved.run).toMatchObject({ queuedBy: facilitatorId });
        expect(approved.run?.input.requests.map((r) => r.request)).toEqual([answer.request.id]);
        expect(value(await use.sessionSoFar({ session })).text).toContain("Ada approved Bob's brief of the interview /es:start after editing it");
    });

    test('the facilitator rejects its brief with a note: it ends, recorded; a reload reads it back', async () => {
        const { use, session, db, started } = await briefedByBob();
        const note = text('範囲が広すぎます');
        const rejected = value(await use.rejectInterview({ interview: started.interview.id, actor: facilitator, note }));
        expect(rejected).toMatchObject({ state: 'Rejected', rejectedBy: facilitatorId, note: '範囲が広すぎます', brief: brief() });
        expect(error(await use.rejectInterview({ interview: started.interview.id, actor: facilitator }))).toMatchObject({ type: 'NotAllowed' });
        expect(error(await use.confirmInterview({ interview: started.interview.id, actor: facilitator }))).toMatchObject({ type: 'NotAllowed' });
        const soFar = value(await use.sessionSoFar({ session }));
        expect(soFar.text).toContain("Ada rejected Bob's brief of the interview /es:start for Returns: 範囲が広すぎます");
        expect(soFar.open.filter((o) => o.includes('interview'))).toEqual([]);
        const again = await createUnitOfWork(db).transaction((s) => s.interviews.listBySession(session));
        expect(again).toMatchObject([{ state: 'Rejected', note: '範囲が広すぎます' }]);
        // ended: Bob's messages are triaged again, and another interview may start
        expect(value(await say(use, session, bob, '注文は取り消せる？')).interview).toBeUndefined();
        value(await start(use, session, carol));
    });

    test('stop: its starter or the facilitator, no one else', async () => {
        const { use, session } = await collab();
        const started = value(await start(use, session, bob));
        expect(error(await use.stopInterview({ interview: started.interview.id, actor: carol }))).toEqual({ type: 'NotTheInterviewer' });
        expect(value(await use.stopInterview({ interview: started.interview.id, actor: facilitator }))).toMatchObject({
            state: 'Stopped',
            stoppedBy: facilitatorId,
        });
        const second = value(await start(use, session, bob));
        expect(value(await use.stopInterview({ interview: second.interview.id, actor: bob }))).toMatchObject({ state: 'Stopped', stoppedBy: bobId });
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
