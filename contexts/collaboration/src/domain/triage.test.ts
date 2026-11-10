import { describe, expect, test } from 'bun:test';
import { Collaboration as C } from '../generated/index.js';
import { AI_PARTICIPANT, isAi } from './ai.js';
import { knownRequestId, knownSessionId, knownTriageId } from './ids.js';
import { sessionOpening } from './modes.js';
import {
    addressing,
    answerJobOf,
    clefVerdict,
    confidence,
    decisionOf,
    inCascadeOrder,
    mechanicalVerdict,
    milliseconds,
    modelVerdict,
    nextStage,
    normalizeAcknowledgement,
    triageCommands,
    triageRoute,
} from './triage.js';

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
    return r.value;
};
const error = <E>(r: { ok: true } | { ok: false; error: E }): E => {
    if (r.ok) throw new Error('expected an error');
    return r.error;
};

const at = new Date('2026-11-03T09:00:00Z');
const facilitator = value(C.makeParticipantId('local:facilitator'));
const guest = value(C.makeParticipantId('dev:guest'));

describe('the AI as a participant', () => {
    test('its reserved ID is never an identity’s', () => {
        expect(isAi(AI_PARTICIPANT)).toBe(true);
        expect(isAi('dev:ai')).toBe(false);
        expect(isAi('local:facilitator')).toBe(false);
    });
});

describe('addressing (who talks to the AI)', () => {
    test.each<[string, Parameters<typeof addressing>[0], C.AddressedBy | undefined]>([
        ['Solo: every message', { mode: 'Solo', mentions: [] }, 'Solo'],
        ['Solo: a mention of a person too', { mode: 'Solo', mentions: ['dev:x'] }, 'Solo'],
        ['Collab: talk between people', { mode: 'Collab', mentions: [] }, undefined],
        ['Collab: a mention of a person', { mode: 'Collab', mentions: ['dev:x'] }, undefined],
        ['Collab: a mention of the AI', { mode: 'Collab', mentions: ['dev:x', AI_PARTICIPANT] }, 'Mention'],
        ['Collab: a reply to a run', { mode: 'Collab', mentions: [], replyTo: { kind: 'Run' } }, 'Reply'],
        ['Collab: a reply to the AI’s answer', { mode: 'Collab', mentions: [], replyTo: { kind: 'Message', author: AI_PARTICIPANT } }, 'Reply'],
        ['Collab: a reply to a person', { mode: 'Collab', mentions: [], replyTo: { kind: 'Message', author: 'dev:x' } }, undefined],
        ['Collab: a mention wins over a reply', { mode: 'Collab', mentions: [AI_PARTICIPANT], replyTo: { kind: 'Run' } }, 'Mention'],
    ])('%s', (_, facts, expected) => {
        expect(addressing(facts)).toBe(expected);
    });
});

describe('stage 1: mechanical, narrow', () => {
    test.each([
        ['@AI[p1]', 'empty'],
        ['@AI[p1]   ', 'empty'],
        ['👍', 'emojiOnly'],
        ['@AI[p1] 🙏🏽🎉', 'emojiOnly'],
        ['👨‍👩‍👧‍👦', 'emojiOnly'],
        ['ありがとう', 'acknowledgement'],
        ['@AI[p1] ありがとうございます！', 'acknowledgement'],
        ['了解です。', 'acknowledgement'],
        ['承知しました', 'acknowledgement'],
        ['ＯＫ', 'acknowledgement'],
        ['OK!', 'acknowledgement'],
        ['おk', 'acknowledgement'],
        ['Thanks!!', 'acknowledgement'],
        ['ありがとう🙏', 'acknowledgement'],
        ['了解〜', 'acknowledgement'],
    ])('%j is neither (%s)', (body, rule) => {
        expect(mechanicalVerdict(body)).toEqual({ verdict: 'NotForAi', rule: rule as 'empty' });
    });

    test.each([
        ['注文を取り消せますか？'],
        ['ラベルを「請求」にしてください'],
        ['ありがとう、ついでに #注文[1] も直して'],
        ['OK、それでお願いします'],
        ['なぜ？'],
        ['?'],
        ['#注文[1]'],
        ['お願いします'],
        ['はい'],
    ])('%j is unknown: stage 1 never tells 相談 from 依頼', (body) => {
        expect(mechanicalVerdict(body)).toEqual({ verdict: 'Unknown' });
    });

    test('normalised by width, case and trailing punctuation', () => {
        expect(normalizeAcknowledgement('  ＯＫ！！ ')).toBe('ok');
        expect(normalizeAcknowledgement('Thank   You.')).toBe('thank you');
        expect(normalizeAcknowledgement('了解です。。')).toBe('了解です');
    });
});

