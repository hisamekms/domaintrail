// Change proposals (ADR 0030, decision 4; the plan's "Stage 5"): a participant's change request, written up by the
// read-only answerer as what to change, where and how, for the facilitator to approve (as is or edited), reject (with
// a note) or for its requester to withdraw while it waits. Approved together, proposals are one run. The text is the
// AI's: untrusted, validated against the limits below before it is kept, and shown as plain text.
import { Collaboration, decide, err, ok, type Result } from '../generated/index.js';

/** The limits of a proposal's text, per field (characters): change one here and every side follows. */
export const PROPOSAL_LIMITS = {
    /** What to change, in a line or two. */
    what: 300,
    /** Where: the elements, as `#name` links, and files. */
    where: 500,
    /** How, as text: no diff. */
    how: 2000,
    /** The facilitator's note to the requester when rejecting. */
    note: 500,
} as const;

/** A proposal as the answerer (or the facilitator's edit) sends it. */
export interface ProposalData {
    readonly what: string;
    readonly where: string;
    readonly how: string;
}

/** Why a proposal's text was refused: where in it, and what is wrong. */
export interface ProposalProblem {
    readonly path: string;
    readonly message: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether `s` has a control character other than tabs and line breaks. */
function hasControl(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const n = s.charCodeAt(i);
        if (n !== 0x09 && n !== 0x0a && n !== 0x0d && (n < 0x20 || (n >= 0x7f && n <= 0x9f))) return true;
    }
    return false;
}

/**
 * A proposal's text validated: `{ what, where, how }`, each a non-blank string (trimmed) within its limit, without
 * control characters, and nothing else.
 */
export function readProposal(raw: unknown, path = 'proposal'): Result<Collaboration.ProposalContent, ProposalProblem> {
    if (!isObject(raw)) return err({ path, message: 'Expected an object.' });
    const extra = Object.keys(raw).find((k) => k !== 'what' && k !== 'where' && k !== 'how');
    if (extra !== undefined) return err({ path: `${path}.${extra}`, message: 'Unknown field.' });
    const fields: Partial<Record<keyof ProposalData, Collaboration.ProposalText>> = {};
    for (const key of ['what', 'where', 'how'] as const) {
        const v = raw[key];
        if (typeof v !== 'string' || !v.trim()) return err({ path: `${path}.${key}`, message: 'Expected a non-empty string.' });
        const t = v.trim();
        if (t.length > PROPOSAL_LIMITS[key]) return err({ path: `${path}.${key}`, message: `At most ${PROPOSAL_LIMITS[key]} characters.` });
        if (hasControl(t)) return err({ path: `${path}.${key}`, message: 'No control characters.' });
        const made = Collaboration.makeProposalText(t);
        if (!made.ok) return err({ path: `${path}.${key}`, message: 'Not a proposal text.' });
        fields[key] = made.value;
    }
    const { what, where, how } = fields;
    if (!what || !where || !how) throw new Error('Every field of the proposal was read above');
    return ok({ what, where, how });
}

/** The JSON schema of a proposal (the answerer's `{ kind: 'proposal', proposal }`), from the limits. */
export function proposalJsonSchema(): Record<string, unknown> {
    const str = (maxLength: number): Record<string, unknown> => ({ type: 'string', minLength: 1, maxLength });
    return {
        type: 'object',
        properties: { what: str(PROPOSAL_LIMITS.what), where: str(PROPOSAL_LIMITS.where), how: str(PROPOSAL_LIMITS.how) },
        required: ['what', 'where', 'how'],
        additionalProperties: false,
    };
}

/** What an approved proposal asks of the run: its edited text when the facilitator edited it, else its own. */
export const approvedContent = (proposal: Collaboration.ApprovedChangeProposal): Collaboration.ProposalContent => proposal.edited ?? proposal.content;

export const proposalCommands: Collaboration.ChangeProposalCommands = {
    propose: decide<Collaboration.ProposeChangeProposalDecision>(Collaboration.ChangeProposalShape, (params) => {
        const { id, session, request, requestedBy, content, proposedAt } = params;
        // the triage without its evidence: the aggregate stores the base type
        const triage: Collaboration.TriageId = params.triage;
        return ok({
            Open: {
                set: { id, session, triage, request, requestedBy, content, proposedAt },
                events: { ChangeProposed: { type: 'ChangeProposed', proposalId: id, session, triage, request, requestedBy, content, proposedAt } },
            },
        });
    }),

    approve: decide<Collaboration.ApproveChangeProposalDecision>(Collaboration.ChangeProposalShape, {
        Open: (proposal, params) => {
            if (Collaboration.checkApproveChangeProposalRequires(proposal, params) === 'facilitatorApproves') return err({ type: 'FacilitatorOnly' });
            const { approvedBy, edited, run, approvedAt } = params;
            return ok({
                Approved: {
                    set: { approvedBy, approvedAt, edited, run },
                    events: { ProposalApproved: { type: 'ProposalApproved', proposalId: proposal.id, approvedBy, ...(edited && { edited }), run, approvedAt } },
                },
            });
        },
    }),

    reject: decide<Collaboration.RejectChangeProposalDecision>(Collaboration.ChangeProposalShape, {
        Open: (proposal, params) => {
            if (Collaboration.checkRejectChangeProposalRequires(proposal, params) === 'facilitatorRejects') return err({ type: 'FacilitatorOnly' });
            const { rejectedBy, note, rejectedAt } = params;
            return ok({
                Rejected: {
                    set: { rejectedBy, rejectedAt, note },
                    events: { ProposalRejected: { type: 'ProposalRejected', proposalId: proposal.id, rejectedBy, ...(note && { note }), rejectedAt } },
                },
            });
        },
    }),

    withdraw: decide<Collaboration.WithdrawChangeProposalDecision>(Collaboration.ChangeProposalShape, {
        Open: (proposal, params) => {
            if (Collaboration.checkWithdrawChangeProposalRequires(proposal, params) === 'requesterWithdraws') return err({ type: 'NotTheRequester' });
            const { withdrawnBy, withdrawnAt } = params;
            return ok({
                Withdrawn: {
                    set: { withdrawnAt },
                    events: { ProposalWithdrawn: { type: 'ProposalWithdrawn', proposalId: proposal.id, withdrawnBy, withdrawnAt } },
                },
            });
        },
    }),
};
