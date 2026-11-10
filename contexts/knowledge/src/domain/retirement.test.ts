// Retiring an item and the AI's proposals (ADR 0031, section 12): a person retires and unretires; a proposal is taken,
// refused, approved or dismissed; a dismissal is remembered until the evidence changes; an AS-IS item is not retired
// for differing from the TO-BE.
import { describe, expect, test } from 'bun:test';
import { Knowledge } from '../generated/index.js';
import { knowledgeItemCommands as commands } from './items.js';
import {
    admitProposal,
    decideApproval,
    decideDismissal,
    isMoot,
    openProposals,
    ProposalIdCollision,
    proposalIdOf,
    proposalsToForget,
    type RetirementCandidate,
} from './retirement.js';
import { applyExtraction } from './extraction.js';
import { auditOfProposal } from './records.js';
import { sha256Hex } from './sha256.js';
import { at, extraction, itemId, later, liveItem, reason, sessionRef, source, stickyRef, userName } from '../test-helpers.js';

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
    return r.value;
};
const error = <E>(r: { ok: true } | { ok: false; error: E }): E => {
    if (r.ok) throw new Error('expected an error');
    return r.error;
};
const known = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => value(r);

const alice = userName('access:alice@example.com');
const bob = userName('guest:bob');

/** An item with its labels' `when` and `kind`. */
const item = (id: string, when: Knowledge.When = 'to_be', kind: Knowledge.KnowledgeKind = 'rule'): Knowledge.LiveKnowledgeItem => {
    const i = liveItem(id);
    return { ...i, content: { ...i.content, labels: { ...i.content.labels, when, kind } } };
};

const said = (message: string): Extract<Knowledge.Evidence, { readonly kind: 'Said' }> => ({
    kind: 'Said',
    session: sessionRef('s2'),
    message: known(Knowledge.makeMessageRef(message)),
    quote: known(Knowledge.makeQuote('もうやっていない')),
});
const decision = (id: string): Knowledge.Evidence => ({ kind: 'Decision', item: itemId(id) });
const stickyChange = (sticky: string): Knowledge.Evidence => ({
    kind: 'StickyChange',
    sticky: stickyRef(sticky),
    change: known(Knowledge.makeEvidenceNote('the step was removed')),
});
const review: Knowledge.Proposer = { kind: 'Review', review: known(Knowledge.makeReviewRef('review-1')) };

const candidate = (over: Partial<RetirementCandidate> = {}): RetirementCandidate => ({
    item: itemId('kn_00000001'),
    action: 'retire',
    reason: 'obsolete',
    explanation: reason('the talk says it is no longer done'),
    evidence: [said('m1')],
    proposedBy: review,
    ...over,
});

const lookupOf =
    (...items: Knowledge.KnowledgeItem[]) =>
    (id: Knowledge.KnowledgeItemId): Knowledge.KnowledgeItem | undefined =>
        items.find((i) => i.id === id);

describe('a person retires an item', () => {
    test('keeps the text, the sources and the version, with the reason and the replacement', () => {
        const i = item('kn_00000001');
        const { aggregate, events } = value(commands.retire(i, { reason: 'replaced', replacedBy: itemId('kn_00000002'), by: alice, at: later })).Live;
        expect(aggregate).toMatchObject({ content: i.content, sources: i.sources, version: i.version, updatedAt: later });
        expect(aggregate.retirement).toEqual({ reason: 'replaced', replacedBy: itemId('kn_00000002'), by: alice, at: later });
        expect(events.KnowledgeItemRetired).toMatchObject({ itemId: i.id, reason: 'replaced', by: alice });
    });

    test('without a reason too; not twice; a replacement only for replaced, and never itself', () => {
        const retired = value(commands.retire(item('kn_00000001'), { by: alice, at })).Live.aggregate;
        expect(retired.retirement).toEqual({ by: alice, at });
        expect(error(commands.retire(retired, { by: alice, at }))).toEqual({ type: 'Knowledge.AlreadyRetired' });
        expect(error(commands.retire(item('kn_00000001'), { reason: 'wrong', replacedBy: itemId('kn_00000002'), by: alice, at }))).toEqual({
            type: 'Knowledge.ReplacementWithoutReason',
        });
        expect(error(commands.retire(item('kn_00000001'), { reason: 'replaced', replacedBy: itemId('kn_00000001'), by: alice, at }))).toEqual({
            type: 'Knowledge.ReplacedByItself',
        });
    });

    test('unretiring brings it back as it was; an item not retired cannot be', () => {
        const i = item('kn_00000001');
        const retired = value(commands.retire(i, { reason: 'wrong', by: alice, at })).Live.aggregate;
        const back = value(commands.unretire(retired, { by: bob, at: later })).Live;
        expect(back.aggregate.retirement).toBeUndefined();
        expect(back.aggregate.content).toEqual(i.content);
        expect(back.events.KnowledgeItemUnretired).toMatchObject({ itemId: i.id, by: bob });
        expect(error(commands.unretire(i, { by: bob, at }))).toEqual({ type: 'Knowledge.NotRetired' });
    });
});

