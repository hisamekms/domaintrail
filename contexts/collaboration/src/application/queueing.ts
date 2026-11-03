// Queueing a run, shared by the use cases that queue one (the facilitator's `queueRun`, an approval of proposals, a
// triaged change request that goes straight to the queue): the requests frozen into the run's input, inside the
// transaction that saves it.
import { Collaboration, eventList, err, ok, type Result } from '../generated/index.js';
import { agentRunCommands } from '../domain/commands.js';
import { knownAgentRunId } from '../domain/ids.js';
import { nonEmpty } from '../domain/snapshot.js';
import type { IdGenerator, Stores } from './ports.js';
import { storeVerifications } from './verifications.js';

/** Appends a command's events to the outbox of its session. */
export function publish(stores: Stores, session: Collaboration.SessionId, events: object, at: Date): void {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every event of the collaboration model is persistent: `events` is a command's events object
    stores.outbox.append(session, eventList(events) as readonly Collaboration.PersistentEvent[], at);
}

/**
 * What a request replies to, as a run's input freezes it: a run by its ID; a message with its author and body as they
 * are now (a message is never changed, so they are as it was sent). A message the store no longer holds (it never
 * forgets one) is left out.
 */
export function frozenReplyTarget(target: Collaboration.ReplyTarget | undefined, stores: Stores): Collaboration.FrozenReplyTarget | undefined {
    if (target === undefined || target.kind === 'Run') return target;
    const original = stores.requests.load(target.request);
    return original && { kind: 'Message', request: original.id, author: original.author, body: original.body };
}

/** No requests to bundle. */
export interface NoRequests {
    readonly type: 'NoRequests';
}

export type FreezeError = Collaboration.RequestNotFound | Collaboration.RequestOfAnotherSession | Collaboration.RequestAlreadyDismissed | NoRequests;

/** The requests verified pending in the session, and their content frozen once each (a request given twice is the queue command's DuplicateRequest). */
export async function freezeRequests(
    stores: Stores,
    session: Collaboration.SessionId,
    requests: readonly Collaboration.RequestId[],
): Promise<
    Result<
        {
            readonly pending: readonly [Collaboration.PendingRequest, ...Collaboration.PendingRequest[]];
            readonly frozen: readonly [Collaboration.FrozenRequest, ...Collaboration.FrozenRequest[]];
        },
        FreezeError
    >
> {
    const verify = storeVerifications(stores);
    const pending: Collaboration.PendingRequest[] = [];
    const frozen: Collaboration.FrozenRequest[] = [];
    for (const id of requests) {
        const p = await verify.makePendingRequest(id, session);
        if (!p.ok) return p;
        pending.push(p.value);
        const r = stores.requests.load(id);
        if (r && !frozen.some((f) => f.request === id)) {
            const replyTo = frozenReplyTarget(r.replyTo, stores);
            frozen.push({
                request: id,
                author: r.author,
                targets: r.targets,
                body: r.body,
                ...(replyTo && { replyTo }),
                ...(r.reverts && { reverts: r.reverts }),
            });
        }
    }
    const bundled = nonEmpty(pending);
    const input = nonEmpty(frozen);
    if (!bundled || !input) return err({ type: 'NoRequests' });
    return ok({ pending: bundled, frozen: input });
}

/**
 * Queues a run of `requests` (frozen into its input with `extra`), by the facilitator: saved and published in the
 * caller's transaction. `id` is the new run's ID.
 */
export async function queueRequests(
    stores: Stores,
    ids: IdGenerator,
    args: {
        readonly session: Collaboration.ActiveSession;
        readonly requests: readonly Collaboration.RequestId[];
        readonly extra?: Omit<Collaboration.RunInput, 'requests'>;
        readonly queuedBy: Collaboration.ParticipantId;
        readonly queuedByRole: Collaboration.ParticipantRole;
        readonly at: Date;
    },
): Promise<Result<Collaboration.QueuedAgentRun, FreezeError | Collaboration.FacilitatorOnly | Collaboration.DuplicateRequest | Collaboration.InputMismatch>> {
    const frozen = await freezeRequests(stores, args.session, args.requests);
    if (!frozen.ok) return frozen;
    const queued = agentRunCommands.queue({
        id: knownAgentRunId(ids.newId()),
        session: args.session,
        requests: frozen.value.pending,
        input: { ...args.extra, requests: frozen.value.frozen },
        queuedBy: args.queuedBy,
        queuedByRole: args.queuedByRole,
        queuedAt: args.at,
    });
    if (!queued.ok) return queued;
    stores.runs.enqueue(queued.value.Queued.aggregate);
    publish(stores, args.session, queued.value.Queued.events, args.at);
    return ok(queued.value.Queued.aggregate);
}
