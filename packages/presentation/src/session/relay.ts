// From the outbox to the pages: the events the use cases appended, read in order after each change (and
// periodically) and sent over the WebSocket as `EventMessage`s. The agent's SSE streams read the outbox themselves
// (from their own cursor); the relay only wakes them.
import type { OutboxEntry } from '@domaintrail/collaboration/application/ports';
import type { CollaborationUseCases } from '@domaintrail/collaboration/application/use-cases';
import type { Collaboration } from '@domaintrail/collaboration/generated/index';
import { EVENT_MESSAGE_TYPES, type EventMessage } from '@domaintrail/collaboration/protocol';

/** How many events one read takes from the outbox. */
const PAGE = 200;

export interface EventRelay {
    /** The outbox position the pages have been sent up to. */
    cursor(): number;
    /** Sends the events appended since the last pump; resolves once they are sent. Pumps run one at a time. */
    pump(): Promise<void>;
}

/** An outbox entry as the message of its event (dates become ISO strings when it is encoded). */
export function eventMessage(entry: OutboxEntry): EventMessage {
    const message = { type: EVENT_MESSAGE_TYPES[entry.event.type], seq: entry.seq, event: entry.event };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the type is looked up from the event's own type, and the event becomes its JSON when encoded
    return message as unknown as EventMessage;
}

/** The outbox position of the session's last event: where a relay started now begins. */
export async function lastSeq(collaboration: CollaborationUseCases, session: Collaboration.SessionId): Promise<number> {
    let cursor = 0;
    for (;;) {
        const entries = await collaboration.eventsAfter({ session, cursor, limit: 1000 });
        if (!entries.length) return cursor;
        cursor = entries[entries.length - 1].seq;
    }
}

export function createEventRelay(deps: {
    readonly collaboration: CollaborationUseCases;
    readonly session: Collaboration.SessionId;
    /** Where the pages start: the last event already reflected in what they load. */
    readonly from: number;
    readonly publish: (message: EventMessage) => void;
    /** After each pump that read something: e.g. wake the agent's streams, notice the session closed. */
    readonly after?: (entries: readonly OutboxEntry[]) => void;
}): EventRelay {
    let cursor = deps.from;
    let tail: Promise<void> = Promise.resolve();
    const run = async (): Promise<void> => {
        const read: OutboxEntry[] = [];
        for (;;) {
            const entries = await deps.collaboration.eventsAfter({ session: deps.session, cursor, limit: PAGE });
            for (const entry of entries) {
                cursor = entry.seq;
                deps.publish(eventMessage(entry));
                read.push(entry);
            }
            if (entries.length < PAGE) break;
        }
        if (read.length) deps.after?.(read);
    };
    return {
        cursor: () => cursor,
        pump() {
            const next = tail.then(run);
            tail = next.catch(() => undefined);
            return next;
        },
    };
}
