import { describe, expect, test } from 'bun:test';
import { Collaboration as C } from '../generated/index.js';
import { readAnswererReply, readProposeReply, readTriageAnswer } from './answers.js';
import { knownAgentRunId, knownChangeProposalId, knownRequestId, knownSessionId, knownTriageId } from './ids.js';
import {
    approvedInstruction,
    elementReference,
    oneRecommended,
    parseElementReference,
    PROPOSAL_LIMITS,
    proposalCommands,
    proposalData,
    proposalJsonSchema,
    readProposal,
    recommendedOption,
} from './proposals.js';
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
const order: C.ModelTarget = { kind: 'DtElement', element: value(C.makeElementName('Sales.Order')) };
const orderId: C.ModelTarget = { kind: 'DtElement', element: value(C.makeElementName('Sales.OrderId')) };
const sticky: C.ModelTarget = { kind: 'DtesElement', storming: value(C.makeStormingName('Orders')), local: value(C.makeStormingLocalName('Order')) };
const raw = { targets: ['@{Sales.Order}'], how: 'Rename its label to 受注.' };
const option = (label: string, extra: object = {}): object => ({ label, targets: ['@{Sales.Order}'], ...extra });

describe('a proposal as the AI writes it', () => {
    test('targets as element references, how trimmed within its limit, nothing else', () => {
        expect(value(readProposal({ targets: [' @{Sales.Order} ', 'es:Orders/Order'], how: '  Rename its label to 受注. ' }))).toEqual({
            targets: [order, sticky],
            how: 'Rename its label to 受注.',
            options: [],
        } as unknown as C.ProposalContent);
        expect(error(readProposal({ ...raw, how: '' }))).toEqual({ path: 'proposal.how', message: 'Expected a non-empty string.' });
        expect(error(readProposal({ ...raw, how: 'x'.repeat(PROPOSAL_LIMITS.how + 1) }))).toEqual({
            path: 'proposal.how',
            message: `At most ${PROPOSAL_LIMITS.how} characters.`,
        });
        expect(error(readProposal({ ...raw, how: 'a\u0007b' })).path).toBe('proposal.how');
        expect(error(readProposal({ ...raw, what: 'x' })).path).toBe('proposal.what');
        expect(error(readProposal({ ...raw, targets: '@{Sales.Order}' })).path).toBe('proposal.targets');
        expect(error(readProposal({ ...raw, targets: [1] })).path).toBe('proposal.targets[0]');
        expect(error(readProposal('text')).path).toBe('proposal');
        expect(value(readProposal({ ...raw, how: 'line 1\nline 2' })).how).toBe('line 1\nline 2' as C.ProposalText);
        // no targets at all: a change of the whole model, or one the AI could not pin down
        expect(value(readProposal({ how: 'x' })).targets).toEqual([]);
    });

    test('malformed references are dropped (paths, files, whitespace); unknown ones are kept, each once, at most 50', () => {
        expect(parseElementReference('@{Sales.Order:confirm}')).toEqual({ kind: 'DtElement', element: 'Sales.Order:confirm' } as unknown as C.ModelTarget);
        expect(parseElementReference('Sales.Order#Draft')).toEqual({ kind: 'DtElement', element: 'Sales.Order#Draft' } as unknown as C.ModelTarget);
        // a whole storming
        expect(parseElementReference('@{es:Orders}')).toEqual({ kind: 'DtesStorming', storming: 'Orders' } as unknown as C.ModelTarget);
        expect(elementReference({ kind: 'DtesStorming', storming: 'Orders' })).toBe('@{es:Orders}');
        for (const bad of ['contexts/sales/order.dt', 'order.dtes', '@{Sales Order}', '@{es:}', '@{es:a/b/c}', '@{es:a/}', '', '@{}', 'a{b}'])
            expect(parseElementReference(bad)).toBeUndefined();
        const read = value(readProposal({ ...raw, targets: ['@{Sales.Order}', 'sales/order.dt', '@{Sales.Order}', '@{Sales.Nothing}'] }));
        expect(read.targets.map(elementReference)).toEqual(['@{Sales.Order}', '@{Sales.Nothing}']);
        const many = Array.from({ length: 60 }, (_, i) => `@{Sales.E${i}}`);
        expect(value(readProposal({ ...raw, targets: many })).targets).toHaveLength(PROPOSAL_LIMITS.targets);
    });

    test('options are clamped: at most three, exactly one recommended; a single option is the proposal', () => {
        // none marked: the first is recommended
        const two = value(
            readProposal({ ...raw, targets: [], options: [option('集約だけ'), option('付箋も', { targets: ['@{Sales.Order}', '@{es:Orders/Order}'] })] }),
        );
        expect(two.options.map((o): unknown[] => [o.label, o.recommended])).toEqual([
            ['集約だけ', true],
            ['付箋も', false],
        ]);
        expect(recommendedOption(two)).toBe(0 as C.ProposalOptionIndex);
        // several marked: the first marked one
        const marked = value(readProposal({ ...raw, options: [option('a'), option('b', { recommended: true }), option('c', { recommended: true })] }));
        expect(marked.options.map((o) => o.recommended)).toEqual([false, true, false]);
        // four, the fourth recommended: it is kept with the first two
        const four = value(readProposal({ ...raw, options: [option('a'), option('b'), option('c'), option('d', { recommended: true })] }));
        expect(four.options.map((o): unknown[] => [o.label, o.recommended])).toEqual([
            ['a', false],
            ['b', false],
            ['d', true],
        ]);
        expect([two, marked, four].every(oneRecommended)).toBe(true);
        // one option: no choice — its targets and its how become the proposal's
        const one = value(readProposal({ ...raw, targets: [], options: [option('集約だけ', { targets: ['@{Sales.OrderId}'], how: 'Add it.' })] }));
        expect(one).toEqual({ targets: [orderId], how: 'Add it.', options: [] } as unknown as C.ProposalContent);
        expect(value(readProposal({ ...raw, options: [] })).options).toEqual([]);
        expect(error(readProposal({ ...raw, options: [option('')] })).path).toBe('proposal.options[0].label');
        expect(error(readProposal({ ...raw, options: [option('x'.repeat(PROPOSAL_LIMITS.label + 1)), option('b')] })).path).toBe('proposal.options[0].label');
        expect(error(readProposal({ ...raw, options: [option('a', { recommended: 'yes' }), option('b')] })).path).toBe('proposal.options[0].recommended');
        expect(error(readProposal({ ...raw, options: [option('a', { where: 'x' }), option('b')] })).path).toBe('proposal.options[0].where');
        expect(error(readProposal({ ...raw, options: 'a' })).path).toBe('proposal.options');
    });

    test('sent as element references and read back the same; the schema bounds what the model writes', () => {
        const read = value(readProposal({ ...raw, options: [option('集約だけ', { recommended: true }), option('付箋も', { how: 'Also the sticky.' })] }));
        expect(proposalData(read)).toEqual({
            targets: ['@{Sales.Order}'],
            how: 'Rename its label to 受注.',
            options: [
                { label: '集約だけ', targets: ['@{Sales.Order}'], recommended: true },
                { label: '付箋も', targets: ['@{Sales.Order}'], how: 'Also the sticky.', recommended: false },
            ],
        });
        expect(value(readProposal(proposalData(read)))).toEqual(read);
        const schema = proposalJsonSchema() as { properties: { how: { maxLength: number }; options: { maxItems: number } }; required: string[] };
        expect([schema.properties.how.maxLength, schema.properties.options.maxItems, schema.required]).toEqual([PROPOSAL_LIMITS.how, 3, ['targets', 'how']]);
    });
});

