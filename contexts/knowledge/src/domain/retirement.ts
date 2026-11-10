// Retiring an item (廃止, ADR 0031 section 12): an item that no longer holds — replaced by a newer finding, no longer
// true, or wrong — is retired, not deleted. Its text, sources and versions stay; it is hidden from the lists by default
// and kept from the AI (the answerer, the runner, the review), the extractor seeing only its title and reason so as not
// to make it again. A person retires an item, or undoes it, directly (`knowledgeItemCommands.retire` / `unretire`), or
// approves a proposal the AI made: the extractor or the review proposes (`RetirementCandidate`), a person approves or
// dismisses, one by one.
//
// What a store decides when it is given a candidate (`admitProposal`), pure so that every store decides alike:
//
// - the item must be there and not deleted, and the proposal must not be moot (retiring a retired item, unretiring one
//   that is not retired);
// - its replacement must be a live, unretired item, and its decisions live items of kind `decision`;
// - an AS-IS item is never retired for differing from the TO-BE: a proposal to retire one whose evidence is only
//   changes of stickies and TO-BE decisions is refused (what is said of today, a message, may retire it);
// - one open proposal per item and action: another is refused while it waits;
// - a dismissed proposal is remembered: a proposal for the same item, action and reason is refused unless it brings
//   evidence that none of the dismissed ones had (a new decision, another sticky, another message). A sticky's change
//   counts by its sticky, a message by its ID: the AI words the same evidence differently each time.
//
// The same candidate sent again (a retry) has the same ID (`proposalIdOf`, SHA-256 of what it proposes), and is
// answered with the proposal made the first time; a proposal of that ID that proposes something else is a collision,
// never taken for it (`ProposalIdCollision`). A store looks the ID up in the whole project, not only about the item.
import { decide, err, Knowledge, ok, type Result } from '../generated/index.js';
import { knowledgeItemCommands } from './items.js';
import { sha256Hex } from './sha256.js';

/** What the AI proposes: retiring an item (with a reason, and a replacement for `replaced`), or undoing a retirement. */
export interface RetirementCandidate {
    readonly item: Knowledge.KnowledgeItemId;
    readonly action: Knowledge.ProposalAction;
    /** Required to retire, absent to unretire. */
    readonly reason?: Knowledge.RetirementReason;
    /** The newer item that replaces it (`reason` `replaced` only). */
    readonly replacedBy?: Knowledge.KnowledgeItemId;
    /** Why, in a sentence: shown to the people who decide, and the audit log's reason. */
    readonly explanation: Knowledge.Reason;
    /** What it rests on: decisions, changes of stickies, messages. At least one. */
    readonly evidence: readonly [Knowledge.Evidence, ...Knowledge.Evidence[]];
    readonly proposedBy: Knowledge.Proposer;
}

/** Why a candidate is not taken: its shape, or what the store holds (`ProposalRefusal`). */
export type ProposalRejection = Knowledge.MalformedProposal | Knowledge.ProposalRefused;

/** The items and proposals a candidate is decided against. */
export interface ProposalContext {
    /** The item, its replacement and the decisions it names, as the store holds them (deleted ones included). */
    readonly lookup: (id: Knowledge.KnowledgeItemId) => Knowledge.KnowledgeItem | undefined;
    /** Every proposal about the item, in any state, and the proposal of the candidate's ID wherever it is (in the project). */
    readonly proposals: readonly Knowledge.RetirementProposal[];
}

/** A candidate taken: the proposal, and its event when it is new (none for a candidate sent again). */
export interface Admitted {
    readonly proposal: Knowledge.RetirementProposal;
    readonly event?: Knowledge.RetirementProposed;
}

const refused = (reason: Knowledge.ProposalRefusal): Result<never, ProposalRejection> => err({ type: 'Knowledge.ProposalRefused', reason });

/** Another proposal holds the ID a candidate's is derived from: never taken for it (and never overwritten). */
export class ProposalIdCollision extends Error {
    override readonly name = 'ProposalIdCollision';
}

