// The use cases of who talks to the AI (ADR 0030) over the real store (in-memory SQLite), with a workspace and blobs in
// memory and a validator that finds nothing: the modes, addressing, the triage's records, answers, proposals and the
// queue, the runner's correction, and the session so far.
import { describe, expect, test } from 'bun:test';
import { Collaboration as C, type Result } from '../generated/index.js';
import { AI_PARTICIPANT_ID } from '../domain/ai.js';
import { sha256Hex } from '../domain/sha256.js';
import { toAgentReply } from '../domain/reply.js';
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
const order: C.ModelTarget = { kind: 'DtElement', element: value(C.makeElementName('Sales.Order')) };
const content = (how: string): C.ProposalContent => ({ targets: [order], how: value(C.makeProposalText(how)), options: [] });
const sticky: C.ModelTarget = { kind: 'DtesElement', storming: value(C.makeStormingName('Orders')), local: value(C.makeStormingLocalName('Order')) };
/** A proposal with two options, the first recommended. */
const withOptions = (how: string): C.ProposalContent => ({
    ...content(how),
    targets: [],
    options: [
        { label: value(C.makeProposalLabel('集約だけ')), targets: [order], recommended: true },
        { label: value(C.makeProposalLabel('付箋も')), targets: [order, sticky], how: value(C.makeProposalText('付箋も揃える')), recommended: false },
    ],
});

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

const step = (stage: C.TriageStage, verdict: C.TriageVerdict) => ({
    stage,
    verdict,
    durationMs: 20,
    ...(stage === 'Model' && { confidence: 0.9, model: 'haiku', reason: 'reads as one' }),
});

/** Through stages 2 (unknown) and 3 (the verdict). */
async function triaged(use: CollaborationUseCases, triage: C.TriageId, verdict: C.TriageVerdict) {
    value(await use.recordTriageStep({ triage, step: step('Clef', 'Unknown') }));
    return value(await use.recordTriageStep({ triage, step: step('Model', verdict) }));
}

describe('the modes (decision 13)', () => {
    test('dt open starts and resumes a Solo session; dt collab continues it as Collab; dt open then refuses', async () => {
        const { use } = collaboration();
        const solo = value(await use.openSession({ mode: 'Solo', facilitator: facilitatorId, name }));
        expect([solo.opened, solo.session.mode, solo.revision?.origin.kind]).toEqual(['started', 'Solo', 'SessionStart']);
        expect(value(await use.openSession({ mode: 'Solo', facilitator: facilitatorId, name })).opened).toBe('resumed');
        // no one else joins a Solo session
        expect(error(await use.joinSession({ session: solo.session.id, participant: bobId, name }))).toEqual({ type: 'SoloSession' });
        const together = value(await use.openSession({ mode: 'Collab', facilitator: facilitatorId, name }));
        expect([together.opened, together.session.id, together.session.mode, together.session.facilitator]).toEqual([
            'collaborated',
            solo.session.id,
            'Collab',
            facilitatorId,
        ]);
        const events = await use.eventsAfter({ session: solo.session.id, cursor: 0, limit: 100 });
        expect(events.map((e) => e.event.type)).toEqual(['SessionStarted', 'RevisionRecorded', 'SessionCollaborated']);
        expect(error(await use.openSession({ mode: 'Solo', facilitator: facilitatorId, name }))).toEqual({ type: 'CollabSessionOpen' });
        expect(value(await use.openSession({ mode: 'Collab', facilitator: facilitatorId, name })).opened).toBe('resumed');
        expect(value(await use.joinSession({ session: solo.session.id, participant: bobId, name })).joined).toBe(true);
    });
});

