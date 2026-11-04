// The use cases of the journey file and the session's current journey (the plan's "The journey file" and "The current
// journey, and how journeys begin"): the explicit acts that change the file — a goal changed, a state set (done,
// archived), a mark set or cleared — written by dt itself (`updateJourneys`: read, changed, written whole, atomically,
// unless the file changed meanwhile; never over a file that does not read), and the session's current journey chosen.
// Both are the facilitator's (the one person's in Solo): a participant's are refused here (`FacilitatorOnly`); the
// server turns them into requests the facilitator approves. The guide's marks are the journey file's
// (`journeyFileMarks`, the `GuideMarkStore`).
import { Collaboration, err, ok, type Result } from '../generated/index.js';
import { journeyMarks, markAct, type GuideMarkStore } from '../domain/guide.js';
import {
    applyJourneyAct,
    journeyOf,
    readJourney,
    writeJourney,
    type JourneyAct,
    type JourneyActError,
    type JourneyFile,
    type JourneyProblem,
} from '../domain/journey.js';
import { requestCommands, sessionCommands } from '../domain/commands.js';
import { completionNote } from '../domain/journey-note.js';
import { knownRequestId } from '../domain/ids.js';
import { actFact, type JourneyLabels } from '../domain/records.js';
import { recordAct } from './records.js';
import type { Actor } from './actor.js';
import type { CollaborationDeps, JourneyFileStore, Stores } from './ports.js';
import { publish } from './queueing.js';
import { storeVerifications } from './verifications.js';

/** Why the journey file was not written. */
export type JourneyWriteError =
    /** No journey file can be written here (no store: a session without a workspace root). */
    | { readonly type: 'NoJourneyFile' }
    /** The file does not read against its schema: dt does not write over it (`dt check` says what to fix). */
    | { readonly type: 'JourneyFileInvalid'; readonly problems: readonly JourneyProblem[] }
    /** The file kept changing while dt wrote it (another tool, git). */
    | { readonly type: 'JourneyFileChanged' };

/**
 * Changes the journey file: reads it (none: no journeys), applies `change`, writes it whole with a stable key order —
 * unless the file changed since it was read, then once more from the file as it is now. The file is never written
 * over when it does not read (`JourneyFileInvalid`).
 */
export async function updateJourneys<T, E>(
    store: JourneyFileStore | undefined,
    change: (file: JourneyFile) => Result<{ readonly file: JourneyFile; readonly value: T }, E>,
): Promise<Result<{ readonly file: JourneyFile; readonly value: T }, E | JourneyWriteError>> {
    if (!store) return err({ type: 'NoJourneyFile' });
    for (let attempt = 0; attempt < 2; attempt++) {
        const before = await store.read();
        const read = before === undefined ? undefined : readJourney(before);
        if (read && read.problems.length > 0) return err({ type: 'JourneyFileInvalid', problems: read.problems });
        const changed = change(read?.file ?? { version: 1, stormings: {}, modeling: [] });
        if (!changed.ok) return changed;
        const text = writeJourney(changed.value.file);
        if (text === before) return changed;
        if (await store.write(text, before)) return changed;
    }
    return err({ type: 'JourneyFileChanged' });
}

/** The journey file as read now (none: no file, or no store). */
export async function readJourneys(
    store: JourneyFileStore | undefined,
): Promise<{ readonly text?: string; readonly file?: JourneyFile; readonly problems: readonly JourneyProblem[] }> {
    const text = await store?.read();
    if (text === undefined) return { problems: [] };
    const read = readJourney(text);
    return { text, file: read.file, problems: read.problems };
}

/**
 * The guide's marks kept in the journey file: those read (`file`), set and cleared as acts on it (the caller checks
 * who may: the facilitator's own, a participant's approved).
 */
export function journeyFileMarks(store: JourneyFileStore | undefined, file: JourneyFile | undefined): GuideMarkStore<JourneyActError | JourneyWriteError> {
    const write = async (key: Parameters<GuideMarkStore['set']>[0], done: boolean): Promise<Result<void, JourneyActError | JourneyWriteError>> => {
        const r = await updateJourneys<undefined, JourneyActError>(store, (f) => {
            const applied = applyJourneyAct(f, markAct(key, done));
            return applied.ok ? ok({ file: applied.value, value: undefined }) : applied;
        });
        return r.ok ? ok(undefined) : r;
    };
    return { read: () => journeyMarks(file), set: (k) => write(k, true), clear: (k) => write(k, false) };
}

type Closed = Collaboration.SessionNotFound | Collaboration.SessionAlreadyClosed;

