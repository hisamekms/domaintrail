// The journey file in the session server (the plan's "The journey file" and "The current journey"): the file as read
// now (re-read when it changes on disk: a write of dt, git or another tool), sent to every page (`journey`), with what
// is wrong with it; the facilitator's acts on it and on the session's current journey, done at once; a participant's,
// kept as requests the facilitator approves or denies — in memory, as the join requests of the `link` mode are (a
// restart drops them; the participant asks again). What the guide reads of it: the file, and `dt check`'s findings on
// it against the workspace's names.
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

export interface SessionJourneys {
    /** The body the pages get. */
    body(): JourneyBody;
    /** The file as read now (none: no file). */
    file(): JourneyFile | undefined;
    /** `dt check`'s findings on the file against the names given (the workspace's contexts and stormings). */
    diagnostics(names: { readonly contexts: Iterable<string>; readonly stormings: Iterable<string> }): Diagnostic[];
    /** Reads the file again; tells the pages when it changed. */
    reload(): Promise<void>;
    /** An act on the file: done at once by the facilitator, else requested of them. */
    act(actor: Actor, name: string, act: JourneyAct): Promise<{ readonly done: boolean; readonly request?: JourneyRequestBody } | JourneyRefusal>;
    /** The current journey chosen: done at once by the facilitator, else requested of them. */
    choose(actor: Actor, name: string, journey: string | null): Promise<{ readonly done: boolean; readonly request?: JourneyRequestBody } | JourneyRefusal>;
    /** The facilitator approves a request (done as theirs) or denies it. */
    decide(actor: Actor, id: string, approve: boolean): Promise<{ readonly done: boolean } | JourneyRefusal>;
    /** Its requester withdraws a request. */
    withdraw(actor: Actor, id: string): { readonly done: boolean } | JourneyRefusal;
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
    readonly store: JourneyFileStore;
    readonly collaboration: CollaborationUseCases;
    /** Tells every page (the body changed). */
    readonly changed: (body: JourneyBody) => void;
    readonly now: () => Date;
    readonly log: (line: string) => void;
}): SessionJourneys {
    let text: string | undefined;
    let read = readJourney('');
    let file: JourneyFile | undefined;
    let requests: JourneyRequestBody[] = [];

    const body = (): JourneyBody => ({ file: file ?? null, problems: text === undefined ? [] : read.problems, requests });
    const tell = (): void => deps.changed(body());

    const reload = async (): Promise<void> => {
        const now = await deps.store.read().catch((e: unknown) => {
            deps.log(`${JOURNEY_FILE}: ${e instanceof Error ? e.message : String(e)}`);
            return text;
        });
        if (now === text && file !== undefined) return;
        text = now;
        read = readJourney(now ?? '');
        file = now === undefined ? undefined : read.file;
        tell();
    };

    const apply = async (actor: Actor, act: JourneyRequestAct): Promise<{ readonly done: true } | JourneyRefusal> => {
        if (act.kind === 'choose') {
            const key = act.journey === null ? undefined : journeyKeyOf(act.journey);
            if (act.journey !== null && !key) return { type: 'InvalidInput', message: 'Not a journey.' };
            const chosen = await deps.collaboration.chooseJourney({ session: deps.session, actor, ...(key && { journey: key }) });
            return chosen.ok ? { done: true } : refusal(chosen.error);
        }
        const done = await deps.collaboration.actOnJourney({ actor, act });
        if (!done.ok) return refusal({ type: done.error.type, ...(writeMessage(done.error) !== undefined && { message: writeMessage(done.error) }) });
        await reload();
        return { done: true };
    };

    const request = (actor: Actor, name: string, act: JourneyRequestAct): { readonly done: false; readonly request: JourneyRequestBody } => {
        // one request of a person per journey and kind: a new one replaces it
        const same = (r: JourneyRequestBody): boolean =>
            r.by === actor.participant && r.act.kind === act.kind && (r.act.kind === 'choose' || (act.kind !== 'choose' && r.act.journey === act.journey));
        const made: JourneyRequestBody = { id: randomUUID(), by: actor.participant, byName: name, act, at: deps.now().toISOString() };
        requests = [...requests.filter((r) => !same(r)), made].slice(-MAX_JOURNEY_REQUESTS);
        tell();
        return { done: false, request: made };
    };

    return {
        body,
        file: () => file,
        diagnostics: (names) => (text === undefined ? [] : journeyDiagnostics(text, journeyNames(names.contexts, names.stormings))),
        reload,
        async act(actor, name, act) {
            if (actor.role !== 'Facilitator') {
                if (text !== undefined && read.problems.length > 0)
                    return { type: 'JourneyFileInvalid', message: writeMessage({ type: 'JourneyFileInvalid', problems: read.problems }) };
                return request(actor, name, act);
            }
            return apply(actor, act);
        },
        async choose(actor, name, journey) {
            if (actor.role !== 'Facilitator') return request(actor, name, { kind: 'choose', journey });
            return apply(actor, { kind: 'choose', journey });
        },
        async decide(actor, id, approve) {
            if (actor.role !== 'Facilitator') return { type: 'FacilitatorOnly' };
            const r = requests.find((x) => x.id === id);
            if (!r) return { type: 'NotFound', message: 'No such request (approved, denied or withdrawn already).' };
            if (approve) {
                // done as the facilitator's own: a refusal leaves the request waiting
                const done = await apply(actor, r.act);
                if (!('done' in done)) return done;
            }
            requests = requests.filter((x) => x.id !== id);
            tell();
            return { done: true };
        },
        withdraw(actor, id) {
            const r = requests.find((x) => x.id === id);
            if (!r) return { type: 'NotFound' };
            if (r.by !== actor.participant) return { type: 'NotTheRequester' };
            requests = requests.filter((x) => x.id !== id);
            tell();
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