describe('a proposal is taken or refused', () => {
    test('taken: open, with its reason and evidence; the same candidate again answers it', () => {
        const target = item('kn_00000001');
        const admitted = value(admitProposal(candidate(), { lookup: lookupOf(target), proposals: [] }, at));
        expect(admitted.proposal).toMatchObject({ state: 'Open', item: target.id, action: 'retire', reason: 'obsolete', proposedBy: review });
        expect(admitted.event?.type).toBe('RetirementProposed');
        const again = value(admitProposal(candidate(), { lookup: lookupOf(target), proposals: [admitted.proposal] }, later));
        expect(again).toEqual({ proposal: admitted.proposal });
        expect(proposalIdOf(candidate())).toBe(admitted.proposal.id);
    });

    test('a malformed one: no reason to retire, a reason to unretire, a replacement for another reason', () => {
        const context = { lookup: lookupOf(item('kn_00000001')), proposals: [] };
        expect(error(admitProposal(candidate({ reason: undefined }), context, at))).toEqual({ type: 'Knowledge.MalformedProposal' });
        expect(error(admitProposal(candidate({ action: 'unretire' }), context, at))).toEqual({ type: 'Knowledge.MalformedProposal' });
        expect(error(admitProposal(candidate({ replacedBy: itemId('kn_00000002') }), context, at))).toEqual({ type: 'Knowledge.MalformedProposal' });
    });

    test('refused against the store: a missing or deleted item, a moot one, a replacement or a decision that is not one', () => {
        const refusal = (c: RetirementCandidate, ...items: Knowledge.KnowledgeItem[]): unknown =>
            error(admitProposal(c, { lookup: lookupOf(...items), proposals: [] }, at));
        const target = item('kn_00000001');
        const deleted = value(commands.delete(target, { by: alice, at })).Deleted.aggregate;
        const retired = value(commands.retire(target, { by: alice, at })).Live.aggregate;
        expect(refusal(candidate())).toEqual({ type: 'Knowledge.ProposalRefused', reason: 'itemUnavailable' });
        expect(refusal(candidate(), deleted)).toEqual({ type: 'Knowledge.ProposalRefused', reason: 'itemUnavailable' });
        expect(refusal(candidate(), retired)).toEqual({ type: 'Knowledge.ProposalRefused', reason: 'moot' });
        expect(refusal(candidate({ action: 'unretire', reason: undefined }), target)).toEqual({ type: 'Knowledge.ProposalRefused', reason: 'moot' });
        expect(refusal(candidate({ reason: 'replaced', replacedBy: itemId('kn_00000002') }), target)).toEqual({
            type: 'Knowledge.ProposalRefused',
            reason: 'replacementUnavailable',
        });
        expect(refusal(candidate({ evidence: [decision('kn_00000003')] }), target, item('kn_00000003', 'to_be', 'rule'))).toEqual({
            type: 'Knowledge.ProposalRefused',
            reason: 'evidenceUnavailable',
        });
    });

    test('an AS-IS item is not retired for differing from the TO-BE: stickies and TO-BE decisions alone are refused', () => {
        const asIs = item('kn_00000001', 'as_is');
        const toBeDecision = item('kn_00000003', 'to_be', 'decision');
        const context = { lookup: lookupOf(asIs, toBeDecision), proposals: [] };
        expect(error(admitProposal(candidate({ evidence: [stickyChange('Ordering.Accept')] }), context, at))).toEqual({
            type: 'Knowledge.ProposalRefused',
            reason: 'asIsAgainstStickies',
        });
        expect(error(admitProposal(candidate({ evidence: [stickyChange('Ordering.Accept'), decision('kn_00000003')] }), context, at))).toEqual({
            type: 'Knowledge.ProposalRefused',
            reason: 'asIsAgainstStickies',
        });
        // what is said of today may retire it
        expect(admitProposal(candidate({ evidence: [stickyChange('Ordering.Accept'), said('m1')] }), context, at).ok).toBe(true);
        // a TO-BE item may be retired for a sticky's change
        expect(admitProposal(candidate({ evidence: [stickyChange('Ordering.Accept')] }), { lookup: lookupOf(item('kn_00000001')), proposals: [] }, at).ok).toBe(
            true,
        );
    });

    test('one open proposal per item and action', () => {
        const target = item('kn_00000001');
        const first = value(admitProposal(candidate(), { lookup: lookupOf(target), proposals: [] }, at)).proposal;
        expect(error(admitProposal(candidate({ evidence: [said('m2')] }), { lookup: lookupOf(target), proposals: [first] }, at))).toEqual({
            type: 'Knowledge.ProposalRefused',
            reason: 'pending',
        });
    });
});

