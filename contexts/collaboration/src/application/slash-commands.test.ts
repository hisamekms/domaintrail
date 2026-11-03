// The use cases of the candidate and answer commands of the `/` list over the real store (in-memory SQLite): start
// (the facilitator only for a candidate command, anyone for an answer command; one of a kind at a time), no triage, the
// answerer's candidates or answer, a subset applied as one run whose input carries them, stop, a reload, and what the
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
const carolId = value(C.makeParticipantId('dev:carol'));
const facilitator: Actor = { kind: 'participant', participant: facilitatorId, role: 'Facilitator' };
const bob: Actor = { kind: 'participant', participant: bobId, role: 'Participant' };
const carol: Actor = { kind: 'participant', participant: carolId, role: 'Participant' };
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

/** A Collab session with Bob and Carol joined. */
async function collab(): Promise<{ use: CollaborationUseCases; session: C.SessionId; db: ReturnType<typeof openDatabase> }> {
    const { use, db } = collaboration();
    const opened = value(await use.openSession({ mode: 'Collab', facilitator: facilitatorId, name }));
    value(await use.joinSession({ session: opened.session.id, participant: bobId, name: value(C.makeDisplayName('Bob')) }));
    value(await use.joinSession({ session: opened.session.id, participant: carolId, name: value(C.makeDisplayName('Carol')) }));
    return { use, session: opened.session.id, db };
}

async function solo(): Promise<{ use: CollaborationUseCases; session: C.SessionId; db: ReturnType<typeof openDatabase> }> {
    const { use, db } = collaboration();
    const session = value(await use.openSession({ mode: 'Solo', facilitator: facilitatorId, name })).session.id;
    return { use, session, db };
}

const inView: C.ViewedAt = {
    view: { kind: 'Storming', storming: value(C.makeStormingName('Orders')), level: 'BigPicture', stage: value(C.makeStageName('Payment')), exceptions: true },
};

const start = (use: CollaborationUseCases, session: C.SessionId, actor: Actor = facilitator, viewedAt: C.ViewedAt | null = inView) =>
    use.startCommand({ session, actor, kind: 'EsExceptions', body: text('例外を洗い出す'), language: 'Ja', ...(viewedAt && { viewedAt }) });

const nextAnswer: C.NextAnswer = {
    status: value(C.makeProposalText('発行まで')),
    steps: [
        { text: value(C.makeProposalText('例外を洗い出す')), reason: value(C.makeProposalText('発行に例外がない')), command: 'EsExceptions' },
        { text: value(C.makeProposalText('専門家に聞く')), reason: value(C.makeProposalText('未決のホットスポット')) },
    ],
};

const candidate = (label: string): C.CommandCandidate => ({
    label: value(C.makeCandidateLabel(label)),
    targets: [{ kind: 'DtesElement', storming: value(C.makeStormingName('Orders')), local: value(C.makeStormingLocalName('OrderPaid')) }],
    how: value(C.makeProposalText(`OrderPaid から: ${label}`)),
});

