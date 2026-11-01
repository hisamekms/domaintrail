// Replies to runs (ADR 0026, amendment "replies to runs"), without React: which AI turns can be replied to (an ended
// run: completed, failed, declined or cancelled — not one queued, running or waiting for an answer, which has its
// form), what the composer starts a reply with (the name of the replied run's card and the targets of its requests),
// and the reference a posted reply shows above its text (the card's name, the head of the run's summary, the card).
// A run is named by its card (`unitName`), never numbered: people read a card as one chunk of change.
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { unitName, type ChangeUnit } from './history';
import { MAX_REQUEST_TARGETS } from './mentions';
import { oneLine } from './stream';
import { targetKey, type TargetDraft } from './targets';

type RunJson = SessionStateBody['runs'][number];

/** The states of a run a message may reply to (the server's `REPLYABLE_STATES`). */
const REPLYABLE: ReadonlySet<RunJson['state']> = new Set(['Completed', 'Failed', 'Declined', 'Cancelled']);

/** Whether a run can be replied to now. */
export const isReplyable = (run: RunJson): boolean => REPLYABLE.has(run.state);

/** The reply being written: the run it replies to and the name of its card (「請求書の税区分」). */
export interface ReplyDraft {
    readonly run: string;
    readonly name: string;
}

/** The targets a reply to `run` starts with: those of the run's requests, each once, up to the limit (none: the whole workspace). */
export function replyTargets(run: RunJson): TargetDraft[] {
    const out: TargetDraft[] = [];
    const seen = new Set<string>();
    for (const r of run.input.requests)
        for (const t of r.targets) {
            const key = targetKey(t.target);
            if (seen.has(key) || out.length >= MAX_REQUEST_TARGETS) continue;
            seen.add(key);
            out.push({ target: t.target, ...(t.label !== undefined && { label: t.label }), ...(t.range && { range: t.range }) });
        }
    return out;
}

/** What a posted reply shows of the run it replies to: its card's name, the head of what the AI said, and its card. */
export interface ReplyReference {
    readonly run: string;
    /** The name of the card the run is on (`unitName`; empty for a card without a title nor message text). */
    readonly name: string;
    /** The reply's summary on one line (the page cuts it to the room), else a clarification's question; none for a run without words. */
    readonly summary: string | undefined;
    /** The state of the run, for a reference without a summary. */
    readonly state: RunJson['state'];
    /** The card (`ChangeUnit.key`) the run is on. */
    readonly card: string;
}

/** The reference of a reply to `run`, from the session's units; `undefined` when the run is not in them. */
export function replyReference(units: readonly ChangeUnit[], run: string): ReplyReference | undefined {
    for (const unit of units)
        for (const u of unit.runs) {
            if (u.run.id !== run) continue;
            const r = u.run;
            const reply = r.state === 'Completed' || r.state === 'NeedsClarification' || r.state === 'Declined' ? r.reply : undefined;
            const said = reply?.summary ?? (r.state === 'NeedsClarification' ? r.question : undefined);
            return {
                run,
                name: unitName(unit).text,
                summary: said === undefined || oneLine(said) === '' ? undefined : oneLine(said),
                state: r.state,
                card: unit.key,
            };
        }
    return undefined;
}
