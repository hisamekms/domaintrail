// The session's records (`domain/records.ts`): written by dt, in the transaction of what they record when there is one
// (an interview stopped, a brief rejected), else right after it (an act on the journey file, written outside the
// stores). The ✓ merge looks at the session's stream: a mark extends the last record when that record is the latest
// thing in the stream and the same person's marks on the same journey in the same direction. A participant's requests
// about the journeys are records too: kept in the session (they survive a restart; the server rebuilds its waiting
// requests from them), their outcome written on the same record.
import { Collaboration, err, ok, type Result } from '../generated/index.js';
import { isOpenRequest, journeyActOf, journeyFileChanges, mergedMarks, recordCommands, requestedAct, type JourneyLabels } from '../domain/records.js';
import type { JourneyAct, JourneyFile } from '../domain/journey.js';
import type { Actor } from './actor.js';
import type { CollaborationDeps, Stores } from './ports.js';
import { publish } from './queueing.js';
import { storeVerifications } from './verifications.js';

type SessionId = Collaboration.SessionId;
type Closed = Collaboration.SessionNotFound | Collaboration.SessionAlreadyClosed;

/** A participant's act on the journeys, as a request keeps it. */
export type RequestedAct = JourneyAct | { readonly kind: 'choose'; readonly journey: string | null };

/** A request about the journeys still waiting for the facilitator, as its record keeps it. */
export interface OpenJourneyRequest {
    readonly id: string;
    readonly by: Collaboration.ParticipantId;
    readonly act: RequestedAct;
    readonly at: Date;
}

/**
 * Whether anything came into the session's stream after `at` (a message, a card's first run, a proposal, a command, a
 * restore, another record): the ✓ merge stops there.
 */
export function laterInStream(stores: Stores, session: SessionId, at: Date, except: Collaboration.SessionRecordId): boolean {
    const after = (d: Date | undefined): boolean => d !== undefined && d.getTime() > at.getTime();
    return (
        stores.requests.listBySession(session).some((r) => after(r.sentAt)) ||
        stores.runs.listBySession(session).some((r) => after(r.queuedAt)) ||
        stores.proposals.listBySession(session).some((p) => after(p.proposedAt)) ||
        stores.slashCommands.listBySession(session).some((c) => after(c.startedAt)) ||
        stores.revisions.listBySession(session).some((r) => r.origin.kind === 'Restored' && after(r.takenAt)) ||
        stores.records.listBySession(session).some((r) => r.id !== except && after(r.at))
    );
}

/** A new record, inside the caller's transaction. */
export function writeRecord(
    stores: Stores,
    id: string,
    input: {
        readonly session: Collaboration.ActiveSession;
        readonly by?: Collaboration.ParticipantId;
        readonly fact: Collaboration.RecordFact;
        readonly replyTo?: Collaboration.RequestId;
        readonly at: Date;
    },
): Collaboration.SessionRecord | undefined {
    const recordId = Collaboration.makeSessionRecordId(id);
    if (!recordId.ok) return undefined;
    const written = recordCommands.write({ id: recordId.value, ...input });
    if (!written.ok) return undefined;
    stores.records.save(written.value.Written.aggregate);
    publish(stores, input.session, written.value.Written.events, input.at);
    return written.value.Written.aggregate;
}

/** A record written again (marks merged, a request's outcome), inside the caller's transaction. */
function reviseRecord(stores: Stores, record: Collaboration.SessionRecord, fact: Collaboration.RecordFact, at: Date): Collaboration.SessionRecord {
    const revised = recordCommands.revise(record, { fact, revisedAt: at });
    if (!revised.ok) return record;
    stores.records.save(revised.value.Written.aggregate);
    publish(stores, record.session, revised.value.Written.events, at);
    return revised.value.Written.aggregate;
}

/**
 * A person's act, recorded inside the caller's transaction: a mark extends the last record when the ✓ merge allows
 * (`domain/records.ts`), else a record of its own.
 */
export function recordAct(
    stores: Stores,
    id: string,
    input: {
        readonly session: Collaboration.ActiveSession;
        readonly by: Collaboration.ParticipantId;
        readonly fact: Collaboration.RecordFact;
        readonly at: Date;
    },
): Collaboration.SessionRecord | undefined {
    const { fact } = input;
    if (fact.kind === 'MarksChanged') {
        const last = stores.records
            .listBySession(input.session)
            .reduce<Collaboration.SessionRecord | undefined>((a, r) => (!a || r.at.getTime() >= a.at.getTime() ? r : a), undefined);
        const merged = last && mergedMarks(last, input.by, fact, laterInStream(stores, input.session, last.at, last.id));
        if (last && merged) return reviseRecord(stores, last, merged, input.at);
    }
    return writeRecord(stores, id, input);
}

