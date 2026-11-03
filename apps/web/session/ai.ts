// The AI's side of the chat (ADR 0030), without React: whether the session is Solo (`dt open`) or Collab, where each
// message addressed to the AI stands (its triage, then the answer, the proposal or the run it went to), the change
// proposals, whether the AI is connected, and whether a message being written will reach the AI. Everything is derived
// from the session's state on the page: nothing here is sent.
import { AI_NAME, AI_PARTICIPANT, triageRoute } from '@domaintrail/collaboration';
import type { AgentPresence, SessionStateBody } from '@domaintrail/collaboration/protocol';
import type { PersonCandidate } from './mentions';

export { AI_NAME, AI_PARTICIPANT };

type RequestJson = SessionStateBody['requests'][number];
type RunJson = SessionStateBody['runs'][number];
export type TriageJson = NonNullable<SessionStateBody['triages']>[number];
export type ProposalJson = NonNullable<SessionStateBody['proposals']>[number];
/** A triage as the facilitator gets it: with its steps. */
export type TriageRecord = Extract<TriageJson, { readonly steps: unknown }>;

/** Whether a participant ID is the AI's (`ai`). */
export const isAiAuthor = (participant: string): boolean => participant === AI_PARTICIPANT;

/** The session is `dt open`'s: one person, every message addressed to the AI. */
export const isSolo = (state: Pick<SessionStateBody, 'session'>): boolean => state.session.mode === 'Solo';

/** The AI as `@` offers it, first among the people. */
export const AI_CANDIDATE: PersonCandidate = { id: AI_PARTICIPANT, name: AI_NAME, role: 'participant', online: true, ai: true };

/** Where a message stands with the AI. */
export type MessageAi =
    /** Not addressed to the AI: talk between people. */
    | { readonly kind: 'none' }
    /** Being triaged, or decided and its answer or proposal not written yet (`since`: when it was addressed). */
    | { readonly kind: 'working'; readonly since: string }
    /** The server gave its answer or proposal up after retries. */
    | { readonly kind: 'given-up' }
    /** Judged to need nothing from the AI. */
    | { readonly kind: 'neither' }
    | { readonly kind: 'answer'; readonly answer: string }
    | { readonly kind: 'proposal'; readonly proposal: string }
    | { readonly kind: 'run'; readonly run: string };

/** The triage of each message addressed to the AI, by the message's ID. */
export function triagesByRequest(state: Pick<SessionStateBody, 'triages'>): Map<string, TriageJson> {
    return new Map((state.triages ?? []).map((t) => [t.request, t]));
}

/** Whether a triage is the facilitator's record (with its steps), not a participant's outcome. */
export const isRecord = (t: TriageJson): t is TriageRecord => 'steps' in t;

/**
 * A triage decided and still waiting for the answerer: a 相談 to answer, or a participant's 依頼 to write a proposal for
 * (the facilitator's, Solo's and those the facilitator addressed are queued in the transaction that decides them).
 */
export function awaitsAnswerer(t: TriageJson, state: Pick<SessionStateBody, 'session' | 'requests'>): boolean {
    if (t.state !== 'Decided' || t.kind === undefined || t.outcome !== undefined) return false;
    const author = state.requests.find((r) => r.id === t.request)?.author;
    const route = triageRoute(
        { kind: t.kind, addressedBy: t.addressedBy },
        { mode: state.session.mode, authorIsFacilitator: author === state.session.facilitator },
    );
    return route === 'answer' || route === 'propose';
}

/** Where a message stands with the AI, from its triage (`givenUp`: the triages whose answer the server gave up). */
export function messageAi(triage: TriageJson | undefined, givenUp: ReadonlySet<string> = new Set()): MessageAi {
    if (!triage) return { kind: 'none' };
    if (triage.state === 'Pending') return { kind: 'working', since: triage.openedAt };
    const outcome = triage.outcome;
    if (outcome?.kind === 'Answer') return { kind: 'answer', answer: outcome.answer };
    if (outcome?.kind === 'Proposal') return { kind: 'proposal', proposal: outcome.proposal };
    if (outcome?.kind === 'Run') return { kind: 'run', run: outcome.run };
    if (triage.kind === 'NotForAi') return { kind: 'neither' };
    if (givenUp.has(triage.id)) return { kind: 'given-up' };
    return { kind: 'working', since: triage.openedAt };
}

/**
 * The triages whose answer or proposal the server gave up (after its retries; it keeps them given up until it starts
 * again), as far as the page can tell: the agent presence's `waiting` counts the answer jobs not given up plus the runs
 * queued, so the jobs the page sees waiting beyond that count were given up — at least that many (a triage still at
 * stage 3 is counted by the server and not here, so this never claims too many). The oldest are taken: they had their
 * retries. Without presence (an older server), none.
 */
export function givenUpTriages(state: Pick<SessionStateBody, 'session' | 'requests' | 'runs' | 'triages' | 'agent'>): Set<string> {
    if (!state.agent) return new Set();
    const queued = state.runs.filter((r: RunJson) => r.state === 'Queued').length;
    const pending = (state.triages ?? []).filter((t) => t.state === 'Pending').length;
    const decidedAt = (t: TriageJson): string => (t.state === 'Decided' ? (t.decidedAt ?? '') : '');
    const waiting = (state.triages ?? []).filter((t) => awaitsAnswerer(t, state)).sort((a, b) => decidedAt(a).localeCompare(decidedAt(b)));
    const answering = state.agent.waiting - queued - pending;
    const gone = Math.max(0, waiting.length - Math.max(0, answering));
    return new Set(waiting.slice(0, gone).map((t) => t.id));
}

/** What the chat's header says of the AI: nothing while every role is connected, else which is missing and how much waits. */
export type AiPresence = { readonly kind: 'connected' } | { readonly kind: 'missing'; readonly role: 'all' | 'answer' | 'run'; readonly waiting: number };

/** The AI's presence for the header; a server that does not tell it counts as connected (nothing shown). */
export function aiPresence(agent: AgentPresence | undefined): AiPresence {
    if (!agent) return { kind: 'connected' };
    const { answer, run } = agent.connected;
    if (answer > 0 && run > 0) return { kind: 'connected' };
    return { kind: 'missing', role: answer === 0 && run === 0 ? 'all' : answer === 0 ? 'answer' : 'run', waiting: agent.waiting };
}

/**
 * Whether a message being written will reach the AI: in Solo every message does; in Collab one that mentions `@AI`, or
 * replies to an AI turn or to a message of the AI.
 */
export function willAddress(
    state: Pick<SessionStateBody, 'session' | 'requests'>,
    people: readonly string[],
    reply: { readonly kind: 'Run' } | { readonly kind: 'Message'; readonly request: string } | undefined,
): boolean {
    if (isSolo(state) || people.includes(AI_PARTICIPANT) || reply?.kind === 'Run') return true;
    if (reply?.kind !== 'Message') return false;
    const author = state.requests.find((r: RequestJson) => r.id === reply.request)?.author;
    return author !== undefined && isAiAuthor(author);
}

/** The change proposals still waiting for the facilitator, in the order they were made. */
export const openProposals = (state: Pick<SessionStateBody, 'proposals'>): ProposalJson[] => (state.proposals ?? []).filter((p) => p.state === 'Open');

/** The text a proposal stands for now: the facilitator's edit once approved with one, else the AI's. */
export const proposalContent = (p: ProposalJson): ProposalJson['content'] => (p.state === 'Approved' && p.edited ? p.edited : p.content);