describe('a dismissal is remembered', () => {
    const target = item('kn_00000001');
    const dismissedOf = (c: RetirementCandidate): Knowledge.RetirementProposal => {
        const p = value(admitProposal(c, { lookup: lookupOf(target, item('kn_00000009', 'to_be', 'decision')), proposals: [] }, at)).proposal;
        return value(decideDismissal(p.id, p, bob, later)).proposal;
    };

    test('the same reason on the same evidence (worded otherwise, by another proposer) is not proposed again', () => {
        const dismissed = dismissedOf(candidate());
        const again = candidate({
            explanation: reason('said otherwise'),
            evidence: [{ ...said('m1'), quote: known(Knowledge.makeQuote('別の引用')) }],
            proposedBy: { kind: 'Extraction', extraction: extraction('s3', 1) },
        });
        expect(error(admitProposal(again, { lookup: lookupOf(target), proposals: [dismissed] }, later))).toEqual({
            type: 'Knowledge.ProposalRefused',
            reason: 'dismissedBefore',
        });
    });

    test('new evidence (a new decision, another message) proposes it again; so does another reason', () => {
        const dismissed = dismissedOf(candidate());
        const lookup = lookupOf(target, item('kn_00000009', 'to_be', 'decision'));
        expect(admitProposal(candidate({ evidence: [said('m1'), decision('kn_00000009')] }), { lookup, proposals: [dismissed] }, later).ok).toBe(true);
        expect(admitProposal(candidate({ evidence: [said('m7')] }), { lookup, proposals: [dismissed] }, later).ok).toBe(true);
        expect(admitProposal(candidate({ reason: 'wrong' }), { lookup, proposals: [dismissed] }, later).ok).toBe(true);
    });
});

describe('a person approves or dismisses', () => {
    test('approving a proposal to retire retires the item with its reason, by the person, naming the proposal', () => {
        const target = item('kn_00000001');
        const replacement = item('kn_00000002');
        const p = value(
            admitProposal(candidate({ reason: 'replaced', replacedBy: replacement.id }), { lookup: lookupOf(target, replacement), proposals: [] }, at),
        ).proposal;
        const approval = value(decideApproval(p.id, p, lookupOf(target, replacement), alice, later));
        expect(approval.proposal).toMatchObject({ state: 'Approved', decidedBy: alice, decidedAt: later });
        expect(approval.item.retirement).toEqual({ reason: 'replaced', replacedBy: replacement.id, by: alice, at: later, proposal: p.id });
        expect(approval.itemEvent.type).toBe('KnowledgeItemRetired');
        // the replacement gone meanwhile: retired all the same, without it
        expect(value(decideApproval(p.id, p, lookupOf(target), alice, later)).item.retirement).toEqual({
            reason: 'replaced',
            by: alice,
            at: later,
            proposal: p.id,
        });
    });

    test('approving a proposal to unretire unretires it', () => {
        const retired = value(commands.retire(item('kn_00000001'), { by: alice, at })).Live.aggregate;
        const p = value(admitProposal(candidate({ action: 'unretire', reason: undefined }), { lookup: lookupOf(retired), proposals: [] }, at)).proposal;
        const approval = value(decideApproval(p.id, p, lookupOf(retired), bob, later));
        expect(approval.item.retirement).toBeUndefined();
        expect(approval.itemEvent.type).toBe('KnowledgeItemUnretired');
    });

    test('a missing, decided or moot proposal is refused', () => {
        const target = item('kn_00000001');
        const p = value(admitProposal(candidate(), { lookup: lookupOf(target), proposals: [] }, at)).proposal;
        expect(error(decideApproval(p.id, undefined, lookupOf(target), alice, later))).toEqual({ type: 'Knowledge.ProposalNotFound', proposalId: p.id });
        const dismissed = value(decideDismissal(p.id, p, alice, later)).proposal;
        expect(error(decideApproval(p.id, dismissed, lookupOf(target), alice, later))).toEqual({ type: 'Knowledge.ProposalDecided', proposalId: p.id });
        expect(error(decideDismissal(p.id, dismissed, alice, later))).toEqual({ type: 'Knowledge.ProposalDecided', proposalId: p.id });
        const retired = value(commands.retire(target, { by: bob, at })).Live.aggregate;
        expect(isMoot(p, retired)).toBe(true);
        expect(error(decideApproval(p.id, p, lookupOf(retired), alice, later))).toEqual({ type: 'Knowledge.ProposalRefused', reason: 'moot' });
    });

    test('the list waiting: open and not moot, newest first', () => {
        const a = item('kn_00000001');
        const b = item('kn_00000002');
        const pa = value(admitProposal(candidate(), { lookup: lookupOf(a), proposals: [] }, at)).proposal;
        const pb = value(admitProposal(candidate({ item: b.id }), { lookup: lookupOf(b), proposals: [] }, later)).proposal;
        expect(openProposals([pa, pb], lookupOf(a, b)).map((p) => p.id)).toEqual([pb.id, pa.id]);
        const retiredB = value(commands.retire(b, { by: alice, at })).Live.aggregate;
        expect(openProposals([pa, pb], lookupOf(a, retiredB)).map((p) => p.id)).toEqual([pa.id]);
    });

    test('the sweep forgets the proposals about a deleted item, and those quoting its messages', () => {
        const a = item('kn_00000001');
        const b = { ...item('kn_00000002'), sources: [source('s2', 'm1')] };
        const about = value(admitProposal(candidate({ item: b.id }), { lookup: lookupOf(b), proposals: [] }, at)).proposal;
        const quoting = value(admitProposal(candidate(), { lookup: lookupOf(a), proposals: [] }, at)).proposal;
        const other = value(
            admitProposal(candidate({ evidence: [said('m9')], item: itemId('kn_00000003') }), { lookup: lookupOf(item('kn_00000003')), proposals: [] }, at),
        ).proposal;
        expect(proposalsToForget([about, quoting, other], [b]).map((p) => p.id)).toEqual([about.id, quoting.id]);
    });
});