describe('addressing and stage 1', () => {
    test('Solo: every message is addressed; a thanks is "neither" at once, anything else waits for the next stage', async () => {
        const { use } = collaboration();
        const session = value(await use.openSession({ mode: 'Solo', facilitator: facilitatorId, name })).session.id;
        const thanks = value(await say(use, session, facilitator, 'ありがとう！'));
        expect(thanks.triage).toMatchObject({ state: 'Decided', kind: 'NotForAi', decidedBy: 'Mechanical', addressedBy: 'Solo' });
        expect(thanks.triage?.steps[0]).toMatchObject({ stage: 'Mechanical', verdict: 'NotForAi', reason: '決まった相づち' });
        const ask = value(await say(use, session, facilitator, '注文は取り消せる？'));
        expect(ask.triage).toMatchObject({ state: 'Pending', addressedBy: 'Solo', addressedByParticipant: facilitatorId });
        expect(ask.triage?.steps.map((s) => [s.stage, s.verdict])).toEqual([['Mechanical', 'Unknown']]);
    });

    test('Collab: talk is not addressed; a mention of the AI and a reply to the AI are; no one sends as the AI', async () => {
        const { use, session } = await collab();
        expect(value(await say(use, session, bob, 'お昼どうする？')).triage).toBeUndefined();
        const asked = value(await say(use, session, bob, '@AI[p1] 注文は取り消せる？', { mentions: [AI_PARTICIPANT_ID] }));
        expect(asked.request.mentions).toEqual([AI_PARTICIPANT_ID]);
        expect(asked.triage).toMatchObject({ state: 'Pending', addressedBy: 'Mention', addressedByParticipant: bobId });
        const consultation = (await triaged(use, asked.triage?.id ?? ('' as C.TriageId), 'Consultation')).triage;
        expect(consultation).toMatchObject({ state: 'Decided', kind: 'Consultation', decidedBy: 'Model' });
        const answered = value(await use.answerMessage({ triage: consultation.id, body: text('確定前だけです。') }));
        const reply = value(await say(use, session, bob, 'なぜ？', { replyTo: { kind: 'Message', request: answered.answer.id } }));
        expect(reply.triage?.addressedBy).toBe('Reply');
        const ai: Actor = { kind: 'participant', participant: AI_PARTICIPANT_ID, role: 'Participant' };
        expect(error(await say(use, session, ai, 'I am the AI'))).toEqual({ type: 'NotAParticipant', participant: AI_PARTICIPANT_ID });
        // the page's path of today: sent, not addressed
        const legacy = value(await use.sendRequest({ session, actor: bob, targets: [], body: text('@AI[p1] x'), mentions: [AI_PARTICIPANT_ID] }));
        expect(value(await use.sessionState({ session })).triages.some((t) => t.request === legacy.id)).toBe(false);
    });
});

