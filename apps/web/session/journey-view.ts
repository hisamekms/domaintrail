// What the journeys show, without React (the plan's "The current journey, and how journeys begin"): the guide's
// workspace as the page holds it (the view's model, stormings and findings, the journey file the server sent), each
// journey's map computed live by the guide's engine (the same as the server's snapshot), the session's current
// journey, what the app bar's chip reads, the journeys a storming or a context is part of (the detail), and the acts
// the page sends.
import {
    currentJourney,
    esJourneyKey,
    goalOf,
    guideJourneyMap,
    guideMarks,
    journeyMarks,
    journeySummaries,
    MODEL_PATTERNS,
    ES_LEVELS,
    type GuideMarkKey,
    type GuideMarkStore,
    type GuideWorkspace,
    type JourneyAct,
    type JourneyFile,
    type JourneySummary,
    ok,
    type Result,
} from '@domaintrail/collaboration';
import type { JourneyBody } from '@domaintrail/collaboration/protocol';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import type { GuideMapJson } from './guide-view';

/** The guide's workspace as the page holds it: the view's model, stormings and findings, and the journey file. */
export function pageGuideWorkspace(
    payload: Pick<ViewPayload, 'model' | 'stormings' | 'diagnostics'> | null,
    file: JourneyFile | null | undefined,
): GuideWorkspace {
    return {
        model: payload?.model ?? null,
        stormings: (payload?.stormings ?? []).map((s) => s.storming),
        diagnostics: payload?.diagnostics ?? [],
        ...(file && { journey: file }),
    };
}

/** A journey as the page shows it: its summary, its map as the files tell it now, where it is, its goal, whether it is reached. */
export interface JourneyItem {
    readonly summary: JourneySummary;
    readonly map: GuideMapJson | undefined;
    /** The step here (none: every step to the goal is done). */
    readonly here: string | undefined;
    /** The goal's step. */
    readonly goal: string | undefined;
    readonly reached: boolean;
    /** The storming or context it names is gone (renamed, removed). */
    readonly missing: boolean;
}

/** The journeys of the file with their maps now, and the session's current journey (its key: chosen, else the default). */
export interface JourneyOverview {
    readonly current: JourneyItem | undefined;
    /** Every journey but the current, the archived apart. */
    readonly others: readonly JourneyItem[];
    readonly archived: readonly JourneyItem[];
}

export function journeyOverview(workspace: GuideWorkspace, chosen: string | undefined): JourneyOverview {
    const file = workspace.journey;
    if (!file) return { current: undefined, others: [], archived: [] };
    const goal = goalOf(file);
    const marks = guideMarks(journeyMarks(file));
    const key = currentJourney(workspace, goal, chosen);
    const item = (summary: JourneySummary): JourneyItem => {
        // an archived journey is out of the guide's goals: its map from the goals of the whole file
        const map =
            summary.state === 'archived'
                ? guideJourneyMap(workspace, goalOf({ ...file, stormings: archivedEs(file), modeling: file.modeling }), summary.key, marks)
                : guideJourneyMap(workspace, goal, summary.key, marks);
        // the map as the page reads a kept snapshot's (its JSON: the same shape, the brands plain)
        const json: GuideMapJson | undefined = map && asJson(map);
        const here = json?.steps.find((s) => s.state === 'Here')?.key;
        const goalStep = json?.steps.find((s) => s.goal)?.key;
        const reached = json !== undefined && json.steps.filter((s) => !s.after).every((s) => s.state === 'Done');
        return { summary, map: json, here, goal: goalStep, reached, missing: json?.missing === true };
    };
    // an ES journey is named by its storming's label, as the page names the storming
    const labelOf = (id: string): string | undefined => workspace.stormings.find((x) => x.id === id)?.label;
    const all = journeySummaries(file)
        .map((j) => (j.kind === 'es' ? { ...j, name: labelOf(j.name) ?? j.name } : j))
        .map(item);
    const current = all.find((j) => j.summary.key === key);
    return {
        current,
        others: all.filter((j) => j !== current && j.summary.state !== 'archived'),
        archived: all.filter((j) => j.summary.state === 'archived'),
    };
}

/** A map as its JSON (the brands plain strings and numbers): what the page reads. */
const asJson = (map: NonNullable<ReturnType<typeof guideJourneyMap>>): GuideMapJson => map;

/** The stormings' journeys with the archived ones made active (to draw their maps). */
const archivedEs = (file: JourneyFile): JourneyFile['stormings'] =>
    Object.fromEntries(Object.entries(file.stormings).map(([k, e]) => [k, e.state === 'archived' ? { ...e, state: 'active' as const } : e]));

/** What the app bar's chip reads: the journey's name, the step here, the goal; none: 「ゴールを決める」. */
export interface ChipParts {
    readonly name: string;
    readonly here: string | undefined;
    readonly goal: string | undefined;
    readonly reached: boolean;
}

export const chipParts = (item: JourneyItem | undefined): ChipParts | undefined =>
    item && { name: item.summary.name, here: item.here, goal: item.goal, reached: item.reached };

/** The goals a journey may change to: an event storming's levels, or the goals its pattern allows. */
export function goalChoices(summary: Pick<JourneySummary, 'kind' | 'pattern'>): readonly string[] {
    if (summary.kind === 'es') return ES_LEVELS;
    return summary.pattern ? MODEL_PATTERNS[summary.pattern].goals : [];
}

/** The journeys a storming is part of: its own ES journey, and the modeling journeys carved from it. */
export function journeysOfStorming(file: JourneyFile | null | undefined, storming: string): readonly JourneySummary[] {
    if (!file) return [];
    return journeySummaries(file).filter((j) => (j.kind === 'es' ? j.key === esJourneyKey(storming) : j.stormings?.includes(storming) === true));
}

/**
 * The modeling journeys a context is part of: those that name it (`from.context`), and those whose pattern spans the
 * whole model (all but OneContext's on another context: ES から, 全体から, 見直し).
 */
export function journeysOfContext(file: JourneyFile | null | undefined, context: string): readonly JourneySummary[] {
    if (!file) return [];
    return journeySummaries(file).filter((j) => j.kind === 'model' && j.state !== 'archived' && (j.context === undefined || j.context === context));
}

/** Whether a participant's request about the journeys waits (the panel says so on its row). */
export const waitingRequests = (body: JourneyBody | undefined, journey: string): number =>
    (body?.requests ?? []).filter((r) => (r.act.kind === 'choose' ? r.act.journey === journey : r.act.journey === journey)).length;

/**
 * The guide's marks as the page keeps them: the journey file's, read from the file the server sent, set and cleared as
 * acts on it (`act`, which says itself when the server refuses, or that the facilitator was asked).
 */
export function pageGuideMarks(file: JourneyFile | null | undefined, act: (act: JourneyAct) => void): GuideMarkStore {
    const write = async (key: GuideMarkKey, done: boolean): Promise<Result<void, never>> => {
        act({ kind: 'mark', journey: key.journey, step: key.step, ...(key.context !== undefined && { context: key.context }), done });
        return ok(undefined);
    };
    return { read: () => journeyMarks(file ?? undefined), set: (k) => write(k, true), clear: (k) => write(k, false) };
}
