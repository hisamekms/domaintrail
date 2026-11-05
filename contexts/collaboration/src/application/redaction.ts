// Redacting the messages a deleted knowledge item came from (ADR 0031, section 7): the knowledge store's redaction log
// names them by session and message, and every dt redacts those its own session database holds (old sessions live on
// several machines). Each is redacted in one transaction with the copies of its body (`domain/redaction.ts`): the
// message itself (`redact`), the runs that froze it, and its `RequestSent` in the outbox. A message this database does
// not hold, of another session than named, or redacted already is left as it is: reading the log again is harmless.
import { Collaboration } from '../generated/index.js';
import { requestCommands } from '../domain/commands.js';
import { REDACTED_BODY, redactedEvent, redactedRun } from '../domain/redaction.js';
import type { Clock, UnitOfWork } from './ports.js';

/** A message named by the redaction log: its session and its ID, as the knowledge store keeps them (plain strings). */
export interface MessageToRedact {
    readonly session: string;
    readonly message: string;
}

/** What a redaction did: the messages redacted now, and the sessions they were in. */
export interface Redacted {
    readonly requests: readonly Collaboration.RequestId[];
    readonly sessions: readonly Collaboration.SessionId[];
}

export interface Redaction {
    /** Redacts the messages this database holds (see the module's comment). */
    redactMessages(messages: readonly MessageToRedact[]): Promise<Redacted>;
}

export function createRedaction(deps: { readonly uow: UnitOfWork; readonly clock: Clock }): Redaction {
    return {
        redactMessages: (messages) =>
            deps.uow.transaction((stores) => {
                const requests: Collaboration.RequestId[] = [];
                const sessions = new Set<Collaboration.SessionId>();
                const at = deps.clock.now();
                for (const { session, message } of messages) {
                    const id = Collaboration.makeRequestId(message);
                    if (!id.ok) continue;
                    const request = stores.requests.load(id.value);
                    if (!request || request.session !== session || request.redactedAt !== undefined) continue;
                    const decided = requestCommands.redact(request, { body: REDACTED_BODY, at });
                    if (!decided.ok) continue;
                    const redacted = 'Sent' in decided.value ? decided.value.Sent.aggregate : decided.value.Dismissed.aggregate;
                    stores.requests.save(redacted);
                    for (const run of stores.runs.listBySession(request.session)) {
                        const changed = redactedRun(run, request.id);
                        if (changed) stores.runs.save(changed);
                    }
                    for (const entry of stores.outbox.requestSent(request.id)) {
                        const changed = redactedEvent(entry.event, request.id);
                        if (changed) stores.outbox.replace(entry.seq, changed);
                    }
                    requests.push(request.id);
                    sessions.add(request.session);
                }
                return { requests, sessions: [...sessions] };
            }),
    };
}
