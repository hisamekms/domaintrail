// The facilitator's approval of an assumption (ADR 0026, amendment "Assumptions approved"): whether an assumption can
// still be decided, and the command (the use case: test/collaboration-use-cases.test.ts; the route:
// test/session-replies.test.ts; the store: infrastructure/migrations.test.ts).
import { describe, expect, test } from 'bun:test';
import { Collaboration as C } from '../generated/index.js';
import { approvalCommands, approvalOf, assumptionStatus } from './approvals.js';
import type { MarkRun } from './marks.js';
import { knownAgentRunId, knownAssumptionApprovalId, knownSessionId } from './ids.js';

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
    return r.value;
};
const error = <E>(r: { ok: true } | { ok: false; error: E }): E => {
    if (r.ok) throw new Error('expected an error');
    return r.error;
};

const run = (id: string, state: string, requests: string[], over: Partial<MarkRun> = {}): MarkRun => ({
    id,
    state,
    input: { requests: requests.map((request) => ({ request })) },
    baseRevision: state === 'Queued' ? undefined : 'base',
    ...over,
});
const assuming: MarkRun['reply'] = { questions: [], assumptions: [{ alternatives: [{ id: 'alt1' }] }, { alternatives: [] }] };
const approved = (r: string, assumption: number) => ({ assumption: { run: r, assumption } });

describe('whether an assumption can be decided', () => {
    const r1 = run('r1', 'Completed', ['m1'], { reply: assuming });

    test('an assumption of a completed run, neither approved nor taken over, is open', () => {
        expect(assumptionStatus(r1, 0, [r1], [])).toBe('open');
        expect(assumptionStatus(r1, 1, [r1], [approved('r1', 0)])).toBe('open');
        // a run of other requests does not take over
        expect(assumptionStatus(r1, 0, [r1, run('r2', 'Queued', ['m2'])], [])).toBe('open');
    });

    test('a run that is not completed, or made no assumption, has nothing to approve; an index not in the reply is missing', () => {
        expect(assumptionStatus({ ...r1, state: 'NeedsClarification' }, 0, [r1], [])).toBe('notApprovable');
        expect(assumptionStatus(run('r1', 'Completed', ['m1'], { reply: { questions: [], assumptions: [] } }), 0, [], [])).toBe('notApprovable');
        expect(assumptionStatus(run('r1', 'Completed', ['m1']), 0, [], [])).toBe('notApprovable');
        expect(assumptionStatus(r1, 2, [r1], [])).toBe('missing');
        expect(assumptionStatus(r1, -1, [r1], [])).toBe('missing');
    });

    test('approved already, or a later run took over the requests (a pick of an alternative among them): closed', () => {
        expect(assumptionStatus(r1, 0, [r1], [approved('r1', 0)])).toBe('closed');
        const pick = run('r2', 'Queued', ['m1'], { input: { requests: [{ request: 'm1' }], pick: { pickOf: 'r1' } } });
        expect(assumptionStatus(r1, 0, [r1, pick], [])).toBe('closed');
        expect(assumptionStatus(r1, 1, [r1, pick], [])).toBe('closed');
        // the pick cancelled before it started: as if it had never been queued
        expect(assumptionStatus(r1, 0, [r1, { ...pick, state: 'Cancelled' }], [])).toBe('open');
    });

    test('the approval of an assumption is found by its run and index', () => {
        const all = [approved('r1', 1), approved('r2', 0)];
        expect(approvalOf(all, 'r1', 1)).toBe(all[0]);
        expect(approvalOf(all, 'r1', 0)).toBeUndefined();
    });
});

describe('the approve command', () => {
    const at = new Date('2026-11-01T09:00:00Z');
    const id = knownAssumptionApprovalId('00000000-0000-4000-8000-000000000001');
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stands in for what the factories check
    const session = knownSessionId('00000000-0000-4000-8000-000000000002') as C.ActiveSession;
    const ref: C.AssumptionRef = { run: knownAgentRunId('00000000-0000-4000-8000-000000000003'), assumption: value(C.makeTally(1)) };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stands in for what the factories check
    const assumption = ref as C.DecidableAssumption;
    const who = value(C.makeParticipantId('facilitator'));

    test('the facilitator approves: who and when are kept, and the event says which assumption', () => {
        const { Approved } = value(approvalCommands.approve({ id, session, assumption, approvedBy: who, approvedByRole: 'Facilitator', approvedAt: at }));
        expect(Approved.aggregate).toEqual({ state: 'Approved', id, session, assumption: ref, approvedBy: who, approvedAt: at });
        expect(Approved.events['Collaboration.AssumptionApproved']).toEqual({
            type: 'Collaboration.AssumptionApproved',
            approvalId: id,
            session,
            assumption: ref,
            approvedBy: who,
            approvedAt: at,
        });
    });

    test('a participant does not approve', () => {
        expect(error(approvalCommands.approve({ id, session, assumption, approvedBy: who, approvedByRole: 'Participant', approvedAt: at }))).toEqual({
            type: 'Collaboration.FacilitatorOnly',
        });
    });
});