describe('the triage and where it goes', () => {
    test('a 相談 is answered by the AI: its message replies to the addressed one, and the triage records it with the revision it read', async () => {
        const { use, session } = await collab();
        const asked = value(await say(use, session, bob, '@AI[p1] 注文は取り消せる？', { mentions: [AI_PARTICIPANT_ID] }));
        const triage = asked.triage?.id ?? ('' as C.TriageId);
        expect(error(await use.answerMessage({ triage, body: text('early') }))).toEqual({ type: 'NotAllowed', command: 'answer', state: 'Pending' });
        await triaged(use, triage, 'Unknown');
        const jobs = value(await use.answerJobs({ session }));
        expect(jobs.map((j) => [j.kind, j.request.id])).toEqual([['answer', asked.request.id]]);
        const read = value(await use.sessionState({ session })).revisions[0]?.id;
        const answered = value(await use.answerMessage({ triage, body: text('確定前だけです。'), ...(read && { readRevision: read }) }));
        expect(answered.answer).toMatchObject({
            author: AI_PARTICIPANT_ID,
            replyTo: { kind: 'Message', request: asked.request.id },
            targets: [],
            mentions: [],
        });
        expect(answered.triage.outcome).toEqual({ kind: 'Answer', answer: answered.answer.id, readRevision: read });
        expect(value(await use.answerJobs({ session }))).toEqual([]);
        expect(error(await use.answerMessage({ triage, body: text('again') }))).toEqual({ type: 'TriageAlreadyConcluded' });
        expect(error(await use.answerMessage({ triage, body: text('x'.repeat(2001)) }))).toEqual({ type: 'AnswerTooLong', limit: 2000 });
        // no revision is recorded for an answer
        expect(value(await use.sessionState({ session })).revisions).toHaveLength(1);
    });

    test('a participant’s 依頼 becomes a proposal; approved together, proposals are one run; the facilitator alone decides', async () => {
        const { use, session } = await collab();
        const ids: C.ChangeProposalId[] = [];
        for (const body of ['@AI[p1] 取り消しを足して', '@AI[p1] 返品も足して']) {
            const sent = value(await say(use, session, bob, body, { mentions: [AI_PARTICIPANT_ID] }));
            const triage = sent.triage?.id ?? ('' as C.TriageId);
            const progress = await triaged(use, triage, 'ChangeRequest');
            expect([progress.route, progress.run]).toEqual(['propose', undefined]);
            expect(value(await use.answerJobs({ session })).map((j) => j.kind)).toEqual(['propose']);
            const proposed = value(await use.proposeChange({ triage, content: ids.length === 0 ? content(body) : withOptions(body) }));
            expect(proposed.proposal).toMatchObject({ state: 'Open', request: sent.request.id, requestedBy: bobId });
            expect(proposed.triage.outcome).toEqual({ kind: 'Proposal', proposal: proposed.proposal.id });
            expect(error(await use.proposeChange({ triage, content: content(body) }))).toEqual({ type: 'TriageNotProposable', triage });
            ids.push(proposed.proposal.id);
        }
        const [plain = '' as C.ChangeProposalId, choice = '' as C.ChangeProposalId] = ids;
        expect(error(await use.approveProposals({ session, actor: bob, proposals: ids.map((proposal) => ({ proposal })) }))).toEqual({
            type: 'FacilitatorOnly',
        });
        // an option the proposal does not have, or one chosen of a proposal without options: refused, nothing approved
        const third = value(C.makeProposalOptionIndex(2));
        expect(error(await use.approveProposals({ session, actor: facilitator, proposals: [{ proposal: choice, option: third }] }))).toEqual({
            type: 'NoSuchOption',
        });
        const first = value(C.makeProposalOptionIndex(0));
        expect(error(await use.approveProposals({ session, actor: facilitator, proposals: [{ proposal: plain, option: first }] }))).toEqual({
            type: 'NoSuchOption',
        });
        const editedHow = value(C.makeProposalText('取り消しだけ'));
        const approved = value(
            await use.approveProposals({
                session,
                actor: facilitator,
                proposals: [
                    { proposal: plain, editedHow },
                    { proposal: choice, option: value(C.makeProposalOptionIndex(1)) },
                ],
            }),
        );
        expect(approved.run.input.requests).toHaveLength(2);
        // the run follows the edited how, and the chosen option's label, targets and how
        expect(approved.run.input.proposals?.approved.map((p): unknown => p.instruction)).toEqual([
            { targets: [order], how: editedHow },
            { label: '付箋も', targets: [order, sticky], how: '付箋も揃える' },
        ]);
        expect(approved.run.queuedBy).toBe(facilitatorId);
        expect(approved.proposals.map((p): unknown[] => [p.state, p.run, p.option, p.editedHow])).toEqual([
            ['Approved', approved.run.id, undefined, editedHow],
            ['Approved', approved.run.id, 1, undefined],
        ]);
        expect(error(await use.approveProposals({ session, actor: facilitator, proposals: [{ proposal: plain }] }))).toEqual({
            type: 'NotAllowed',
            command: 'approve',
            state: 'Approved',
        });
    });

    test('a proposal with options approved without one goes with the option the AI recommends', async () => {
        const { use, session } = await collab();
        const sent = value(await say(use, session, bob, '@AI[p1] 注文を受注に', { mentions: [AI_PARTICIPANT_ID] }));
        const triage = sent.triage?.id ?? ('' as C.TriageId);
        await triaged(use, triage, 'ChangeRequest');
        const proposal = value(await use.proposeChange({ triage, content: withOptions('ラベルを「受注」に変える') })).proposal.id;
        const approved = value(await use.approveProposals({ session, actor: facilitator, proposals: [{ proposal }] }));
        expect(approved.proposals[0]?.option).toBe(0 as C.ProposalOptionIndex);
        expect(approved.run.input.proposals?.approved[0]?.instruction as unknown).toEqual({
            label: '集約だけ',
            targets: [order],
            how: 'ラベルを「受注」に変える',
        });
    });

    test('a proposal can be rejected with a note, or withdrawn by its requester only', async () => {
        const { use, session } = await collab();
        const proposals: C.ChangeProposalId[] = [];
        for (const body of ['@AI[p1] 一つ目', '@AI[p1] 二つ目']) {
            const sent = value(await say(use, session, bob, body, { mentions: [AI_PARTICIPANT_ID] }));
            await triaged(use, sent.triage?.id ?? ('' as C.TriageId), 'ChangeRequest');
            proposals.push(value(await use.proposeChange({ triage: sent.triage?.id ?? ('' as C.TriageId), content: content(body) })).proposal.id);
        }
        const [first = '' as C.ChangeProposalId, second = '' as C.ChangeProposalId] = proposals;
        expect(error(await use.rejectProposal({ proposal: first, actor: bob }))).toEqual({ type: 'FacilitatorOnly' });
        expect(value(await use.rejectProposal({ proposal: first, actor: facilitator, note: text('今回は見送り') }))).toMatchObject({
            state: 'Rejected',
            note: '今回は見送り',
        });
        expect(error(await use.withdrawProposal({ proposal: second, actor: facilitator }))).toEqual({ type: 'NotTheRequester' });
        expect(value(await use.withdrawProposal({ proposal: second, actor: bob })).state).toBe('Withdrawn');
        expect(error(await use.withdrawProposal({ proposal: first, actor: bob }))).toEqual({ type: 'NotAllowed', command: 'withdraw', state: 'Rejected' });
    });

    test('the facilitator’s 依頼, a Solo 依頼, and a message the facilitator sent to the AI go straight to the queue', async () => {
        const { use, session } = await collab();
        const own = value(await say(use, session, facilitator, '@AI[p1] ID を足して', { mentions: [AI_PARTICIPANT_ID] }));
        const queued = await triaged(use, own.triage?.id ?? ('' as C.TriageId), 'ChangeRequest');
        expect(queued.route).toBe('queue');
        expect(queued.run).toMatchObject({ state: 'Queued', queuedBy: facilitatorId, input: { requests: [{ request: own.request.id }] } });
        expect(queued.triage.state === 'Decided' ? queued.triage.outcome : undefined).toEqual(queued.run && { kind: 'Run', run: queued.run.id });

        // 「AI に送る」 on a participant's plain message: addressed by the facilitator, then queued without a proposal (Q3)
        const plain = value(await say(use, session, bob, 'ここに返品を足したい'));
        expect(error(await use.addressMessages({ session, actor: bob, requests: [plain.request.id] }))).toEqual({ type: 'FacilitatorOnly' });
        const [addressed] = value(await use.addressMessages({ session, actor: facilitator, requests: [plain.request.id] }));
        expect(addressed).toMatchObject({ state: 'Pending', addressedBy: 'Facilitator', addressedByParticipant: facilitatorId });
        expect(error(await use.addressMessages({ session, actor: facilitator, requests: [plain.request.id] }))).toEqual({
            type: 'RequestAlreadyAddressed',
            request: plain.request.id,
        });
        const sent = await triaged(use, addressed?.id ?? ('' as C.TriageId), 'ChangeRequest');
        expect([sent.route, sent.run?.queuedBy]).toEqual(['queue', facilitatorId]);

        const solo = collaboration().use;
        const s = value(await solo.openSession({ mode: 'Solo', facilitator: facilitatorId, name })).session.id;
        const alone = value(await say(solo, s, facilitator, 'ID を足して'));
        expect((await triaged(solo, alone.triage?.id ?? ('' as C.TriageId), 'ChangeRequest')).route).toBe('queue');
    });

    test('「AI に送る」 again on a "neither" skips the cascade as 相談 (Q6); the AI’s own messages are not addressed', async () => {
        const { use, session } = await collab();
        const thanks = value(await say(use, session, bob, '@AI[p1] ありがとう', { mentions: [AI_PARTICIPANT_ID] }));
        expect(thanks.triage).toMatchObject({ kind: 'NotForAi', decidedBy: 'Mechanical' });
        const [again] = value(await use.addressMessages({ session, actor: facilitator, requests: [thanks.request.id] }));
        expect(again).toMatchObject({ state: 'Decided', kind: 'Consultation', decidedBy: 'Facilitator', addressedBy: 'Facilitator' });
        const answer = value(await use.answerMessage({ triage: again?.id ?? ('' as C.TriageId), body: text('どういたしまして') })).answer;
        expect(error(await use.addressMessages({ session, actor: facilitator, requests: [answer.id] }))).toEqual({
            type: 'RequestNotAddressable',
            request: answer.id,
        });
        expect(error(await use.addressMessages({ session, actor: facilitator, requests: [] }))).toEqual({ type: 'NoRequests' });
    });

    test('stages out of order and invalid inputs are refused; a decided triage takes no more stages', async () => {
        const { use, session } = await collab();
        const sent = value(await say(use, session, bob, '@AI[p1] どう思う？', { mentions: [AI_PARTICIPANT_ID] }));
        const triage = sent.triage?.id ?? ('' as C.TriageId);
        expect(error(await use.recordTriageStep({ triage, step: step('Mechanical', 'Unknown') }))).toEqual({ type: 'TriageStepOutOfOrder' });
        expect(error(await use.recordTriageStep({ triage, step: { ...step('Clef', 'Unknown'), confidence: 3 } }))).toMatchObject({
            type: 'InvalidTriageInput',
        });
        expect(error(await use.recordTriageStep({ triage, step: { ...step('Clef', 'Consultation'), error: 'timed out' } }))).toMatchObject({
            type: 'InvalidTriageInput',
        });
        const failed = value(await use.recordTriageStep({ triage, step: { ...step('Clef', 'Unknown'), error: 'timed out' } }));
        expect(failed.triage.steps.at(-1)).toMatchObject({ stage: 'Clef', verdict: 'Unknown', error: 'timed out' });
        value(await use.recordTriageStep({ triage, step: step('Model', 'Consultation') }));
        expect(error(await use.recordTriageStep({ triage, step: step('Model', 'Consultation') }))).toEqual({
            type: 'NotAllowed',
            command: 'record',
            state: 'Decided',
        });
        expect(
            error(await use.recordTriageStep({ triage: '00000000-0000-4000-8000-0000000000ff' as C.TriageId, step: step('Clef', 'Unknown') })),
        ).toMatchObject({ type: 'NotFound' });
    });
});