export interface RecordUseCases {
    /** A participant's request about the journeys (waiting for the facilitator), recorded. */
    recordJourneyRequest(input: {
        readonly session: SessionId;
        readonly actor: Actor;
        /** The request's ID (the server's). */
        readonly request: string;
        readonly act: RequestedAct;
        /** The journey file now (the journey's name). */
        readonly file?: JourneyFile;
        readonly labels?: JourneyLabels;
    }): Promise<Result<Collaboration.SessionRecord, Closed | { readonly type: 'InvalidInput' }>>;
    /** What became of a request (approved, denied, withdrawn), written on its record. Nothing when it has none. */
    decideJourneyRequest(input: {
        readonly session: SessionId;
        readonly request: string;
        readonly outcome: Collaboration.JourneyRequestOutcome;
        readonly by: Collaboration.ParticipantId;
    }): Promise<Result<Collaboration.SessionRecord | undefined, never>>;
    /** The requests about the journeys still waiting, from their records, oldest first. */
    openJourneyRequests(input: { readonly session: SessionId }): Promise<readonly OpenJourneyRequest[]>;
    /**
     * The journey file changed outside dt (a write that is not dt's): recorded with what changed, unless nothing that
     * matters did (the same journeys, goals, states, marks and briefs, and the file still reads).
     */
    recordJourneyFileChange(input: {
        readonly session: SessionId;
        readonly before: JourneyFile | undefined;
        readonly after: JourneyFile | undefined;
        /** The file as it is now does not read (its valid part is `after`). */
        readonly unreadable: boolean;
        readonly labels?: JourneyLabels;
    }): Promise<Result<Collaboration.SessionRecord | undefined, Closed>>;
}

export function createRecords(deps: CollaborationDeps): RecordUseCases {
    const { uow, clock, ids } = deps;
    const recordOf = (stores: Stores, session: SessionId, request: string): Collaboration.SessionRecord | undefined =>
        stores.records.listBySession(session).find((r) => r.fact.kind === 'JourneyRequested' && r.fact.request === request);
    return {
        async recordJourneyRequest({ session, actor, request, act, file, labels }) {
            const requestId = Collaboration.makeJourneyRequestId(request);
            const asked = requestedAct(act, file, labels);
            if (!requestId.ok || !asked) return err({ type: 'InvalidInput' });
            return uow.transaction(async (stores) => {
                const active = await storeVerifications(stores).makeActiveSession(session);
                if (!active.ok) return active;
                const fact: Collaboration.RecordFact = { kind: 'JourneyRequested', request: requestId.value, act: asked };
                const written = writeRecord(stores, ids.newId(), { session: active.value, by: actor.participant, fact, at: clock.now() });
                return written ? ok(written) : err({ type: 'InvalidInput' });
            });
        },

        async decideJourneyRequest({ session, request, outcome, by }) {
            return uow.transaction((stores) => {
                const record = recordOf(stores, session, request);
                if (!record || record.fact.kind !== 'JourneyRequested' || record.fact.outcome !== undefined) return ok(undefined);
                return ok(reviseRecord(stores, record, { ...record.fact, outcome, decidedBy: by }, clock.now()));
            });
        },

        async openJourneyRequests({ session }) {
            return uow.transaction((stores) =>
                stores.records
                    .listBySession(session)
                    .flatMap((r): OpenJourneyRequest[] =>
                        r.fact.kind === 'JourneyRequested' && isOpenRequest(r) && r.by !== undefined
                            ? [{ id: r.fact.request, by: r.by, act: journeyActOf(r.fact.act), at: r.at }]
                            : [],
                    ),
            );
        },

        async recordJourneyFileChange({ session, before, after, unreadable, labels }) {
            const { changes, more } = journeyFileChanges(before, after, labels);
            if (changes.length === 0 && more === 0 && !unreadable) return ok(undefined);
            return uow.transaction(async (stores) => {
                const active = await storeVerifications(stores).makeActiveSession(session);
                if (!active.ok) return active;
                const tally = Collaboration.makeTally(more);
                if (!tally.ok) return ok(undefined);
                const fact: Collaboration.RecordFact = { kind: 'FileChangedOutside', changes: [...changes], more: tally.value, unreadable };
                return ok(writeRecord(stores, ids.newId(), { session: active.value, fact, at: clock.now() }));
            });
        },
    };
}