export interface JourneyUseCases {
    /**
     * An act on the journey file (a goal changed, a state set, a mark set or cleared) by the facilitator (the one person in
     * Solo); anyone else's is `FacilitatorOnly`. dt writes the file itself. With a `session`, the act is recorded in its
     * chat when it changed the file (`records.ts`: a mark may extend the last record), and a journey marked done gets
     * dt's note with the next step (`completionNote`, in `language`).
     */
    actOnJourney(input: {
        readonly actor: Actor;
        readonly act: JourneyAct;
        readonly session?: Collaboration.SessionId;
        /** The journeys' names for the record (an ES journey's: its storming's label). */
        readonly labels?: JourneyLabels;
        /** The language of the note after a journey is marked done (absent: Japanese). */
        readonly language?: Collaboration.UiLanguage;
    }): Promise<Result<JourneyFile, Collaboration.FacilitatorOnly | JourneyActError | JourneyWriteError>>;
    /**
     * The session's current journey chosen (none: the most recently created active one) by the facilitator; a journey
     * chosen (not the default) is recorded in the chat.
     */
    chooseJourney(input: {
        readonly session: Collaboration.SessionId;
        readonly actor: Actor;
        readonly journey?: Collaboration.GuideJourneyKey;
        readonly labels?: JourneyLabels;
    }): Promise<Result<Collaboration.OpenSession, Collaboration.FacilitatorOnly | Collaboration.SessionNotFound | Closed>>;
}

export function createJourneys(deps: CollaborationDeps): JourneyUseCases {
    const { uow, clock, ids } = deps;
    return {
        async actOnJourney({ actor, act, session, labels, language }) {
            if (actor.role !== 'Facilitator') return err({ type: 'FacilitatorOnly' });
            let before: JourneyFile | undefined;
            const r = await updateJourneys<undefined, JourneyActError>(deps.journeys, (file) => {
                before = file;
                const applied = applyJourneyAct(file, act);
                return applied.ok ? ok({ file: applied.value, value: undefined }) : applied;
            });
            if (!r.ok) return r;
            // recorded when it changed the file (a mark already set, a goal already the goal: nothing happened)
            if (session && before && writeJourney(before) !== writeJourney(r.value.file))
                await uow.transaction(async (stores) => {
                    const active = await storeVerifications(stores).makeActiveSession(session);
                    if (!active.ok) return;
                    const at = clock.now();
                    const current = stores.sessions.load(session)?.currentJourney;
                    const fact = actFact({ act, before, ...(current !== undefined && { current }), ...(labels && { labels }) });
                    if (!fact) return;
                    recordAct(stores, ids.newId(), { session: active.value, by: actor.participant, fact, at });
                    if (fact.kind === 'StateChanged' && fact.state === 'Done') {
                        const ref = before && journeyOf(before, act.journey);
                        const note = completionNote({
                            journey: act.journey,
                            label: fact.journey.label,
                            language: language ?? 'Ja',
                            ...(ref?.kind === 'es' && { use: ref.entry.use }),
                        });
                        postCompletionNote(stores, ids.newId(), active.value, note.body, note.note, at);
                    }
                });
            return ok(r.value.file);
        },

        async chooseJourney({ session, actor, journey, labels }) {
            const file = journey === undefined ? undefined : (await readJourneys(deps.journeys)).file;
            return uow.transaction(async (stores) => {
                const active = await storeVerifications(stores).makeActiveSession(session);
                if (!active.ok) return active;
                const found = stores.sessions.load(session);
                if (!found || found.state !== 'Open') return err({ type: 'SessionAlreadyClosed' });
                const at = clock.now();
                const chosen = sessionCommands.chooseJourney(found, { journey, chosenByRole: actor.role, chosenAt: at });
                if (!chosen.ok) return chosen;
                stores.sessions.save(chosen.value.Open.aggregate);
                publish(stores, session, chosen.value.Open.events, at);
                // a person's choice is recorded (the default, none chosen, is not)
                const fact =
                    journey === undefined || journey === found.currentJourney
                        ? undefined
                        : actFact({ act: { kind: 'choose', journey }, before: file, ...(labels && { labels }) });
                if (fact) recordAct(stores, ids.newId(), { session: active.value, by: actor.participant, fact, at });
                return ok(chosen.value.Open.aggregate);
            });
        },
    };
}

/** A journey key as the session keeps it, when it is one. */
export const journeyKeyOf = (key: string): Collaboration.GuideJourneyKey | undefined => {
    const made = Collaboration.makeGuideJourneyKey(key);
    return made.ok ? made.value : undefined;
};

/** dt's note after a journey is marked done: the AI's message, answering none, inside the caller's transaction. */
function postCompletionNote(
    stores: Stores,
    id: string,
    session: Collaboration.ActiveSession,
    text: string,
    journeyNote: Collaboration.JourneyNote,
    at: Date,
): void {
    const body = Collaboration.makeText(text);
    if (!body.ok) return;
    const sent = requestCommands.answer({ id: knownRequestId(id), session, body: body.value, sentAt: at, journeyNote });
    if (!sent.ok) return;
    stores.requests.save(sent.value.Sent.aggregate);
    publish(stores, session, sent.value.Sent.events, at);
}