describe('stages 2 and 3: only confident answers', () => {
    test('Clef: exactly one question at or above the threshold decides', () => {
        expect(clefVerdict({ consultation: 0.95, changeRequest: 0.1, neither: 0.02 })).toEqual({ verdict: 'Consultation', confidence: 0.95 });
        expect(clefVerdict({ consultation: 0.2, changeRequest: 0.9, neither: 0.02 })).toEqual({ verdict: 'ChangeRequest', confidence: 0.9 });
        expect(clefVerdict({ consultation: 0.2, changeRequest: 0.1, neither: 0.97 })).toEqual({ verdict: 'NotForAi', confidence: 0.97 });
        expect(clefVerdict({ consultation: 0.89, changeRequest: 0.5, neither: 0.1 })).toEqual({ verdict: 'Unknown' });
        expect(clefVerdict({ consultation: 0.95, changeRequest: 0.95, neither: 0.1 })).toEqual({ verdict: 'Unknown' });
        expect(clefVerdict({ consultation: Number.NaN, changeRequest: 0.5, neither: 0.1 })).toEqual({ verdict: 'Unknown' });
        expect(clefVerdict({ consultation: 0.6, changeRequest: 0.1, neither: 0.1 }, 0.5)).toEqual({ verdict: 'Consultation', confidence: 0.6 });
    });

    test('the model: its kind, but a "neither" below the threshold is unknown', () => {
        expect(modelVerdict({ kind: 'ChangeRequest', confidence: 0.3 })).toBe('ChangeRequest');
        expect(modelVerdict({ kind: 'Consultation', confidence: 0.1 })).toBe('Consultation');
        expect(modelVerdict({ kind: 'NotForAi', confidence: 0.8 })).toBe('NotForAi');
        expect(modelVerdict({ kind: 'NotForAi', confidence: 0.79 })).toBe('Unknown');
        expect(modelVerdict({ kind: 'Unknown', confidence: 1 })).toBe('Unknown');
    });

    test('a confidence is kept to 4 decimals, from 0 to 1 only', () => {
        expect(confidence(0.92)).toBe(value(C.makeConfidence('0.92' as never)));
        expect(confidence(1)).toBe(value(C.makeConfidence('1' as never)));
        expect(confidence(0)).toBe(value(C.makeConfidence('0' as never)));
        expect(confidence(0.123456)).toBe(value(C.makeConfidence('0.1235' as never)));
        expect([confidence(-0.1), confidence(1.01), confidence(Number.NaN)]).toEqual([undefined, undefined, undefined]);
        expect([milliseconds(12.4), milliseconds(-3), milliseconds(Number.NaN)]).toEqual([12, 0, 0] as C.Milliseconds[]);
    });
});

describe('the cascade', () => {
    const step = (stage: C.TriageStage, verdict: C.TriageVerdict = 'Unknown'): C.TriageStep => ({ stage, verdict, durationMs: milliseconds(5), at });

    test('stages run in order, each once', () => {
        expect(inCascadeOrder([], 'Mechanical')).toBe(true);
        expect(inCascadeOrder([step('Mechanical')], 'Clef')).toBe(true);
        expect(inCascadeOrder([step('Mechanical')], 'Model')).toBe(true);
        expect(inCascadeOrder([step('Mechanical'), step('Clef')], 'Clef')).toBe(false);
        expect(inCascadeOrder([step('Model')], 'Clef')).toBe(false);
        expect(inCascadeOrder([], 'Answerer')).toBe(false);
        expect([nextStage([]), nextStage([step('Mechanical')]), nextStage([step('Mechanical'), step('Clef')]), nextStage([step('Model')])]).toEqual([
            'Mechanical',
            'Clef',
            'Model',
            undefined,
        ]);
    });

    test('a known answer decides; unknown passes on, except after the model: then 相談', () => {
        expect(decisionOf(step('Clef', 'ChangeRequest'))).toBe('ChangeRequest');
        expect(decisionOf(step('Mechanical', 'NotForAi'))).toBe('NotForAi');
        expect(decisionOf(step('Mechanical'))).toBeUndefined();
        expect(decisionOf(step('Clef'))).toBeUndefined();
        expect(decisionOf(step('Model'))).toBe('Consultation');
    });

    test('where a decided triage goes', () => {
        const collab = { mode: 'Collab', authorIsFacilitator: false } as const;
        expect(triageRoute({ kind: 'Consultation', addressedBy: 'Mention' }, collab)).toBe('answer');
        expect(triageRoute({ kind: 'NotForAi', addressedBy: 'Mention' }, collab)).toBe('none');
        expect(triageRoute({ kind: 'ChangeRequest', addressedBy: 'Mention' }, collab)).toBe('propose');
        expect(triageRoute({ kind: 'ChangeRequest', addressedBy: 'Reply' }, { ...collab, authorIsFacilitator: true })).toBe('queue');
        expect(triageRoute({ kind: 'ChangeRequest', addressedBy: 'Facilitator' }, collab)).toBe('queue');
        expect(triageRoute({ kind: 'ChangeRequest', addressedBy: 'Solo' }, { mode: 'Solo', authorIsFacilitator: true })).toBe('queue');
    });
});

