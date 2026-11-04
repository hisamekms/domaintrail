// The journey file in the session server (the plan's "The journey file" and "The current journey"): the file as read
// now (re-read when it changes on disk: a write of dt, git or another tool), sent to every page (`journey`), with what
// is wrong with it; the facilitator's acts on it and on the session's current journey, done at once; a participant's,
// kept as requests the facilitator approves or denies. Each act and request is recorded in the session's chat
// (`records.ts`), the requests' outcomes on their records: the requests waiting are rebuilt from those records when the
// server starts. A change of the file that dt did not write (git, an editor: its text is none of those dt wrote) is
// recorded with what changed. What the guide reads of it: the file, and `dt check`'s findings on it against the
// workspace's names.
import { randomUUID } from 'node:crypto';
import {
    type Actor,
    type Collaboration,
    type CollaborationUseCases,
    JOURNEY_FILE,
    journeyDiagnostics,
    journeyKeyOf,
    journeyNames,
    readJourney,
    type JourneyAct,
    type JourneyFile,
    type JourneyFileStore,
    type JourneyLabels,
    type JourneyProblem,
} from '@domaintrail/collaboration';
import type { JourneyBody, JourneyRequestAct, JourneyRequestBody } from '@domaintrail/collaboration/protocol';
import type { Diagnostic } from '@domaintrail/kernel';

/** The most requests kept waiting (the oldest dropped). */
export const MAX_JOURNEY_REQUESTS = 20;

/** Why a journey act or choice was not done. */
export interface JourneyRefusal {
    readonly type: string;
    readonly message?: string;
}

/** The language of dt's note after a journey is marked done: the page's that asked. */
export type NoteLanguage = 'ja' | 'en';

/**
 * The journey file as dt writes it, remembering what it wrote: a later read of one of those texts is dt's own write,
 * any other is a change from outside (git, an editor).
 */
export interface RememberedJourneyFile extends JourneyFileStore {
    /** Whether `text` is one dt wrote (the last few). */
    wrote(text: string | undefined): boolean;
}

/** How many of dt's own writes are remembered. */
const REMEMBERED_WRITES = 20;

export function rememberWrites(store: JourneyFileStore): RememberedJourneyFile {
    const written: string[] = [];
    return {
        read: () => store.read(),
        async write(text, expected) {
            // remembered before the write lands: the watcher may read it before the write returns
            written.push(text);
            if (written.length > REMEMBERED_WRITES) written.shift();
            return store.write(text, expected);
        },
        wrote: (text) => text !== undefined && written.includes(text),
    };
}

export interface SessionJourneys {
    /** The body the pages get. */
    body(): JourneyBody;
    /** The file as read now (none: no file). */
    file(): JourneyFile | undefined;
    /** `dt check`'s findings on the file against the names given (the workspace's contexts and stormings). */
    diagnostics(names: { readonly contexts: Iterable<string>; readonly stormings: Iterable<string> }): Diagnostic[];
    /** Reads the file again; tells the pages when it changed (and records a change dt did not write). */
    reload(): Promise<void>;
    /** The requests still waiting, rebuilt from their records (when the server starts). */
    restore(): Promise<void>;
    /** An act on the file: done at once by the facilitator, else requested of them. */
    act(
        actor: Actor,
        name: string,
        act: JourneyAct,
        language?: NoteLanguage,
    ): Promise<{ readonly done: boolean; readonly request?: JourneyRequestBody } | JourneyRefusal>;
    /** The current journey chosen: done at once by the facilitator, else requested of them. */
    choose(actor: Actor, name: string, journey: string | null): Promise<{ readonly done: boolean; readonly request?: JourneyRequestBody } | JourneyRefusal>;
    /** The facilitator approves a request (done as theirs) or denies it. */
    decide(actor: Actor, id: string, approve: boolean, language?: NoteLanguage): Promise<{ readonly done: boolean } | JourneyRefusal>;
    /** Its requester withdraws a request. */
    withdraw(actor: Actor, id: string): Promise<{ readonly done: boolean } | JourneyRefusal>;
}

const refusal = (e: { readonly type: string; readonly message?: string }): JourneyRefusal => ({
    type: e.type,
    ...(e.message !== undefined && { message: e.message }),
});

/** What a refusal of the file says, in a line. */
function writeMessage(e: { readonly type: string; readonly problems?: readonly JourneyProblem[] }): string | undefined {
    switch (e.type) {
        case 'JourneyFileInvalid':
            return `${JOURNEY_FILE} does not read (${e.problems?.[0]?.path || 'the file'}: ${e.problems?.[0]?.message ?? ''}): fix it first (dt check).`;
        case 'JourneyFileChanged':
            return `${JOURNEY_FILE} kept changing while it was written: try again.`;
        case 'NoJourneyFile':
            return 'This session has no journey file.';
        default:
            return undefined;
    }
}

