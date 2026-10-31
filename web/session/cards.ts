// A card of the chat, without React (ADR 0026, amendment: messages and apply): one change unit (`history.ts`), its
// runs one under the other — what each run was asked (a quote of each message applied, with what the reply says of
// it), the facilitator's note or answer, and the agent's message — and the mark an applied message shows of its latest
// run (`✓ #3`). Everything is derived from the session's state on the page.
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
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

/** What an applied message shows of its latest run. */
export type MarkState = 'queued' | 'running' | 'clarification' | 'done' | 'partial' | 'skipped' | 'question' | 'declined' | 'failed' | 'cancelled';

export interface MessageMark {
    readonly state: MarkState;
    /** The run's number, and the card it is on (`ChangeUnit.key`). */
    readonly run: number;
    readonly card: string;
}

const PROGRESS: Record<RequestProgress, MarkState> = { Done: 'done', Partial: 'partial', Skipped: 'skipped', Question: 'question' };

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
        case 'Declined':
            return 'declined';
        case 'Failed':
            return 'failed';
        case 'Cancelled':
            return 'cancelled';
    }
}

/** The mark of every applied message, by its ID: its latest run (the last queued) and that run's card. */
export function messageMarks(units: readonly ChangeUnit[]): Map<string, MessageMark> {
    const latest = new Map<string, { run: RunJson; number: number; card: string }>();
    for (const unit of units)
        for (const { run, number } of unit.runs)
            for (const r of run.input.requests) {
                const seen = latest.get(r.request);
                if (!seen || run.queuedAt >= seen.run.queuedAt) latest.set(r.request, { run, number, card: unit.key });
            }
    return new Map([...latest].map(([request, { run, number, card }]) => [request, { state: markState(run, request), run: number, card }]));
}

/** The cards whose runs moved on since the reader last saw them (`seen`: each card's `updatedAt` then). */
export function updatedCards(cards: readonly { readonly key: string; readonly updatedAt: string }[], seen: ReadonlyMap<string, string>): string[] {
    return cards.filter((c) => seen.has(c.key) && seen.get(c.key) !== c.updatedAt).map((c) => c.key);
}
