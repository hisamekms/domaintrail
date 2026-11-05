// Redacting a message (ADR 0031, section 7): personal data must be deletable on request, and a knowledge item that is
// deleted takes the messages it came from with it. A message redacted keeps its row — who wrote it, when, about what,
// what it replied to — so that the talk around it still reads; its body becomes `REDACTED_BODY`, once (`redact`, the
// command of the Request aggregate, `commands.ts`).
//
// The body is copied in two other places, which are redacted with it: the input a run froze when it was queued (the
// message bundled, and the reply quoting it) and the `RequestSent` event in the outbox. Both are records, not
// aggregates with commands of their own: these functions say what each becomes.
import { Collaboration } from '../generated/index.js';

const made = Collaboration.makeText('（墨消し）');
if (!made.ok) throw new Error('The redacted body is not a text');

/** What a redacted message's body says. */
export const REDACTED_BODY: Collaboration.Text = made.value;

/** Whether a message's body was redacted. */
export const isRedacted = (request: Pick<Collaboration.RequestCommon, 'redactedAt'>): boolean => request.redactedAt !== undefined;

/**
 * A run's frozen input with the message `request` redacted: its body where the run bundled it, and where a message of
 * the run quotes it as what it replied to. `undefined` when the run holds nothing of it.
 */
export function redactedRun(run: Collaboration.AgentRun, request: Collaboration.RequestId): Collaboration.AgentRun | undefined {
    let changed = false;
    const requests = run.input.requests.map((r): Collaboration.FrozenRequest => {
        const body = r.request === request && r.body !== REDACTED_BODY ? REDACTED_BODY : r.body;
        const replyTo =
            r.replyTo?.kind === 'Message' && r.replyTo.request === request && r.replyTo.body !== REDACTED_BODY ? { ...r.replyTo, body: REDACTED_BODY } : r.replyTo;
        if (body === r.body && replyTo === r.replyTo) return r;
        changed = true;
        return { ...r, body, ...(replyTo && { replyTo }) };
    });
    if (!changed) return undefined;
    const [first, ...rest] = requests;
    if (first === undefined) return undefined;
    return { ...run, input: { ...run.input, requests: [first, ...rest] } };
}

/** The outbox's event with the message `request` redacted: its `RequestSent`; `undefined` for any other event. */
export function redactedEvent(event: Collaboration.PersistentEvent, request: Collaboration.RequestId): Collaboration.PersistentEvent | undefined {
    if (event.type !== 'RequestSent' || event.requestId !== request || event.body === REDACTED_BODY) return undefined;
    return { ...event, body: REDACTED_BODY };
}
