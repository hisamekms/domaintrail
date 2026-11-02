// What became of a run's questions and assumptions (ADR 0026, appendix "Votes and reactions"), without React: the run
// that took over its requests (`laterRunOf`, the rule that closes its votes) either answered its questions, picked an
// alternative of one of its assumptions, or neither (they were left as they were). Who decided and when are that run's
// `queuedBy` and `queuedAt`. Both are recorded in that run's input: an answer as `answer`, a picked alternative as
// `pick` (the note the page writes with it is for the agent and the people, never read back here). An assumption can
// also be approved (amendment "Assumptions approved"): an approval of its own, with who and when, and no run.
import { approvalOf, laterRunOf } from '@domaintrail/collaboration';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';

type RunJson = SessionStateBody['runs'][number];
type ApprovalJson = SessionStateBody['approvals'][number];

/** Who decided and when: the run that did it, its number in the session, who queued it and when. */
export interface Decider {
    readonly run: string;
    readonly number: number;
    readonly by: string;
    readonly at: string;
}

/** What was answered to one question: the options chosen (by ID) and the own words (その他), if any. */
export interface QuestionAnswer {
    readonly chosen: readonly string[];
    readonly text?: string;
}

/**
 * The state of a run's questions: `open` while no later run took over its requests; `answered` by the run that did
 * (each question answered by its ID; a question left out has none); `left` when that run did not answer them.
 */
export type QuestionsState =
    | { readonly kind: 'open' }
    | { readonly kind: 'answered'; readonly by: Decider; readonly answers: ReadonlyMap<string, QuestionAnswer> }
    | { readonly kind: 'left' };

/** An alternative picked: which assumption (its index) and alternative (its ID), and who picked it. */
export interface PickedAlternative {
    readonly assumption: number;
    readonly alternative: string;
    readonly by: Decider;
}

/** A run's number in the session: as the chat numbers it, by when it was queued, from 1. */
export function runNumber(runs: readonly RunJson[], id: string): number {
    const sorted = [...runs].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    return sorted.findIndex((r) => r.id === id) + 1;
}

const deciderOf = (later: RunJson, runs: readonly RunJson[]): Decider => ({
    run: later.id,
    number: runNumber(runs, later.id),
    by: later.queuedBy,
    at: later.queuedAt,
});

/** The run that took over a run's requests (in the session's queue order), if any. */
const takenOverBy = (run: RunJson, runs: readonly RunJson[]): RunJson | undefined => {
    const later = laterRunOf(run, runs);
    return later && runs.find((r) => r.id === later.id);
};

/** What became of the questions of `run` (one that needs clarification) among the session's runs (in queue order). */
export function questionsState(run: RunJson, runs: readonly RunJson[]): QuestionsState {
    const later = takenOverBy(run, runs);
    if (!later) return { kind: 'open' };
    const answer = later.input.answer;
    if (answer?.answerTo !== run.id) return { kind: 'left' };
    const answers = new Map<string, QuestionAnswer>(
        answer.answers.map((a) => [a.question, { chosen: a.chosen.map((o) => o.id), ...(a.freeText !== undefined && { text: a.freeText }) }]),
    );
    return { kind: 'answered', by: deciderOf(later, runs), answers };
}

/**
 * The alternative picked from the assumptions of `run` (a completed one): the pick of the run that took over its
 * requests, when that run's input picked one of `run`'s alternatives. Undefined while none took over, and when it was not
 * a pick (the assumptions left as they were).
 */
export function pickedAlternative(run: RunJson, runs: readonly RunJson[]): PickedAlternative | undefined {
    if (run.state !== 'Completed') return undefined;
    const later = takenOverBy(run, runs);
    const pick = later?.input.pick;
    if (!later || pick?.pickOf !== run.id) return undefined;
    return { assumption: pick.assumption, alternative: pick.alternative.id, by: deciderOf(later, runs) };
}

/**
 * What became of one assumption of `run` (a completed one, by its index in the reply): `approved` by the facilitator
 * (who and when), `picked` (one of its alternatives, sent again: who, when and the run it queued), `left` when a later run
 * took over the run's requests without deciding it (another assumption picked, the messages applied again), `open`
 * otherwise. One decision per assumption: the server refuses the other once one is made.
 */
export type AssumptionDecision =
    | { readonly kind: 'open' }
    | { readonly kind: 'approved'; readonly by: string; readonly at: string }
    | { readonly kind: 'picked'; readonly alternative: string; readonly by: Decider }
    | { readonly kind: 'left' };

export function assumptionDecision(
    run: RunJson,
    assumption: number,
    runs: readonly RunJson[],
    approvals: readonly ApprovalJson[] | undefined,
): AssumptionDecision {
    const approval = approvalOf(approvals ?? [], run.id, assumption);
    if (approval) return { kind: 'approved', by: approval.approvedBy, at: approval.approvedAt };
    const picked = pickedAlternative(run, runs);
    if (picked?.assumption === assumption) return { kind: 'picked', alternative: picked.alternative, by: picked.by };
    return takenOverBy(run, runs) ? { kind: 'left' } : { kind: 'open' };
}
