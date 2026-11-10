// The facilitator's approval of an assumption the AI made (ADR 0026, amendment "Assumptions approved"): the assumption
// stands as it is. It sends nothing to the agent; it records who approved it and when. An assumption has one decision:
// approved, or one of its alternatives picked (a run whose input picks it), never both. Whether an assumption can still
// be decided is read here, pure and over plain shapes, so that the server (the factory of `DecidableAssumption`, the
// votes' closing) and the page (the card's buttons) decide the same way.
import { Collaboration, decide, err, ok } from '../generated/index.js';
import { laterRunOf, type MarkRun } from './marks.js';
import { revertStatus } from './revert.js';

/** An approval as the rules read it (the aggregate, or its JSON on a page): which assumption of which run. */
export interface ApprovalFacts {
    readonly assumption: { readonly run: string; readonly assumption: number };
}

/** The approval of an assumption (by the run's ID and the assumption's index in its reply), among the session's. */
export function approvalOf<A extends ApprovalFacts>(approvals: readonly A[], run: string, assumption: number): A | undefined {
    return approvals.find((a) => a.assumption.run === run && a.assumption.assumption === assumption);
}

/**
 * Whether an assumption of a run can be decided now: `notApprovable` when the run is not completed or its reply has no
 * assumptions, `missing` when the index is not in its reply, `closed` when it was approved, a later run took over
 * the run's requests (a pick of one of its alternatives among them, `laterRunOf`) or the run was reverted (`revert.ts`),
 * `open` otherwise.
 */
export function assumptionStatus(
    run: MarkRun,
    assumption: number,
    runs: readonly MarkRun[],
    approvals: readonly ApprovalFacts[],
): 'notApprovable' | 'missing' | 'closed' | 'open' {
    if (run.state !== 'Completed' || !run.reply || run.reply.assumptions.length === 0) return 'notApprovable';
    if (!Number.isInteger(assumption) || assumption < 0 || assumption >= run.reply.assumptions.length) return 'missing';
    if (approvalOf(approvals, run.id, assumption) || laterRunOf(run, runs) || revertStatus(run, runs).kind === 'reverted') return 'closed';
    return 'open';
}

/** The command of an approval, checked against the generated contracts as the other aggregates' (`commands.ts`). */
export const approvalCommands: Collaboration.AssumptionApprovalCommands = {
    approve: decide<Collaboration.ApproveAssumptionApprovalDecision>(Collaboration.AssumptionApprovalShape, (params) => {
        if (Collaboration.checkApproveAssumptionApprovalRequires(params) === 'facilitatorApproves') return err({ type: 'Collaboration.FacilitatorOnly' });
        const { id, session, approvedBy, approvedAt } = params;
        // the reference without its evidence: the aggregate stores the base type
        const assumption: Collaboration.AssumptionRef = { run: params.assumption.run, assumption: params.assumption.assumption };
        return ok({
            Approved: {
                set: { id, session, assumption, approvedBy, approvedAt },
                events: {
                    'Collaboration.AssumptionApproved': {
                        type: 'Collaboration.AssumptionApproved',
                        approvalId: id,
                        session,
                        assumption,
                        approvedBy,
                        approvedAt,
                    },
                },
            },
        });
    }),
};