/** The key of a piece of evidence for the memory of dismissals: the decision, the sticky, the message. */
export function evidenceKey(e: Knowledge.Evidence): string {
    switch (e.kind) {
        case 'Decision':
            return `decision:${e.item}`;
        case 'StickyChange':
            return `sticky:${e.sticky}`;
        case 'Said':
            return `said:${e.session}\u0000${e.message}`;
    }
}

const proposerKey = (p: Knowledge.Proposer): string =>
    p.kind === 'Extraction' ? `extraction:${p.extraction.session}#${p.extraction.number}` : `review:${p.review}`;

/** The ID of a candidate's proposal: from who proposed what about which item on what evidence, the same each time. */
export function proposalIdOf(candidate: RetirementCandidate): Knowledge.RetirementProposalId {
    const key = [
        proposerKey(candidate.proposedBy),
        candidate.item,
        candidate.action,
        candidate.reason ?? '',
        candidate.replacedBy ?? '',
        ...candidate.evidence.map(evidenceKey).sort(),
    ].join('\u0000');
    // 128 bits of SHA-256: no chance collision, and none to be made on purpose
    const made = Knowledge.makeRetirementProposalId(`rp_${sha256Hex(key).slice(0, 32)}`);
    if (!made.ok) throw new Error('A proposal ID is not one');
    return made.value;
}

/** Whether a proposal is the one a candidate makes (a retry): the same proposer, item, action, reason, replacement and evidence. */
function proposesTheSame(p: Knowledge.RetirementProposalCommon, c: RetirementCandidate): boolean {
    const keys = (e: readonly Knowledge.Evidence[]): string => e.map(evidenceKey).sort().join('\u0000');
    return (
        proposerKey(p.proposedBy) === proposerKey(c.proposedBy) &&
        p.item === c.item &&
        p.action === c.action &&
        p.reason === c.reason &&
        p.replacedBy === c.replacedBy &&
        keys(p.evidence) === keys(c.evidence)
    );
}

/** Whether the item is retired. */
export const isRetired = (item: Knowledge.KnowledgeItemCommon): boolean => item.retirement !== undefined;

/** Whether a proposal no longer asks for anything: its item is gone or deleted, or is already as it asks. */
export function isMoot(proposal: { readonly action: Knowledge.ProposalAction }, item: Knowledge.KnowledgeItem | undefined): boolean {
    if (item === undefined || item.state !== 'Live') return true;
    return proposal.action === 'retire' ? isRetired(item) : !isRetired(item);
}