describe('candidate commands', () => {
    test('start: the opening message without triage, its job due, about the storming in view; one of a kind; Collab: anyone', async () => {
        const { use, session } = await solo();
        const started = value(await start(use, session));
        expect(started.request).toMatchObject({ author: facilitatorId, body: '例外を洗い出す', viewedAt: inView });
        expect(started.command).toMatchObject({ state: 'Working', kind: 'EsExceptions', scope: 'Orders', opening: started.request.id });
        expect(value(await use.sessionState({ session })).triages).toEqual([]);
        expect(value(await use.commandJobs({ session })).map((j) => j.request.id)).toEqual([started.request.id]);
        expect(error(await start(use, session))).toEqual({ type: 'CommandAlreadyRunning' });

        const c = await collab();
        expect(value(await start(c.use, c.session, bob)).command).toMatchObject({ state: 'Working', startedBy: bobId });
        expect(error(await start(c.use, c.session))).toEqual({ type: 'CommandAlreadyRunning' });
    });

    test('no storming in view: no candidates at once, no job; its starter closes it', async () => {
        const { use, session } = await solo();
        const started = value(await start(use, session, facilitator, null));
        expect(started.command).toMatchObject({ state: 'Listed', candidates: [] });
        expect(started.command.scope).toBeUndefined();
        expect(value(await use.commandJobs({ session }))).toEqual([]);
        expect(value(await use.stopCommand({ command: started.command.id, actor: facilitator }))).toMatchObject({ state: 'Stopped' });
    });

    test('listed, then a subset applied: one run on the opening whose input carries the chosen; the facilitator only', async () => {
        const { use, session } = await collab();
        const started = value(await start(use, session));
        const id = started.command.id;
        expect(error(await use.answerCommand({ command: id, answer: text('x') }))).toEqual({ type: 'WrongCommandType' });
        const listed = value(await use.listCandidates({ command: id, candidates: ['A', 'B', 'C'].map(candidate) }));
        expect(listed).toMatchObject({ state: 'Listed' });
        expect(value(await use.commandJobs({ session }))).toEqual([]);
        expect(error(await use.applyCandidates({ command: id, actor: bob, chosen: [0] }))).toEqual({ type: 'FacilitatorOnly' });
        expect(error(await use.applyCandidates({ command: id, actor: facilitator, chosen: [3] }))).toEqual({ type: 'NoSuchCandidate' });
        expect(error(await use.applyCandidates({ command: id, actor: facilitator, chosen: [] }))).toEqual({ type: 'NoSuchCandidate' });
        const applied = value(await use.applyCandidates({ command: id, actor: facilitator, chosen: [2, 0, 2] }));
        expect(applied.command).toMatchObject({ state: 'Applied', chosen: [0, 2], appliedBy: facilitatorId, run: applied.run.id });
        expect(applied.run.input.requests.map((r) => r.request)).toEqual([started.request.id]);
        expect(applied.run.input.candidates as unknown).toEqual({
            command: id,
            kind: 'EsExceptions',
            scope: 'Orders',
            chosen: [candidate('A'), candidate('C')],
        });
        const soFar = value(await use.sessionSoFar({ session }));
        expect(soFar.text).toContain('ran /es:exceptions on @{es:Orders}');
        expect(soFar.text).toContain('applied 2 of the 3 candidates of /es:exceptions');
        expect(soFar.text).toContain('- A (@{es:Orders/OrderPaid}): OrderPaid から: A');
        // ended: another one may start
        value(await start(use, session));
    });

    test('stop while the AI works; a reload reads it back; the session so far tells what is open', async () => {
        const { use, session, db } = await solo();
        const started = value(await start(use, session));
        expect(value(await use.sessionSoFar({ session })).open).toEqual([expect.stringContaining('The command /es:exceptions')]);
        const stopped = value(await use.stopCommand({ command: started.command.id, actor: facilitator }));
        expect(stopped).toMatchObject({ state: 'Stopped', stoppedBy: facilitatorId });
        expect(error(await use.stopCommand({ command: started.command.id, actor: facilitator }))).toMatchObject({ type: 'NotAllowed' });
        expect(error(await use.listCandidates({ command: started.command.id, candidates: [] }))).toMatchObject({ type: 'NotAllowed' });
        const again = await createUnitOfWork(db).transaction((s) => s.slashCommands.listBySession(session));
        expect(again.map((c) => c.state)).toEqual(['Stopped']);
        expect(value(await use.sessionState({ session })).slashCommands.map((c) => c.state)).toEqual(['Stopped']);
    });
});

describe('a candidate command a participant started', () => {
    test('only the facilitator applies it (the approval); the starter cannot; a reload reads who applied', async () => {
        const { use, session, db } = await collab();
        const started = value(await start(use, session, bob));
        const id = started.command.id;
        value(await use.listCandidates({ command: id, candidates: ['A', 'B'].map(candidate) }));
        expect(value(await use.sessionSoFar({ session })).open).toContainEqual(expect.stringContaining("await the facilitator's choice"));
        expect(error(await use.applyCandidates({ command: id, actor: bob, chosen: [0] }))).toEqual({ type: 'FacilitatorOnly' });
        expect(error(await use.applyCandidates({ command: id, actor: carol, chosen: [0] }))).toEqual({ type: 'FacilitatorOnly' });
        const applied = value(await use.applyCandidates({ command: id, actor: facilitator, chosen: [1] }));
        expect(applied.command).toMatchObject({ state: 'Applied', startedBy: bobId, appliedBy: facilitatorId, chosen: [1] });
        expect(applied.run).toMatchObject({ queuedBy: facilitatorId });
        expect(value(await use.sessionSoFar({ session })).text).toContain('Ada applied 1 of the 2 candidates of /es:exceptions');
        const back = await createUnitOfWork(db).transaction((s) => s.slashCommands.listBySession(session));
        expect(back[0]).toMatchObject({ state: 'Applied', appliedBy: facilitatorId });
    });

    test('stop: its starter or the facilitator, no one else', async () => {
        const { use, session } = await collab();
        const first = value(await start(use, session, bob));
        expect(error(await use.stopCommand({ command: first.command.id, actor: carol }))).toEqual({ type: 'NotTheStarter' });
        expect(value(await use.stopCommand({ command: first.command.id, actor: facilitator }))).toMatchObject({ state: 'Stopped', stoppedBy: facilitatorId });
        const second = value(await start(use, session, bob));
        value(await use.listCandidates({ command: second.command.id, candidates: [candidate('A')] }));
        expect(value(await use.stopCommand({ command: second.command.id, actor: bob }))).toMatchObject({ state: 'Stopped', stoppedBy: bobId });
    });
});

