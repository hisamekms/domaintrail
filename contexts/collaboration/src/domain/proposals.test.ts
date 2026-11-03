import { describe, expect, test } from 'bun:test';
import { Collaboration as C } from '../generated/index.js';
import { readAnswererReply, readProposeReply, readTriageAnswer } from './answers.js';
import { knownAgentRunId, knownChangeProposalId, knownRequestId, knownSessionId, knownTriageId } from './ids.js';
import { approvedContent, PROPOSAL_LIMITS, proposalCommands, readProposal } from './proposals.js';
import { readReply, REPLY_LIMITS, requestNumber, toAgentReply } from './reply.js';

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
const raw = { what: 'A cancel command', where: '#Order[1]', how: 'Add cancel from Confirmed to Cancelled.' };

describe('a proposal’s text', () => {
    test('read trimmed, each field within its limit, nothing else', () => {
        expect(value(readProposal({ what: '  A cancel command ', where: raw.where, how: raw.how }))).toEqual(raw as unknown as C.ProposalContent);
        expect(error(readProposal({ ...raw, what: '' }))).toEqual({ path: 'proposal.what', message: 'Expected a non-empty string.' });
        expect(error(readProposal({ ...raw, how: 'x'.repeat(PROPOSAL_LIMITS.how + 1) }))).toEqual({
            path: 'proposal.how',
            message: `At most ${PROPOSAL_LIMITS.how} characters.`,
        });
        expect(error(readProposal({ ...raw, where: 'a\u0007b' })).path).toBe('proposal.where');
        expect(error(readProposal({ ...raw, diff: 'x' })).path).toBe('proposal.diff');
        expect(error(readProposal('text')).path).toBe('proposal');
        expect(value(readProposal({ ...raw, how: 'line 1\nline 2' })).how).toBe('line 1\nline 2' as C.ProposalText);
    });
});

describe('the commands of a change proposal', () => {
    const content = value(readProposal(raw));
    const open = value(
        proposalCommands.propose({
            id: knownChangeProposalId('00000000-0000-4000-8000-000000000001'),
            session: knownSessionId('00000000-0000-4000-8000-000000000002') as C.ActiveSession,
            triage: knownTriageId('00000000-0000-4000-8000-000000000003') as C.ProposableTriage,
            request: knownRequestId('00000000-0000-4000-8000-000000000004'),
            requestedBy: guest,
            content,
            proposedAt: at,
        }),
    ).Open.aggregate;
    const run = knownAgentRunId('00000000-0000-4000-8000-000000000005');

    test('approved by the facilitator, as is or edited: the run follows the edited text', () => {
        const edited = value(readProposal({ ...raw, how: 'Add cancel from Placed only.' }));
        const approved = value(
            proposalCommands.approve(open, { approvedBy: facilitator, approvedByRole: 'Facilitator', edited, run, approvedAt: at }),
        ).Approved;
        expect(approved.aggregate).toMatchObject({ state: 'Approved', run, edited });
        expect(approvedContent(approved.aggregate)).toEqual(edited);
        const asIs = value(
            proposalCommands.approve(open, { approvedBy: facilitator, approvedByRole: 'Facilitator', edited: undefined, run, approvedAt: at }),
        ).Approved;
        expect(approvedContent(asIs.aggregate)).toEqual(content);
        expect(asIs.events.ProposalApproved).toEqual({ type: 'ProposalApproved', proposalId: open.id, approvedBy: facilitator, run, approvedAt: at });
        expect(error(proposalCommands.approve(open, { approvedBy: guest, approvedByRole: 'Participant', edited: undefined, run, approvedAt: at }))).toEqual({
            type: 'FacilitatorOnly',
        });
    });

    test('rejected by the facilitator with a note; withdrawn by its requester only', () => {
        const note = value(C.makeText('Not in this release.'));
        expect(
            value(proposalCommands.reject(open, { rejectedBy: facilitator, rejectedByRole: 'Facilitator', note, rejectedAt: at })).Rejected.aggregate,
        ).toMatchObject({
            state: 'Rejected',
            note,
        });
        expect(error(proposalCommands.reject(open, { rejectedBy: guest, rejectedByRole: 'Participant', note: undefined, rejectedAt: at }))).toEqual({
            type: 'FacilitatorOnly',
        });
        expect(value(proposalCommands.withdraw(open, { withdrawnBy: guest, withdrawnAt: at })).Withdrawn.aggregate.state).toBe('Withdrawn');
        expect(error(proposalCommands.withdraw(open, { withdrawnBy: facilitator, withdrawnAt: at }))).toEqual({ type: 'NotTheRequester' });
    });
});

