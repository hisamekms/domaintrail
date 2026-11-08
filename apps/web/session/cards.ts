// A card of the chat, without React (ADR 0026, amendment: messages and apply): one change unit (`history.ts`), its
// runs one under the other — what each run was asked (a quote of each message applied, with what the reply says of
// it), the facilitator's note or answer, and the agent's message — and the latest run of each applied message, which
// its link to the AI turn goes to (its state in the link's tooltip). Everything is derived from the session's state on the page.
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { revertableChanges, revertStatus } from '@domaintrail/collaboration';
import type { ChangeUnit } from './history';
import { agentMessage, type AgentMessage, type RequestProgress, type revisionLookup } from './stream';

type RunJson = SessionStateBody['runs'][number];
type FrozenRequest = RunJson['input']['requests'][number];

/** A message applied in a run, as the card quotes it: what the reply says of it, if anything. */
export interface Quote {
    readonly request: FrozenRequest;
    readonly progress?: RequestProgress;
    readonly note?: string;
}

/** One run of a card. */
export interface CardRun {
    readonly run: RunJson;
    /** Its number in the session (by when it was queued, from 1). */
    readonly number: number;
    readonly quotes: readonly Quote[];
    /** The facilitator's note on it, and the answer to the previous run's questions, as it was frozen. */
    readonly note?: string;
    readonly answer?: NonNullable<RunJson['input']['answer']>;
    readonly message: AgentMessage;
    readonly at: string;
}

const replyOf = (run: RunJson): Extract<RunJson, { state: 'Completed' }>['reply'] =>
    run.state === 'Completed' || run.state === 'NeedsClarification' || run.state === 'Declined' ? run.reply : undefined;

/** The runs of a card, oldest first, with their quotes and the agent's message. */
export function cardRuns(unit: ChangeUnit, lookup: ReturnType<typeof revisionLookup>): CardRun[] {
    return unit.runs.map(({ run, number }) => {
        const lines = new Map((replyOf(run)?.requests ?? []).map((l) => [l.request, l]));
        const { at, message } = agentMessage(run, lookup);
        return {
            run,
            number,
            quotes: run.input.requests.map((request) => {
                const line = lines.get(request.request);
                return { request, ...(line && { progress: line.status }), ...(line?.note !== undefined && { note: line.note }) };
            }),
            ...(run.input.note !== undefined && { note: run.input.note }),
            ...(run.input.answer && { answer: run.input.answer }),
            message,
            at,
        };
    });
}

/** What a run of a card shows of the messages it applied. */
export interface QuoteDisplay {
    /**
     * Their quotes: not when the run before on the card applied the same messages (its quotes say it), unless this run
     * says what it did of them (the quotes carry that); never in Solo, where the only person asked them all.
     */
    readonly quotes: boolean;
    /** The reply's note on each message: only for several; one message's is what the summary says. */
    readonly perRequest: boolean;
}

const sameRequests = (a: CardRun, b: CardRun): boolean =>
    a.quotes.length === b.quotes.length && a.quotes.every((q, i) => q.request.request === b.quotes[i]?.request.request);

/** What the `i`-th run of a card shows of the messages it applied (in Solo, none of them). */
export function quoteDisplay(runs: readonly CardRun[], i: number, solo = false): QuoteDisplay {
    const run = runs[i];
    const before = i > 0 ? runs[i - 1] : undefined;
    if (!run || solo) return { quotes: false, perRequest: false };
    const outcomes = run.quotes.some((q) => q.progress !== undefined);
    return { quotes: !before || !sameRequests(before, run) || outcomes, perRequest: run.quotes.length > 1 };
}

/** What an applied message shows of its latest run. */
export type MarkState = 'queued' | 'running' | 'clarification' | 'done' | 'partial' | 'skipped' | 'question' | 'answered' | 'declined' | 'failed' | 'cancelled';

export interface MessageMark {
    readonly state: MarkState;
    /** The card it is on (`ChangeUnit.key`). */
    readonly card: string;
}

// `Answered` (ADR 0030): the run judged the message a question and answered it instead of editing
const PROGRESS: Record<RequestProgress, MarkState> = { Done: 'done', Partial: 'partial', Skipped: 'skipped', Question: 'question', Answered: 'answered' };

/** The state of a message in a run: the run's, or for an ended run with a reply, what it says of the message. */
function markState(run: RunJson, request: string): MarkState {
    const line = replyOf(run)?.requests.find((l) => l.request === request);
    switch (run.state) {
        case 'Queued':
            return 'queued';
        case 'Running':
            return 'running';
        case 'NeedsClarification':
            return line ? PROGRESS[line.status] : 'clarification';
        case 'Completed':
            return line ? PROGRESS[line.status] : 'done';
        case 'Reverted':
        case 'Edited':
            return 'done';
        case 'Declined':
            return 'declined';
        case 'Failed':
            return 'failed';
        case 'Cancelled':
            return 'cancelled';
    }
}

/** The mark of every applied message, by its ID: its latest run's state (the last queued), and that run's card. */
export function messageMarks(units: readonly ChangeUnit[]): Map<string, MessageMark> {
    const latest = new Map<string, { run: RunJson; unit: ChangeUnit }>();
    for (const unit of units)
        for (const { run } of unit.runs)
            for (const r of run.input.requests) {
                const seen = latest.get(r.request);
                if (!seen || run.queuedAt >= seen.run.queuedAt) latest.set(r.request, { run, unit });
            }
    return new Map([...latest].map(([request, { run, unit }]) => [request, { state: markState(run, request), card: unit.key }]));
}

/** An item of a card's menu (the facilitator's): revert the unit's changes, see them. */
export type CardMenuItem = 'revert' | 'changes';

/**
 * The items of a card's menu, from the unit's latest run: none unless it changed files; 変更を見る then, and first
 * この作業を打ち消す while the collab is open (`live`) and its changes are not reverted nor being reverted.
 */
export function cardMenuItems(last: RunJson, runs: readonly RunJson[], live: boolean): CardMenuItem[] {
    if (!revertableChanges(last)) return [];
    return live && revertStatus(last, runs).kind === 'none' ? ['revert', 'changes'] : ['changes'];
}

/** Why a queued revert was left to the AI (the model's `RevertObstacle`, as JSON). */
export type RevertObstacleJson = NonNullable<Extract<RunJson, { state: 'Queued' }>['revertObstacle']>;

/**
 * How many runs a queued run waits behind: the one in progress and the queued ones before it (the queue's order is the
 * session's). `undefined` unless it is queued.
 */
export function queueAhead(run: string, runs: readonly RunJson[]): number | undefined {
    const at = runs.findIndex((r) => r.id === run);
    if (runs[at]?.state !== 'Queued') return undefined;
    return runs.filter((o, i) => o.state === 'Running' || (o.state === 'Queued' && i < at)).length;
}

/** Why a queued revert was left to the AI, in words (the tooltip on its state, `tx.chat.revertObstacle`). */
export function obstacleText(
    o: RevertObstacleJson,
    u: { readonly conflict: (paths: string) => string; readonly check: string; readonly unreadable: string },
): string {
    return o.kind === 'Conflict' ? u.conflict(o.paths.join(', ')) : o.kind === 'Check' ? u.check : u.unreadable;
}

/** The cards whose runs moved on since the reader last saw them (`seen`: each card's `updatedAt` then). */
export function updatedCards(cards: readonly { readonly key: string; readonly updatedAt: string }[], seen: ReadonlyMap<string, string>): string[] {
    return cards.filter((c) => seen.has(c.key) && seen.get(c.key) !== c.updatedAt).map((c) => c.key);
}