describe('answer commands', () => {
    test('anyone starts one; its answer is a message of the AI replying to the opening', async () => {
        const { use, session } = await collab();
        const started = value(await use.startCommand({ session, actor: bob, kind: 'EsRecap', body: text('ここまでのまとめ'), language: 'Ja' }));
        expect(started.command).toMatchObject({ state: 'Working', kind: 'EsRecap' });
        expect(started.command.scope).toBeUndefined();
        expect(value(await use.sessionState({ session })).triages).toEqual([]);
        expect(error(await use.listCandidates({ command: started.command.id, candidates: [] }))).toEqual({ type: 'WrongCommandType' });
        const answered = value(await use.answerCommand({ command: started.command.id, answer: text('**決まったこと**\n- なし') }));
        expect(answered.answer).toMatchObject({
            author: AI_PARTICIPANT_ID,
            replyTo: { kind: 'Message', request: started.request.id },
            body: '**決まったこと**\n- なし',
        });
        expect(answered.command).toMatchObject({ state: 'Answered', answer: answered.answer.id });
        expect(answered.command.next).toBeUndefined();
        expect(value(await use.commandJobs({ session }))).toEqual([]);
        // the next steps are /hint's only
        const again = value(await use.startCommand({ session, actor: bob, kind: 'EsRecap', body: text('ここまでのまとめ'), language: 'Ja' }));
        expect(error(await use.answerCommand({ command: again.command.id, answer: text('x'), next: nextAnswer }))).toEqual({ type: 'WrongCommandType' });
    });

    test("/hint: anyone's, from the storming in view or none; answered with its steps, kept for the page and read back", async () => {
        const { use, session, db } = await solo();
        const started = value(
            await use.startCommand({ session, actor: facilitator, kind: 'Hint', body: text('ヒントをもらう'), language: 'Ja', viewedAt: inView }),
        );
        // the view is on its opening message (the AI reads it there): the command is about no storming of its own
        expect(started.command).toMatchObject({ state: 'Working', kind: 'Hint' });
        expect(started.command.scope).toBeUndefined();
        expect(started.request.viewedAt).toEqual(inView);
        expect(error(await use.answerCommand({ command: started.command.id, answer: text('x') }))).toEqual({ type: 'WrongCommandType' });
        const answered = value(await use.answerCommand({ command: started.command.id, answer: text('発行まで\n\n1. **例外**'), next: nextAnswer }));
        expect(answered.command).toMatchObject({ state: 'Answered', answer: answered.answer.id, next: nextAnswer });
        const back = await createUnitOfWork(db).transaction((s) => s.slashCommands.listBySession(session));
        expect(back[0]).toMatchObject({ state: 'Answered', next: nextAnswer });
    });

    test('/hint with no storming in view: a job for the AI all the same (it reads the session); one at a time', async () => {
        const { use, session } = await collab();
        const started = value(await use.startCommand({ session, actor: bob, kind: 'Hint', body: text('ヒントをもらう'), language: 'Ja' }));
        expect(started.command).toMatchObject({ state: 'Working', kind: 'Hint' });
        expect(value(await use.commandJobs({ session })).map((j) => j.command.id)).toEqual([started.command.id]);
        expect(error(await use.startCommand({ session, actor: bob, kind: 'Hint', body: text('ヒントをもらう'), language: 'Ja' }))).toEqual({
            type: 'CommandAlreadyRunning',
        });
        expect(value(await use.stopCommand({ command: started.command.id, actor: bob }))).toMatchObject({ state: 'Stopped' });
    });
});

describe('the candidate commands of phase 2', () => {
    test('/es:gaps, /es:levels and /es:names: anyone starts them, about the storming in view, applied as /es:exceptions is', async () => {
        for (const kind of ['EsGaps', 'EsLevels', 'EsNames'] as const) {
            const { use, session } = await collab();
            const started = value(await use.startCommand({ session, actor: bob, kind, body: text('x'), language: 'Ja', viewedAt: inView }));
            expect(started.command).toMatchObject({ state: 'Working', kind, scope: 'Orders' });
            value(await use.listCandidates({ command: started.command.id, candidates: [candidate('A')] }));
            const applied = value(await use.applyCandidates({ command: started.command.id, actor: facilitator, chosen: [0] }));
            expect(applied.run.input.candidates).toMatchObject({ kind, scope: 'Orders', chosen: [candidate('A')] });
        }
    });
});