describe('overrides (decision 18)', () => {
    test('the answerer turns a participant’s 相談 into a proposal', async () => {
        const { use, session } = await collab();
        const sent = value(await say(use, session, bob, '@AI[p1] 取り消しはどう？', { mentions: [AI_PARTICIPANT_ID] }));
        const triage = sent.triage?.id ?? ('' as C.TriageId);
        await triaged(use, triage, 'Consultation');
        const progress = value(
            await use.overrideTriage({
                triage,
                step: { stage: 'Answerer', verdict: 'ChangeRequest', durationMs: 900, reason: 'asks for a change' },
                proposal: content('cancel'),
            }),
        );
        expect(progress.route).toBe('propose');
        expect(progress.proposal).toMatchObject({ state: 'Open', requestedBy: bobId });
        expect(progress.triage).toMatchObject({ kind: 'ChangeRequest', decidedBy: 'Answerer', outcome: { kind: 'Proposal' } });
        expect(error(await use.overrideTriage({ triage, step: { stage: 'Answerer', verdict: 'NotForAi', durationMs: 0 } }))).toEqual({
            type: 'TriageNotOverridable',
        });
    });

    test('the runner answers a queued 依頼 as a question: the run completes unchanged and the triage becomes a 相談', async () => {
        const { use, session } = await collab();
        const own = value(await say(use, session, facilitator, '@AI[p1] 取り消しはある？', { mentions: [AI_PARTICIPANT_ID] }));
        const run = (await triaged(use, own.triage?.id ?? ('' as C.TriageId), 'ChangeRequest')).run;
        expect(run).toBeDefined();
        const claimed = value(await use.claimNextRun({ session, owner: 'test', leaseMs: 60_000 }));
        value(await use.startRun({ run: claimed.run.id, token: claimed.lease.token }));
        const reply = toAgentReply({
            outcome: 'done',
            summary: 'It is a question.',
            requests: [{ request: own.request.id, status: 'answered' }],
            questions: [],
            assumptions: [],
            answer: 'Yes: Order.cancel.',
        });
        const finished = value(
            await use.finishRun({ run: claimed.run.id, token: claimed.lease.token, facts: { exitCode: 0, formatted: 'Skipped', checked: 'Skipped' }, reply }),
        );
        expect(finished.run).toMatchObject({ state: 'Completed', changed: false });
        const triage = value(await use.sessionState({ session })).triages.find((t) => t.request === own.request.id);
        expect(triage).toMatchObject({ kind: 'Consultation', decidedBy: 'Runner', outcome: { kind: 'Run', run: claimed.run.id } });
    });
});

describe('the session so far', () => {
    test('what the agents are given, whole or since an entry', async () => {
        const { use, session } = await collab();
        const asked = value(await say(use, session, bob, '@AI[p1] 注文は取り消せる？', { mentions: [AI_PARTICIPANT_ID] }));
        await triaged(use, asked.triage?.id ?? ('' as C.TriageId), 'Consultation');
        const before = value(await use.sessionSoFar({ session }));
        expect(before.text).toContain('Bob:\n    @AI 注文は取り消せる？');
        expect(before.open).toEqual(["#1 waits for the AI's answer"]);
        value(await use.answerMessage({ triage: asked.triage?.id ?? ('' as C.TriageId), body: text('確定前だけです。') }));
        const since = value(await use.sessionSoFar({ session, since: before.last }));
        expect(since.entries.map((e) => e.full)).toEqual([expect.stringContaining('AI answered (replying to #1):\n    確定前だけです。')]);
        expect(since.open).toEqual([]);
        expect(error(await use.sessionSoFar({ session: '00000000-0000-4000-8000-0000000000ff' as C.SessionId }))).toMatchObject({ type: 'NotFound' });
    });
});