describe('what the answerer role returns', () => {
    test('stage 3: a kind, a confidence from 0 to 1, a reason', () => {
        expect(value(readTriageAnswer({ kind: 'change_request', confidence: 0.7, reason: 'asks to rename' }))).toEqual({
            verdict: 'ChangeRequest',
            confidence: 0.7,
            reason: 'asks to rename',
        });
        expect(value(readTriageAnswer({ kind: 'neither', confidence: 1, reason: 'thanks' })).verdict).toBe('NotForAi');
        expect(error(readTriageAnswer({ kind: '相談', confidence: 0.7, reason: 'x' })).path).toBe('triage.kind');
        expect(error(readTriageAnswer({ kind: 'unknown', confidence: 1.2, reason: 'x' })).path).toBe('triage.confidence');
        expect(error(readTriageAnswer({ kind: 'unknown', confidence: 0.2, reason: '' })).path).toBe('triage.reason');
        expect(error(readTriageAnswer({ kind: 'unknown', confidence: 0.2, reason: 'x', extra: 1 })).path).toBe('triage.extra');
    });

    test('an answer job: an answer, a proposal (the override), or neither', () => {
        expect(value(readAnswererReply({ kind: 'answer', answer: ' No: only Placed orders. ' }))).toEqual({
            kind: 'answer',
            answer: 'No: only Placed orders.',
        });
        expect(value(readAnswererReply({ kind: 'proposal', proposal: raw, reason: 'it asks for a change' }))).toEqual({
            kind: 'proposal',
            proposal: raw as unknown as C.ProposalContent,
            reason: 'it asks for a change',
        });
        expect(value(readAnswererReply({ kind: 'neither' }))).toEqual({ kind: 'neither' });
        expect(error(readAnswererReply({ kind: 'answer', answer: 'x'.repeat(REPLY_LIMITS.answer + 1) })).path).toBe('reply.answer');
        expect(error(readAnswererReply({ kind: 'answer', answer: 'x', proposal: raw })).path).toBe('reply.proposal');
        expect(error(readAnswererReply({ kind: 'edit' })).path).toBe('reply.kind');
        expect(error(readAnswererReply({ kind: 'proposal', proposal: { what: 'x' } })).path).toBe('reply.proposal.where');
        expect(value(readProposeReply({ proposal: raw }))).toEqual(raw as unknown as C.ProposalContent);
        expect(error(readProposeReply({ proposal: raw, answer: 'x' })).path).toBe('reply.answer');
    });
});

describe('a run that answers instead of editing (decision 18)', () => {
    const reply = (extra: Record<string, unknown>): unknown => ({
        outcome: 'done',
        title: 'Cancel?',
        summary: 'Answered.',
        requests: [{ request: 1, status: 'answered' }],
        ...extra,
    });

    test('an answered request needs the answer; the answer is kept on the model’s reply', () => {
        const read = value(readReply(reply({ answer: 'Only placed orders can be cancelled.' }), requestNumber(1), 1));
        expect(read).toMatchObject({ answer: 'Only placed orders can be cancelled.', requests: [{ request: 1, status: 'answered' }] });
        const id = knownRequestId('00000000-0000-4000-8000-000000000004');
        const agent = toAgentReply({ ...read, requests: [{ request: id, status: 'answered' }], questions: [], assumptions: [] });
        expect(agent.answer).toBe(value(C.makeText('Only placed orders can be cancelled.')));
        expect(agent.requests).toEqual([{ request: id, status: 'Answered' }]);
        expect(C.checkAgentReply(agent)).toEqual([]);
        expect(C.checkAgentReply({ ...agent, answer: undefined })).toEqual(['answeredHasAnswer']);
        expect(error(readReply(reply({}), requestNumber(1), 1))).toEqual({
            path: 'reply.answer',
            message: 'An answer is required when a request is answered.',
        });
        expect(error(readReply(reply({ answer: 'x'.repeat(REPLY_LIMITS.answer + 1) }), requestNumber(1), 1)).path).toBe('reply.answer');
        expect(error(readReply({ outcome: 'declined', summary: 'No.', requests: [], answer: 'x' }, requestNumber(1), 1))).toEqual({
            path: 'reply.answer',
            message: 'Only a done reply answers, not declined.',
        });
    });
});