describe('an extraction proposes', () => {
    const by = extraction('s2', 1);

    test('ProposeRetire and ProposeUnretire are decided like a candidate, one per item and action within it', () => {
        const target = item('kn_00000001');
        const retired = value(commands.retire(item('kn_00000002'), { by: alice, at })).Live.aggregate;
        const outcome = applyExtraction(
            {
                by,
                operations: [
                    { kind: 'ProposeRetire', item: target.id, retirementReason: 'obsolete', evidence: [said('m1')], reason: reason('no longer done') },
                    { kind: 'ProposeRetire', item: target.id, retirementReason: 'wrong', evidence: [said('m2')], reason: reason('again') },
                    { kind: 'ProposeUnretire', item: retired.id, evidence: [said('m3')], reason: reason('brought up again') },
                ],
            },
            lookupOf(target, retired),
            at,
        );
        expect(outcome.proposals.map((p) => [p.item, p.action, p.proposedBy.kind])).toEqual([
            [target.id, 'retire', 'Extraction'],
            [retired.id, 'unretire', 'Extraction'],
        ]);
        expect(outcome.dropped.map((d) => d.reason)).toEqual([{ type: 'Knowledge.ProposalRefused', reason: 'pending' }]);
        expect(outcome.items).toEqual([]);
    });

    test('an operation on a retired item is dropped: the extractor was not given it', () => {
        const retired = value(commands.retire(item('kn_00000001'), { by: alice, at })).Live.aggregate;
        const outcome = applyExtraction(
            { by, operations: [{ kind: 'AddSource', item: retired.id, base: retired.version, source: source('s2', 'm1'), agreed: false }] },
            lookupOf(retired),
            at,
        );
        expect(outcome.dropped.map((d) => d.reason)).toEqual([{ type: 'Knowledge.RetiredItem', itemId: retired.id }]);
    });
});

describe('the ID of a proposal, and what the audit log keeps of one', () => {
    test('SHA-256, as the standard says', () => {
        expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
        expect(proposalIdOf(candidate())).toMatch(/^rp_[0-9a-f]{32}$/);
    });

    test('a proposal of the same ID that proposes something else is a collision, never answered for the candidate', () => {
        const target = item('kn_00000001');
        const made = value(admitProposal(candidate(), { lookup: lookupOf(target), proposals: [] }, at)).proposal;
        const forged = { ...made, item: itemId('kn_00000002'), evidence: [said('m5')] as [Knowledge.Evidence] };
        expect(() => admitProposal(candidate(), { lookup: lookupOf(target), proposals: [forged] }, at)).toThrow(ProposalIdCollision);
    });

    test('the audit record of a proposal holds its action and ID only: never its explanation nor its evidence', () => {
        const target = item('kn_00000001');
        const admitted = value(
            admitProposal(candidate({ explanation: reason('山田さんが「もうやらない」と言った') }), { lookup: lookupOf(target), proposals: [] }, at),
        );
        if (!admitted.event) throw new Error('no event');
        const record = auditOfProposal(admitted.event, target.version);
        expect(record.reason).toBe(`retire (${admitted.proposal.id})` as Knowledge.Reason);
        expect(JSON.stringify(record)).not.toContain('山田');
        expect(JSON.stringify(record)).not.toContain('もうやっていない');
    });
});