describe('the commands of a change proposal', () => {
    const content = value(readProposal(raw));
    const choices = value(
        readProposal({ ...raw, targets: [], options: [option('集約だけ'), option('付箋も', { targets: ['@{es:Orders/Order}'], how: 'Also the sticky.' })] }),
    );
    const propose = (c: C.ProposalContent): C.OpenChangeProposal =>
        value(
            proposalCommands.propose({
                id: knownChangeProposalId('00000000-0000-4000-8000-000000000001'),
                session: knownSessionId('00000000-0000-4000-8000-000000000002') as C.ActiveSession,
                triage: knownTriageId('00000000-0000-4000-8000-000000000003') as C.ProposableTriage,
                request: knownRequestId('00000000-0000-4000-8000-000000000004'),
                requestedBy: guest,
                content: c,
                proposedAt: at,
            }),
        ).Open.aggregate;
    const open = propose(content);
    const run = knownAgentRunId('00000000-0000-4000-8000-000000000005');
    const approve = (p: C.OpenChangeProposal, option: number | undefined, editedHow?: string) =>
        proposalCommands.approve(p, {
            approvedBy: facilitator,
            approvedByRole: 'Facilitator',
            option: option === undefined ? undefined : value(C.makeProposalOptionIndex(option)),
            editedHow: editedHow === undefined ? undefined : value(C.makeProposalText(editedHow)),
            run,
            approvedAt: at,
        });

    test('approved by the facilitator, as is or with its how edited: the run follows the edited how', () => {
        const edited = value(approve(open, undefined, 'Rename it to 受注 everywhere.')).Approved;
        expect(edited.aggregate).toMatchObject({ state: 'Approved', run, editedHow: 'Rename it to 受注 everywhere.' });
        expect(approvedInstruction(edited.aggregate)).toEqual({ targets: [order], how: 'Rename it to 受注 everywhere.' } as unknown as C.ProposalInstruction);
        const asIs = value(approve(open, undefined)).Approved;
        expect(approvedInstruction(asIs.aggregate)).toEqual({ targets: content.targets, how: content.how });
        expect(asIs.events['Collaboration.ProposalApproved']).toEqual({
            type: 'Collaboration.ProposalApproved',
            proposalId: open.id,
            approvedBy: facilitator,
            run,
            approvedAt: at,
        });
        expect(
            error(
                proposalCommands.approve(open, {
                    approvedBy: guest,
                    approvedByRole: 'Participant',
                    option: undefined,
                    editedHow: undefined,
                    run,
                    approvedAt: at,
                }),
            ),
        ).toEqual({ type: 'Collaboration.FacilitatorOnly' });
    });

    test('with options, approved with one of them: the run gets its label, its targets and its how (or the edited one)', () => {
        const withChoices = propose(choices);
        const second = value(approve(withChoices, 1)).Approved;
        expect(second.aggregate.option).toBe(1 as C.ProposalOptionIndex);
        expect(second.events['Collaboration.ProposalApproved']).toMatchObject({ option: 1 });
        expect(approvedInstruction(second.aggregate)).toEqual({
            label: '付箋も',
            targets: [sticky],
            how: 'Also the sticky.',
        } as unknown as C.ProposalInstruction);
        // the first has no how of its own: the proposal's; its targets are its own
        expect(approvedInstruction(value(approve(withChoices, 0, 'Only the aggregate.')).Approved.aggregate)).toEqual({
            label: '集約だけ',
            targets: [order],
            how: 'Only the aggregate.',
        } as unknown as C.ProposalInstruction);
        // no option chosen of a proposal with options, an option it does not have, an option of one without options
        expect(error(approve(withChoices, undefined))).toEqual({ type: 'Collaboration.NoSuchOption' });
        expect(error(approve(withChoices, 2))).toEqual({ type: 'Collaboration.NoSuchOption' });
        expect(error(approve(open, 0))).toEqual({ type: 'Collaboration.NoSuchOption' });
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
            type: 'Collaboration.FacilitatorOnly',
        });
        expect(value(proposalCommands.withdraw(open, { withdrawnBy: guest, withdrawnAt: at })).Withdrawn.aggregate.state).toBe('Withdrawn');
        expect(error(proposalCommands.withdraw(open, { withdrawnBy: facilitator, withdrawnAt: at }))).toEqual({ type: 'Collaboration.NotTheRequester' });
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
            proposal: { targets: [order], how: raw.how, options: [] } as unknown as C.ProposalContent,
            reason: 'it asks for a change',
        });
        expect(value(readAnswererReply({ kind: 'neither' }))).toEqual({ kind: 'neither' });
        expect(error(readAnswererReply({ kind: 'answer', answer: 'x'.repeat(REPLY_LIMITS.answer + 1) })).path).toBe('reply.answer');
        expect(error(readAnswererReply({ kind: 'answer', answer: 'x', proposal: raw })).path).toBe('reply.proposal');
        expect(error(readAnswererReply({ kind: 'edit' })).path).toBe('reply.kind');
        expect(error(readAnswererReply({ kind: 'proposal', proposal: { targets: [] } })).path).toBe('reply.proposal.how');
        expect(value(readProposeReply({ proposal: raw }))).toEqual({ targets: [order], how: raw.how, options: [] } as unknown as C.ProposalContent);
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
