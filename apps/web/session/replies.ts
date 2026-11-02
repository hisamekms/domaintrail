// Replies to runs (ADR 0026, amendment "replies to runs"), without React: which AI turns can be replied to (an ended
// run: completed, failed, declined or cancelled — not one queued, running or waiting for an answer, which has its
// form), what the composer starts a reply with (the name of the replied run's card and the targets of its requests),
// and the reference a posted reply shows above its text (the card's name, the head of the run's summary, the card).
// A run is named by its card (`unitName`), never numbered: people read a card as one chunk of change.
// Replies to messages (amendment "replies to messages"): any message can be replied to; the composer starts with its
// targets, a posted reply shows its author and the head of its body, and a reply to my message asks for my attention.
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { unitName, type ChangeUnit } from './history';
import { bodyText, MAX_REQUEST_TARGETS } from './mentions';
import { oneLine } from './stream';
import { targetKey, type TargetDraft } from './targets';

type RunJson = SessionStateBody['runs'][number];
type RequestJson = SessionStateBody['requests'][number];
type ReplyTargetJson = NonNullable<RequestJson['replyTo']>;

/** The states of a run a message may reply to (the server's `REPLYABLE_STATES`). */
const REPLYABLE: ReadonlySet<RunJson['state']> = new Set(['Completed', 'Failed', 'Declined', 'Cancelled']);

/** Whether a run can be replied to now. */
export const isReplyable = (run: RunJson): boolean => REPLYABLE.has(run.state);

/**
 * The reply being written: to a run, with the name of its card (「請求書の税区分」), or to a message, with its author
 * (named by their current name where it shows).
 */
export type ReplyDraft =
    | { readonly kind: 'Run'; readonly run: string; readonly name: string }
    | { readonly kind: 'Message'; readonly request: string; readonly author: string };

/** What a draft replies to, as the message is sent (`replyTo`). */
export const replyTargetOf = (draft: ReplyDraft): ReplyTargetJson =>
    draft.kind === 'Run' ? { kind: 'Run', run: draft.run } : { kind: 'Message', request: draft.request };

/** The targets of some requests as the composer's chips: each once, up to the limit. */
function targetDrafts(requests: readonly Pick<RequestJson, 'targets'>[]): TargetDraft[] {
    const out: TargetDraft[] = [];
    const seen = new Set<string>();
    for (const r of requests)
        for (const t of r.targets) {
            const key = targetKey(t.target);
            if (seen.has(key) || out.length >= MAX_REQUEST_TARGETS) continue;
            seen.add(key);
            out.push({ target: t.target, ...(t.label !== undefined && { label: t.label }), ...(t.range && { range: t.range }) });
        }
    return out;
}

/** The targets a reply to `run` starts with: those of the run's requests, each once, up to the limit (none: the whole workspace). */
export const replyTargets = (run: RunJson): TargetDraft[] => targetDrafts(run.input.requests);

/** The targets a reply to a message starts with: the message's own. */
export const messageReplyTargets = (request: Pick<RequestJson, 'targets'>): TargetDraft[] => targetDrafts([request]);

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

/** What a posted reply shows of the message it replies to: its author and the head of its body. */
export interface MessageReference {
    readonly request: string;
    readonly author: string;
    /** The body on one line, elements and people by the names they were written with (the page cuts it to the room). */
    readonly head: string;
}

/** The reference of a reply to the message `request`; `undefined` when the session does not hold it. */
export function messageReference(requests: readonly RequestJson[], request: string): MessageReference | undefined {
    const r = requests.find((q) => q.id === request);
    return r && { request, author: r.author, head: oneLine(bodyText(r.body, r.targets.length, r.mentions.length)) };
}

/**
 * Whether a message replies to a message of mine (or of the facilitator while I hold that role). My own replies never
 * do, as a mention of me (`mentionsMe`).
 */
export function repliesToMe(
    request: Pick<RequestJson, 'author' | 'replyTo'>,
    requests: readonly Pick<RequestJson, 'id' | 'author'>[],
    state: Pick<SessionStateBody, 'session' | 'facilitatorHolder'>,
    me: string,
): boolean {
    const to = request.replyTo;
    if (request.author === me || to?.kind !== 'Message') return false;
    const author = requests.find((r) => r.id === to.request)?.author;
    return author === me || (me === state.facilitatorHolder && author === state.session.facilitator);
}