export function createSessionJourneys(deps: {
    readonly session: Collaboration.SessionId;
    /** The file (dt's writes remembered: `rememberWrites`; a plain store records every change it did not see written). */
    readonly store: JourneyFileStore | RememberedJourneyFile;
    /** The journeys' names for the records (an ES journey's: its storming's label). */
    readonly labels?: JourneyLabels;
    readonly collaboration: CollaborationUseCases;
    /** Tells every page (the body changed). */
    readonly changed: (body: JourneyBody) => void;
    /** Sends the session's new events to the pages (a record written outside a route: the file changed outside dt). */
    readonly recorded?: () => Promise<void>;
    readonly now: () => Date;
    readonly log: (line: string) => void;
}): SessionJourneys {
    let text: string | undefined;
    let read = readJourney('');
    let file: JourneyFile | undefined;
    let requests: JourneyRequestBody[] = [];
    // read once: a change before it is no change seen
    let seen = false;
    const labels = deps.labels;
    const store = deps.store;
    const dtWrote = (t: string | undefined): boolean => 'wrote' in store && store.wrote(t);

    const body = (): JourneyBody => ({ file: file ?? null, problems: text === undefined ? [] : read.problems, requests });
    const tell = (): void => deps.changed(body());
    const language = (l: NoteLanguage | undefined): Collaboration.UiLanguage | undefined => (l === undefined ? undefined : l === 'en' ? 'En' : 'Ja');
    const log =
        (what: string) =>
        (r: { readonly ok: boolean; readonly error?: unknown }): void => {
            if (!r.ok) deps.log(`${what} not recorded: ${JSON.stringify(r.error)}`);
        };

    const reload = async (): Promise<void> => {
        const now = await deps.store.read().catch((e: unknown) => {
            deps.log(`${JOURNEY_FILE}: ${e instanceof Error ? e.message : String(e)}`);
            return text;
        });
        if (now === text && seen) return;
        const before = text === undefined ? undefined : file;
        const outside = seen && !dtWrote(now);
        seen = true;
        text = now;
        read = readJourney(now ?? '');
        file = now === undefined ? undefined : read.file;
        tell();
        // a change dt did not write: recorded with what changed (nothing when nothing that matters did)
        if (outside) {
            log('the journey file changed outside dt')(
                await deps.collaboration.recordJourneyFileChange({
                    session: deps.session,
                    before,
                    after: file,
                    unreadable: now !== undefined && read.problems.length > 0,
                    ...(labels && { labels }),
                }),
            );
            await deps.recorded?.().catch((e: unknown) => deps.log(`the journey file's record not sent: ${e instanceof Error ? e.message : String(e)}`));
        }
    };

    const apply = async (actor: Actor, act: JourneyRequestAct, l?: NoteLanguage): Promise<{ readonly done: true } | JourneyRefusal> => {
        if (act.kind === 'choose') {
            const key = act.journey === null ? undefined : journeyKeyOf(act.journey);
            if (act.journey !== null && !key) return { type: 'InvalidInput', message: 'Not a journey.' };
            const chosen = await deps.collaboration.chooseJourney({ session: deps.session, actor, ...(key && { journey: key }), ...(labels && { labels }) });
            return chosen.ok ? { done: true } : refusal(chosen.error);
        }
        const lang = language(l);
        const done = await deps.collaboration.actOnJourney({ actor, act, session: deps.session, ...(labels && { labels }), ...(lang && { language: lang }) });
        if (!done.ok) return refusal({ type: done.error.type, ...(writeMessage(done.error) !== undefined && { message: writeMessage(done.error) }) });
        await reload();
        return { done: true };
    };

    /** What became of a request, written on its record. */
    const decided = async (id: string, outcome: Collaboration.JourneyRequestOutcome, by: Collaboration.ParticipantId): Promise<void> => {
        log('a request about the journeys')(await deps.collaboration.decideJourneyRequest({ session: deps.session, request: id, outcome, by }));
    };

    const request = async (actor: Actor, name: string, act: JourneyRequestAct): Promise<{ readonly done: false; readonly request: JourneyRequestBody }> => {
        // one request of a person per journey and kind: a new one replaces it (the one replaced: withdrawn)
        const same = (r: JourneyRequestBody): boolean =>
            r.by === actor.participant && r.act.kind === act.kind && (r.act.kind === 'choose' || (act.kind !== 'choose' && r.act.journey === act.journey));
        const made: JourneyRequestBody = { id: randomUUID(), by: actor.participant, byName: name, act, at: deps.now().toISOString() };
        const replaced = requests.filter(same);
        requests = [...requests.filter((r) => !same(r)), made].slice(-MAX_JOURNEY_REQUESTS);
        tell();
        for (const r of replaced) await decided(r.id, 'Withdrawn', actor.participant);
        log('a request about the journeys')(
            await deps.collaboration.recordJourneyRequest({
                session: deps.session,
                actor,
                request: made.id,
                act,
                ...(file && { file }),
                ...(labels && { labels }),
            }),
        );
        return { done: false, request: made };
    };

    return {
        body,
        file: () => file,
        diagnostics: (names) => (text === undefined ? [] : journeyDiagnostics(text, journeyNames(names.contexts, names.stormings))),
        reload,
        async restore() {
            const open = await deps.collaboration.openJourneyRequests({ session: deps.session });
            if (open.length === 0) return;
            const state = await deps.collaboration.sessionState({ session: deps.session });
            const names = new Map(state.ok ? state.value.session.participants.map((p) => [p.id, p.name]) : []);
            requests = open.slice(-MAX_JOURNEY_REQUESTS).map((r) => ({
                id: r.id,
                by: r.by,
                byName: names.get(r.by) ?? r.by,
                act: r.act,
                at: r.at.toISOString(),
            }));
            tell();
        },
        async act(actor, name, act, l) {
            if (actor.role !== 'Facilitator') {
                if (text !== undefined && read.problems.length > 0)
                    return { type: 'JourneyFileInvalid', message: writeMessage({ type: 'JourneyFileInvalid', problems: read.problems }) };
                return request(actor, name, act);
            }
            return apply(actor, act, l);
        },
        async choose(actor, name, journey) {
            if (actor.role !== 'Facilitator') return request(actor, name, { kind: 'choose', journey });
            return apply(actor, { kind: 'choose', journey });
        },
        async decide(actor, id, approve, l) {
            if (actor.role !== 'Facilitator') return { type: 'FacilitatorOnly' };
            const r = requests.find((x) => x.id === id);
            if (!r) return { type: 'NotFound', message: 'No such request (approved, denied or withdrawn already).' };
            if (approve) {
                // done as the facilitator's own (recorded as theirs): a refusal leaves the request waiting
                const done = await apply(actor, r.act, l);
                if (!('done' in done)) return done;
            }
            requests = requests.filter((x) => x.id !== id);
            tell();
            await decided(id, approve ? 'Approved' : 'Denied', actor.participant);
            return { done: true };
        },
        async withdraw(actor, id) {
            const r = requests.find((x) => x.id === id);
            if (!r) return { type: 'NotFound' };
            if (r.by !== actor.participant) return { type: 'NotTheRequester' };
            requests = requests.filter((x) => x.id !== id);
            tell();
            await decided(id, 'Withdrawn', actor.participant);
            return { done: true };
        },
    };
}

