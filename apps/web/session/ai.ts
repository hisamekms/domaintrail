// The AI's side of the chat (ADR 0030), without React: whether the session is Solo (`dt open`) or Collab, where each
// message addressed to the AI stands (its triage, then the answer, the proposal or the run it went to), the change
// proposals, whether the AI is connected, and whether a message being written will reach the AI. Everything is derived
// from the session's state on the page: nothing here is sent.
import { AI_NAME, AI_PARTICIPANT } from '@domaintrail/collaboration';
import type { AgentPresence, SessionStateBody } from '@domaintrail/collaboration/protocol';
import type { PersonCandidate } from './mentions';

export { AI_NAME, AI_PARTICIPANT };

type RequestJson = SessionStateBody['requests'][number];
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

/** Where a message stands with the AI, from its triage (`givenUp`: the messages whose answer the server gave up). */
export function messageAi(triage: TriageJson | undefined, givenUp: ReadonlySet<string> = new Set()): MessageAi {
    if (!triage) return { kind: 'none' };
    if (triage.state === 'Pending') return { kind: 'working', since: triage.openedAt };
    const outcome = triage.outcome;
    if (outcome?.kind === 'Answer') return { kind: 'answer', answer: outcome.answer };
    if (outcome?.kind === 'Proposal') return { kind: 'proposal', proposal: outcome.proposal };
    if (outcome?.kind === 'Run') return { kind: 'run', run: outcome.run };
    if (triage.kind === 'NotForAi') return { kind: 'neither' };
    if (givenUp.has(triage.request)) return { kind: 'given-up' };
    return { kind: 'working', since: triage.openedAt };
}

/**
 * The messages whose answer or proposal the server gave up after its retries (`AgentPresence.givenUp`): each waits for
 * an answerer to connect, or for the facilitator to try again.
 */
export const givenUpRequests = (state: Pick<SessionStateBody, 'agent'>): Set<string> => new Set((state.agent?.givenUp ?? []).map((g) => g.request));

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

/**
 * The AI's card right under a message in Solo (`dt open`), from the moment it is sent: pending while it is triaged (or
 * answered, the answer not written yet), given up, then the answer or the run it went to, which takes the card's place.
 * None in Collab (the message's status slot says where it stands there), for the AI's own messages, for a message judged
 * to need nothing, and for one that became a proposal (a card of its own).
 */
export type AiSlot =
    | { readonly kind: 'pending' }
    | { readonly kind: 'given-up' }
    | { readonly kind: 'answer'; readonly answer: string }
    | { readonly kind: 'run'; readonly run: string };

/**
 * The AI's card under a message (see `AiSlot`): from its triage on the server, so that it is the same after a reload;
 * `sent`: this page has just sent it, so that the card shows at once, before the server's triage reaches the page;
 * `answeredBy`: the AI's message replying to it, which takes the pending card's place at once when it reaches the page
 * before the triage naming it the answer (the server's two events come one after the other: else it would show on
 * its own row for a moment, under the card, then move into it).
 */
export function aiSlot(
    solo: boolean,
    request: Pick<RequestJson, 'id' | 'author'>,
    triage: TriageJson | undefined,
    givenUp: ReadonlySet<string>,
    sent: boolean,
    answeredBy?: string,
): AiSlot | undefined {
    if (!solo || isAiAuthor(request.author)) return undefined;
    const pending: AiSlot = answeredBy === undefined ? { kind: 'pending' } : { kind: 'answer', answer: answeredBy };
    if (!triage) return sent ? pending : undefined;
    const ai = messageAi(triage, givenUp);
    switch (ai.kind) {
        case 'working':
            return pending;
        case 'given-up':
            return { kind: 'given-up' };
        case 'answer':
            return { kind: 'answer', answer: ai.answer };
        case 'run':
            return { kind: 'run', run: ai.run };
        case 'none':
        case 'neither':
        case 'proposal':
            return undefined;
    }
}

/** A message this page sent, shown at once (Solo) until the server's message is on the page. */
export interface Outgoing {
    /** This page's key for it, kept by the server's message once it is there (the row is not mounted again). */
    readonly local: string;
    /** The message as it will be (`id` is `local`). */
    readonly request: RequestJson;
    /** The IDs of the messages on the page when it was sent: the server's message is a new one. */
    readonly known: ReadonlySet<string>;
    /** The server's ID for it, once it answered. */
    readonly id?: string;
}

/**
 * The server's message for one sent from this page: by the ID the server answered with, or before its answer, the
 * first new message of mine with the same text that no earlier outgoing message took.
 */
export function outgoingMatch(outgoing: Outgoing, requests: readonly RequestJson[], taken: ReadonlySet<string> = new Set()): string | undefined {
    if (outgoing.id !== undefined) return requests.some((r) => r.id === outgoing.id) ? outgoing.id : undefined;
    return requests.find((r) => !outgoing.known.has(r.id) && !taken.has(r.id) && r.author === outgoing.request.author && r.body === outgoing.request.body)?.id;
}

/**
 * The messages sent from this page, sorted: those still on their way (shown as they will be), and those the server's
 * message stands for now, by its ID (their key on the page).
 */
export function settleOutgoing(
    outgoing: readonly Outgoing[],
    requests: readonly RequestJson[],
): { readonly waiting: readonly Outgoing[]; readonly sent: ReadonlyMap<string, string> } {
    const sent = new Map<string, string>();
    const waiting: Outgoing[] = [];
    for (const o of outgoing) {
        const id = outgoingMatch(o, requests, new Set(sent.keys()));
        if (id === undefined) waiting.push(o);
        else sent.set(id, o.local);
    }
    return { waiting, sent };
}