describe('the commands of a triage', () => {
    const session = knownSessionId('00000000-0000-4000-8000-000000000001');
    const request = knownRequestId('00000000-0000-4000-8000-000000000002');
    const step = (stage: C.TriageStage, verdict: C.TriageVerdict = 'Unknown'): C.TriageStep => ({ stage, verdict, durationMs: milliseconds(5), at });
    const opened = value(
        triageCommands.open({
            id: knownTriageId('00000000-0000-4000-8000-000000000003'),
            session: session as C.ActiveSession,
            request: request as C.AddressableRequest,
            addressedBy: 'Mention',
            addressedByParticipant: guest,
            openedAt: at,
        }),
    ).Pending;

    test('open: pending, no step yet, TriageOpened', () => {
        expect(opened.aggregate).toMatchObject({ state: 'Pending', request, steps: [], addressedBy: 'Mention' });
        expect(opened.events['Collaboration.TriageOpened']).toMatchObject({ type: 'Collaboration.TriageOpened', request, addressedByParticipant: guest });
    });

    test('record: stage 1 unknown stays pending; Clef decides; out of order and stage 1 deciding 相談 are refused', () => {
        const one = value(triageCommands.record(opened.aggregate, { step: step('Mechanical'), recordedAt: at }));
        expect(one.Pending?.aggregate.steps).toHaveLength(1);
        expect(one.Decided).toBeUndefined();
        const pending = one.Pending?.aggregate;
        if (!pending) throw new Error('pending');
        const decided = value(triageCommands.record(pending, { step: step('Clef', 'ChangeRequest'), recordedAt: at })).Decided;
        expect(decided?.aggregate).toMatchObject({ state: 'Decided', kind: 'ChangeRequest', decidedBy: 'Clef' });
        expect(Object.keys(decided?.events ?? {})).toEqual(['Collaboration.TriageStepRecorded', 'Collaboration.TriageDecided']);
        expect(error(triageCommands.record(pending, { step: step('Mechanical'), recordedAt: at }))).toEqual({ type: 'Collaboration.TriageStepOutOfOrder' });
        expect(error(triageCommands.record(opened.aggregate, { step: step('Mechanical', 'Consultation'), recordedAt: at }))).toEqual({
            type: 'Collaboration.InvalidTriageStep',
        });
        expect(error(triageCommands.record(opened.aggregate, { step: step('Answerer', 'Consultation'), recordedAt: at }))).toEqual({
            type: 'Collaboration.InvalidTriageStep',
        });
        const model = value(triageCommands.record(pending, { step: step('Model'), recordedAt: at })).Decided;
        expect(model?.aggregate).toMatchObject({ kind: 'Consultation', decidedBy: 'Model' });
    });

    const decided = (kind: C.TriageVerdict, outcome?: C.TriageOutcome): C.DecidedTriage => ({
        ...opened.aggregate,
        state: 'Decided',
        kind,
        decidedBy: 'Model',
        decidedAt: at,
        ...(outcome && { outcome }),
    });

    test('override: the answerer corrects an unanswered 相談, the runner a 依頼; nothing else', () => {
        expect(
            value(triageCommands.override(decided('Consultation'), { step: step('Answerer', 'ChangeRequest'), overriddenAt: at })).Decided.aggregate,
        ).toMatchObject({
            kind: 'ChangeRequest',
            decidedBy: 'Answerer',
        });
        expect(
            value(triageCommands.override(decided('ChangeRequest'), { step: step('Runner', 'Consultation'), overriddenAt: at })).Decided.aggregate.kind,
        ).toBe('Consultation');
        const answered = decided('Consultation', { kind: 'Answer', answer: request });
        for (const [t, s] of [
            [answered, step('Answerer', 'ChangeRequest')],
            [decided('ChangeRequest'), step('Answerer', 'Consultation')],
            [decided('Consultation'), step('Runner', 'Consultation')],
            [decided('NotForAi'), step('Answerer', 'Consultation')],
            [decided('Consultation'), step('Model', 'ChangeRequest')],
        ] as const)
            expect(error(triageCommands.override(t, { step: s, overriddenAt: at }))).toEqual({ type: 'Collaboration.TriageNotOverridable' });
    });

    test('readdress: the facilitator sends a "neither" again as 相談, as theirs', () => {
        const again = value(triageCommands.readdress(decided('NotForAi'), { by: facilitator, byRole: 'Facilitator', readdressedAt: at })).Decided.aggregate;
        expect(again).toMatchObject({ kind: 'Consultation', decidedBy: 'Facilitator', addressedBy: 'Facilitator', addressedByParticipant: facilitator });
        expect(again.steps.at(-1)).toMatchObject({ stage: 'Facilitator', verdict: 'Consultation' });
        expect(error(triageCommands.readdress(decided('NotForAi'), { by: guest, byRole: 'Participant', readdressedAt: at }))).toEqual({
            type: 'Collaboration.FacilitatorOnly',
        });
        expect(error(triageCommands.readdress(decided('Consultation'), { by: facilitator, byRole: 'Facilitator', readdressedAt: at }))).toEqual({
            type: 'Collaboration.RequestAlreadyAddressed',
            request,
        });
    });

    test('conclude: once, with an outcome that fits the kind', () => {
        const run = { kind: 'Run', run: '00000000-0000-4000-8000-000000000009' } as C.TriageOutcome;
        expect(value(triageCommands.conclude(decided('ChangeRequest'), { to: run, concludedAt: at })).Decided.aggregate.outcome).toEqual(run);
        expect(error(triageCommands.conclude(decided('ChangeRequest', run), { to: run, concludedAt: at }))).toEqual({
            type: 'Collaboration.TriageAlreadyConcluded',
        });
        expect(error(triageCommands.conclude(decided('NotForAi'), { to: run, concludedAt: at }))).toEqual({ type: 'Collaboration.TriageNotConcludable' });
        expect(error(triageCommands.conclude(decided('ChangeRequest'), { to: { kind: 'Answer', answer: request }, concludedAt: at }))).toEqual({
            type: 'Collaboration.TriageNotConcludable',
        });
    });

    test('the answerer’s jobs: stage 3 once stage 2 is recorded, an answer, a proposal', () => {
        const collab = { mode: 'Collab', authorIsFacilitator: false } as const;
        const afterClef: C.PendingTriage = { ...opened.aggregate, steps: [step('Mechanical'), step('Clef')] };
        expect(answerJobOf(opened.aggregate, collab)).toBeUndefined();
        expect(answerJobOf({ ...opened.aggregate, steps: [step('Mechanical')] }, collab)).toBeUndefined();
        expect(answerJobOf(afterClef, collab)).toBe('triage');
        expect(answerJobOf(decided('Consultation'), collab)).toBe('answer');
        expect(answerJobOf(decided('Consultation', { kind: 'Answer', answer: request }), collab)).toBeUndefined();
        expect(answerJobOf(decided('ChangeRequest'), collab)).toBe('propose');
        expect(answerJobOf(decided('ChangeRequest'), { ...collab, authorIsFacilitator: true })).toBeUndefined();
        expect(answerJobOf(decided('NotForAi'), collab)).toBeUndefined();
    });
});

describe('the modes (decision 13)', () => {
    test('dt open refuses a Collab session, dt collab continues a Solo one', () => {
        expect(sessionOpening(undefined, 'Solo')).toBe('start');
        expect(sessionOpening(undefined, 'Collab')).toBe('start');
        expect(sessionOpening({ mode: 'Solo' }, 'Solo')).toBe('resume');
        expect(sessionOpening({ mode: 'Collab' }, 'Collab')).toBe('resume');
        expect(sessionOpening({ mode: 'Collab' }, 'Solo')).toBe('refuse');
        expect(sessionOpening({ mode: 'Solo' }, 'Collab')).toBe('collaborate');
    });
});