/** No journey file: what a page shows before the server tells it. */
export const NO_JOURNEYS_BODY: JourneyBody = { file: null, problems: [], requests: [] };

/** An act on the journey file as a page sends it (`{ kind, journey, … }`), checked for its shape (what it names is the file's). */
export function journeyActInput(
    v: unknown,
): { ok: true; value: JourneyAct } | { ok: false; error: { readonly type: 'InvalidInput'; readonly field: string; readonly message: string } } {
    const bad = (
        field: string,
        message: string,
    ): { ok: false; error: { readonly type: 'InvalidInput'; readonly field: string; readonly message: string } } => ({
        ok: false,
        error: { type: 'InvalidInput', field, message },
    });
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return bad('act', 'Expected an object.');
    const o: Record<string, unknown> = { ...v };
    const short = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 100;
    if (!short(o.journey)) return bad('act.journey', 'Expected a journey key.');
    switch (o.kind) {
        case 'goal':
            if (Object.keys(o).some((k) => !['kind', 'journey', 'goal'].includes(k))) return bad('act', 'Unknown field.');
            return short(o.goal) ? { ok: true, value: { kind: 'goal', journey: o.journey, goal: o.goal } } : bad('act.goal', 'Expected a goal.');
        case 'state':
            if (Object.keys(o).some((k) => !['kind', 'journey', 'state'].includes(k))) return bad('act', 'Unknown field.');
            return o.state === 'active' || o.state === 'done' || o.state === 'archived'
                ? { ok: true, value: { kind: 'state', journey: o.journey, state: o.state } }
                : bad('act.state', 'Expected active, done or archived.');
        case 'mark':
            if (Object.keys(o).some((k) => !['kind', 'journey', 'step', 'context', 'done'].includes(k))) return bad('act', 'Unknown field.');
            if (!short(o.step)) return bad('act.step', 'Expected a step.');
            if (o.context !== undefined && !short(o.context)) return bad('act.context', 'Expected a context.');
            if (typeof o.done !== 'boolean') return bad('act.done', 'Expected true or false.');
            return {
                ok: true,
                value: { kind: 'mark', journey: o.journey, step: o.step, ...(o.context !== undefined && { context: o.context as string }), done: o.done },
            };
        default:
            return bad('act.kind', 'Expected goal, state or mark.');
    }
}