/** The proposals that wait for a person: open and not moot, newest first. */
export function openProposals(
    proposals: readonly Knowledge.RetirementProposal[],
    lookup: (id: Knowledge.KnowledgeItemId) => Knowledge.KnowledgeItem | undefined,
): Knowledge.OpenRetirementProposal[] {
    return proposals
        .filter((p): p is Knowledge.OpenRetirementProposal => p.state === 'Open' && !isMoot(p, lookup(p.item)))
        .sort((a, b) => b.proposedAt.getTime() - a.proposedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

const usable = (item: Knowledge.KnowledgeItem | undefined): item is Knowledge.LiveKnowledgeItem =>
    item !== undefined && item.state === 'Live' && !isRetired(item);

/** Decides a candidate against the item and the proposals about it (see the head of this file). */
export function admitProposal(candidate: RetirementCandidate, context: ProposalContext, at: Date): Result<Admitted, ProposalRejection> {
    const id = proposalIdOf(candidate);
    const again = context.proposals.find((p) => p.id === id);
    if (again) {
        if (!proposesTheSame(again, candidate)) throw new ProposalIdCollision(`proposal ${id} proposes something else`);
        return ok({ proposal: again });
    }
    const item = context.lookup(candidate.item);
    if (item === undefined || item.state !== 'Live') return refused('itemUnavailable');
    const made = retirementProposalCommands.propose({
        id,
        item: candidate.item,
        action: candidate.action,
        ...(candidate.reason && { reason: candidate.reason }),
        ...(candidate.replacedBy && { replacedBy: candidate.replacedBy }),
        explanation: candidate.explanation,
        evidence: candidate.evidence,
        proposedBy: candidate.proposedBy,
        proposedAt: at,
    });
    if (!made.ok) return made;
    if (isMoot(candidate, item)) return refused('moot');
    if (candidate.replacedBy !== undefined && !usable(context.lookup(candidate.replacedBy))) return refused('replacementUnavailable');
    for (const e of candidate.evidence)
        if (e.kind === 'Decision') {
            const decision = context.lookup(e.item);
            if (!usable(decision) || decision.content.labels.kind !== 'decision') return refused('evidenceUnavailable');
        }
    // the stickies and the decisions of the TO-BE say how it shall be: an AS-IS finding that differs is not wrong for it
    const toBe = (e: Knowledge.Evidence): boolean => {
        if (e.kind === 'StickyChange') return true;
        if (e.kind !== 'Decision') return false;
        return context.lookup(e.item)?.content.labels.when === 'to_be';
    };
    if (candidate.action === 'retire' && item.content.labels.when === 'as_is' && candidate.evidence.every(toBe)) return refused('asIsAgainstStickies');
    const about = context.proposals.filter((p) => p.item === candidate.item && p.action === candidate.action);
    if (about.some((p) => p.state === 'Open')) return refused('pending');
    const dismissed = about.filter((p) => p.state === 'Dismissed' && p.reason === candidate.reason);
    if (dismissed.length > 0) {
        const seen = new Set(dismissed.flatMap((p) => p.evidence.map(evidenceKey)));
        if (candidate.evidence.every((e) => seen.has(evidenceKey(e)))) return refused('dismissedBefore');
    }
    return ok({ proposal: made.value.Open.aggregate, event: made.value.Open.events['Knowledge.RetirementProposed'] });
}

/** A proposal approved: the proposal and the item as they are after it. */
export interface Approval {
    readonly proposal: Knowledge.ApprovedRetirementProposal;
    readonly proposalEvent: Knowledge.RetirementProposalApproved;
    readonly item: Knowledge.LiveKnowledgeItem;
    readonly itemEvent: Knowledge.KnowledgeItemRetired | Knowledge.KnowledgeItemUnretired;
}

export type ApprovalError = Knowledge.ProposalNotFound | Knowledge.ProposalDecided | Knowledge.ProposalRefused;

/**
 * A person approves a proposal: the item is retired (with the proposal's reason, and its replacement while that is
 * still a usable item) or its retirement undone, by the person, in one decision. A moot proposal, or one whose item is
 * gone, is refused.
 */
export function decideApproval(
    id: Knowledge.RetirementProposalId,
    proposal: Knowledge.RetirementProposal | undefined,
    lookup: (id: Knowledge.KnowledgeItemId) => Knowledge.KnowledgeItem | undefined,
    by: Knowledge.UserName,
    at: Date,
): Result<Approval, ApprovalError> {
    if (proposal === undefined) return err({ type: 'Knowledge.ProposalNotFound', proposalId: id });
    if (proposal.state !== 'Open') return err({ type: 'Knowledge.ProposalDecided', proposalId: id });
    const item = lookup(proposal.item);
    if (item === undefined || item.state !== 'Live') return err({ type: 'Knowledge.ProposalRefused', reason: 'itemUnavailable' });
    if (isMoot(proposal, item)) return err({ type: 'Knowledge.ProposalRefused', reason: 'moot' });
    const approved = retirementProposalCommands.approve(proposal, { by, at });
    if (!approved.ok) throw new Error('approve refused an open proposal');
    const { aggregate, events } = approved.value.Approved;
    if (proposal.action === 'retire') {
        // the replacement only while it is still one to read instead
        const replacedBy = proposal.replacedBy !== undefined && usable(lookup(proposal.replacedBy)) ? proposal.replacedBy : undefined;
        const r = knowledgeItemCommands.retire(item, {
            ...(proposal.reason && { reason: proposal.reason }),
            ...(replacedBy && { replacedBy }),
            proposal: proposal.id,
            by,
            at,
        });
        if (!r.ok) return err({ type: 'Knowledge.ProposalRefused', reason: 'moot' });
        return ok({
            proposal: aggregate,
            proposalEvent: events['Knowledge.RetirementProposalApproved'],
            item: r.value.Live.aggregate,
            itemEvent: r.value.Live.events['Knowledge.KnowledgeItemRetired'],
        });
    }
    const r = knowledgeItemCommands.unretire(item, { proposal: proposal.id, by, at });
    if (!r.ok) return err({ type: 'Knowledge.ProposalRefused', reason: 'moot' });
    return ok({
        proposal: aggregate,
        proposalEvent: events['Knowledge.RetirementProposalApproved'],
        item: r.value.Live.aggregate,
        itemEvent: r.value.Live.events['Knowledge.KnowledgeItemUnretired'],
    });
}

/** A person dismisses a proposal: it stays, dismissed, as the memory that keeps it from being proposed again. */
export function decideDismissal(
    id: Knowledge.RetirementProposalId,
    proposal: Knowledge.RetirementProposal | undefined,
    by: Knowledge.UserName,
    at: Date,
): Result<
    { readonly proposal: Knowledge.DismissedRetirementProposal; readonly event: Knowledge.RetirementProposalDismissed },
    Knowledge.ProposalNotFound | Knowledge.ProposalDecided
> {
    if (proposal === undefined) return err({ type: 'Knowledge.ProposalNotFound', proposalId: id });
    if (proposal.state !== 'Open') return err({ type: 'Knowledge.ProposalDecided', proposalId: id });
    const r = retirementProposalCommands.dismiss(proposal, { by, at });
    if (!r.ok) throw new Error('dismiss refused an open proposal');
    return ok({ proposal: r.value.Dismissed.aggregate, event: r.value.Dismissed.events['Knowledge.RetirementProposalDismissed'] });
}

/**
 * The proposals the sweep removes with deleted items: those about them, and those whose evidence quotes a message they
 * came from (the message is redacted; its quote must not outlive it here).
 */
export function proposalsToForget(
    proposals: readonly Knowledge.RetirementProposal[],
    deleted: readonly Knowledge.KnowledgeItemCommon[],
): Knowledge.RetirementProposal[] {
    const items = new Set<string>(deleted.map((i) => i.id));
    const messages = new Set(deleted.flatMap((i) => i.sources.map((s) => `${s.session}\u0000${s.message}`)));
    return proposals.filter((p) => items.has(p.item) || p.evidence.some((e) => e.kind === 'Said' && messages.has(`${e.session}\u0000${e.message}`)));
}

export const retirementProposalCommands: Knowledge.RetirementProposalCommands = {
    propose: decide<Knowledge.ProposeRetirementProposalDecision>(Knowledge.RetirementProposalShape, (params) => {
        if (Knowledge.checkProposeRetirementProposalRequires(params) !== undefined) return err({ type: 'Knowledge.MalformedProposal' });
        const { id, item, action, reason, replacedBy, explanation, evidence, proposedBy, proposedAt } = params;
        return ok({
            Open: {
                set: { id, item, action, reason, replacedBy, explanation, evidence, proposedBy, proposedAt },
                events: {
                    'Knowledge.RetirementProposed': { type: 'Knowledge.RetirementProposed', proposalId: id, item, action, proposedBy, explanation, proposedAt },
                },
            },
        });
    }),

    approve: decide<Knowledge.ApproveRetirementProposalDecision>(Knowledge.RetirementProposalShape, {
        Open: (proposal, { by, at }) =>
            ok({
                Approved: {
                    set: { decidedBy: by, decidedAt: at },
                    events: {
                        'Knowledge.RetirementProposalApproved': {
                            type: 'Knowledge.RetirementProposalApproved',
                            proposalId: proposal.id,
                            item: proposal.item,
                            action: proposal.action,
                            by,
                            at,
                        },
                    },
                },
            }),
    }),

    dismiss: decide<Knowledge.DismissRetirementProposalDecision>(Knowledge.RetirementProposalShape, {
        Open: (proposal, { by, at }) =>
            ok({
                Dismissed: {
                    set: { decidedBy: by, decidedAt: at },
                    events: {
                        'Knowledge.RetirementProposalDismissed': {
                            type: 'Knowledge.RetirementProposalDismissed',
                            proposalId: proposal.id,
                            item: proposal.item,
                            action: proposal.action,
                            by,
                            at,
                        },
                    },
                },
            }),
    }),
};
