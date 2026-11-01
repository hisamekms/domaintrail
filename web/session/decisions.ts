// What became of a run's questions and assumptions (ADR 0026, appendix "Votes and reactions"), without React: the run
// that took over its requests (`laterRunOf`, the rule that closes its votes) either answered its questions, picked an
// alternative of one of its assumptions, or neither (they were left as they were). Who decided and when are that run's
// `queuedBy` and `queuedAt`. An answer is recorded in the run's input (`answer`); a picked alternative only as the note
// the facilitator's page wrote (`alternativeNote` of the page's language at the time), so it is recognized by that
// note in any of the page's languages — a note written by hand does not count as a pick.
import { laterRunOf } from '@domaintrail/collaboration/domain/marks';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';

type RunJson = SessionStateBody['runs'][number];

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

/** The note asking for an alternative, as a page writes it (one per language). */
export type AlternativeNote = (assumption: string, alternative: string) => string;

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
 * The alternative picked from the assumptions of `run` (a completed one): the run that took over its requests, when its
 * note is the one a page writes to ask for one of them (in any of `notes`). Undefined while none took over, and when it
 * was not a pick (the assumptions left as they were).
 */
export function pickedAlternative(run: RunJson, runs: readonly RunJson[], notes: readonly AlternativeNote[]): PickedAlternative | undefined {
    if (run.state !== 'Completed' || !run.reply) return undefined;
    const later = takenOverBy(run, runs);
    const note = later?.input.note;
    if (!later || note === undefined) return undefined;
    for (const [i, a] of run.reply.assumptions.entries())
        for (const alt of a.alternatives)
            if (notes.some((n) => n(a.text, alt.label) === note)) return { assumption: i, alternative: alt.id, by: deciderOf(later, runs) };
    return undefined;
}
