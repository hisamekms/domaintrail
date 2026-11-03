// The guide's map and what is known at once (the plan's "ガイド (`/guide`)"): from the workspace as it is — the
// stormings, the model, `dt check`'s findings — and the goal, a path of steps, each done, here or to do, ending at the
// goal; steps past the goal are faint (`after`). Whether a step is done comes from the files, never from the AI; a step
// the files cannot tell (the BCs are split, the subdomains classified, the terms aligned) is done when a person marked
// it (`marked`, the session's ✓ marks). The path is the event storming's (brief → events → flows and stages →
// exceptions → questions → Design Level; the goal Big Picture or Design Level), or a modeling pattern's (A–D, chosen in
// `/model:start`), which grows a row per `.dt` context under its "each BC in depth" step. Without a goal the map is the
// one step "set the goal": it is not guessed. What is known at once lists what the files show, each with where to go
// (an element to select, a view to open), with no AI.
//
// The goals (the ES level per storming, the named modeling journeys) and the marks are to be kept in the journey file
// (`domaintrail.journey.json`, a later phase): `readGuideGoal` is the one place that reads the goals, and finds none for
// now; the marks are behind `GuideMarkStore`, which the session's marks implement for now. Pure and deterministic: the server computes the snapshot when `/guide` starts, the card shows it, and the AI is
// given it as data.
import type { Diagnostic } from '@domaintrail/kernel';
import type { DomainModel, ElementModel, FieldModel } from '@domaintrail/modeling';
import { allTimelines, type NodeElement, type Storming } from '@domaintrail/storming';
import { Collaboration, type Result } from '../generated/index.js';
import { elementReference, parseElementReference } from './proposals.js';

/** What the guide reads of the workspace: the model (none: no `.dt` that parses), the stormings and `dt check`'s findings. */
export interface GuideWorkspace {
    readonly model: DomainModel | null;
    readonly stormings: readonly Storming[];
    readonly diagnostics: readonly Diagnostic[];
}

/** How far an event storming goes: Big Picture (to the questions) or Design Level. */
export type EsGoalLevel = 'BigPicture' | 'DesignLevel';

/** The steps of the event storming's path, in order. */
export const ES_STEPS = ['brief', 'events', 'flows', 'exceptions', 'questions', 'designLevel'] as const;
export type EsStep = (typeof ES_STEPS)[number];

/** The step each event storming goal ends at. */
export const ES_GOALS: Readonly<Record<EsGoalLevel, EsStep>> = { BigPicture: 'questions', DesignLevel: 'designLevel' };

/** A modeling pattern: its steps in order, the steps it may end at (the last by default), and where the BC rows grow. */
export interface GuidePatternPath {
    readonly steps: readonly string[];
    readonly goals: readonly string[];
    readonly rowsAt: string;
}

/** The modeling patterns (A–D of `/model:start`). */
export const MODEL_PATTERNS: Readonly<Record<Collaboration.GuidePattern, GuidePatternPath>> = {
    // A. 全体から: terms → subdomains → BC split → context map → each BC in depth → invariants
    Strategic: {
        steps: ['terms', 'subdomains', 'bcSplit', 'contextMap', 'contexts', 'invariants'],
        goals: ['contextMap', 'contexts', 'invariants'],
        rowsAt: 'contexts',
    },
    // B. ES から: review the storming → BCs carved from it → aggregates → commands and events (with `ref`) → invariants
    FromStorming: {
        steps: ['review', 'bcCarved', 'aggregates', 'commands', 'invariants'],
        goals: ['aggregates', 'commands', 'invariants'],
        rowsAt: 'bcCarved',
    },
    // C. 1 つの BC を深掘り: terms → aggregates → values and IDs → commands → invariants → policies
    OneContext: { steps: ['terms', 'aggregates', 'values', 'commands', 'invariants', 'policies'], goals: ['commands', 'invariants'], rowsAt: 'aggregates' },
    // D. 既存モデルの見直し: diagnostics → terms aligned → boundaries reviewed → invariants strengthened
    Review: { steps: ['diagnostics', 'termsAligned', 'boundaries', 'invariants'], goals: ['invariants'], rowsAt: 'boundaries' },
};

/** The patterns in the order `/model:start` offers them (A–D). */
export const GUIDE_PATTERNS: readonly Collaboration.GuidePattern[] = ['Strategic', 'FromStorming', 'OneContext', 'Review'];

/** The steps the files cannot tell: a person marks them done (✓). The context map is told by the files too. */
export const MARKABLE_STEPS: ReadonlySet<string> = new Set(['subdomains', 'bcSplit', 'contextMap', 'review', 'termsAligned', 'boundaries']);

/** The one step of a map without a goal. */
export const SET_GOAL = 'setGoal';

/** Every step key a map may show. */
export const GUIDE_STEP_KEYS: ReadonlySet<string> = new Set([SET_GOAL, ...ES_STEPS, ...Object.values(MODEL_PATTERNS).flatMap((p) => p.steps)]);

/** The steps under which a pattern grows its BC rows: a row is marked done by the context's name under one. */
export const ROW_STEPS: ReadonlySet<string> = new Set(Object.values(MODEL_PATTERNS).map((p) => p.rowsAt));

/** The ES journey of a storming: how far it goes. */
export interface EsJourney {
    readonly level: EsGoalLevel;
}

/**
 * A named modeling journey (「Billing の深掘り」): its pattern, the step it ends at (absent: the pattern's last goal) and
 * the pattern's subject: the stormings it carves from (B), the context it deepens (C).
 */
export interface ModelJourney {
    readonly id: string;
    readonly name: string;
    readonly pattern: Collaboration.GuidePattern;
    readonly goal?: string;
    readonly stormings?: readonly string[];
    readonly context?: string;
}

/**
 * The goals of the guide's maps: the ES level per storming (by its ID), and the modeling journeys, several allowed.
 * Neither for the world the person is in: the map is "set the goal".
 */
export interface GuideGoal {
    readonly es?: Readonly<Record<string, EsJourney>>;
    readonly model?: readonly ModelJourney[];
}

/** No goal: the map is "set the goal". */
export const NO_GOAL: GuideGoal = {};

/**
 * The goals set for the workspace. They are to be kept in the journey file (`domaintrail.journey.json`, a later phase):
 * until then there are none, and the map asks to set them.
 */
export function readGuideGoal(_workspace: GuideWorkspace): GuideGoal {
    return NO_GOAL;
}

/** The key of a storming's ES journey (its marks are kept under it). */
export const esJourneyKey = (storming: string): string => `es:${storming}`;

/** A mark of the guide: a step of a journey a person marked done, or a BC row of it (by the context's name). */
export interface GuideMarkKey {
    readonly journey: string;
    readonly step: string;
    readonly context?: string;
}

/** One text per mark, equal exactly for equal marks. */
export const guideMarkId = (k: GuideMarkKey): string => `${k.journey}|${k.step}|${k.context ?? ''}`;

/** What the map reads of the marks. */
export interface GuideMarkReader {
    has(key: GuideMarkKey): boolean;
}

/**
 * Where the guide's marks are kept: read, set and cleared, keyed by journey and step (a BC row by the context's name
 * too). The session's marks keep them for now (`sessionGuideMarks`); the journey file will.
 */
export interface GuideMarkStore<E = never> {
    read(): readonly GuideMarkKey[];
    set(key: GuideMarkKey): Promise<Result<void, E>>;
    clear(key: GuideMarkKey): Promise<Result<void, E>>;
}

/** A reader of the marks given. */
export function guideMarks(keys: readonly GuideMarkKey[]): GuideMarkReader {
    const ids = new Set(keys.map(guideMarkId));
    return { has: (k) => ids.has(guideMarkId(k)) };
}

/** No marks. */
export const NO_MARKS: GuideMarkReader = guideMarks([]);

/** Whether a person may mark it: a step the files cannot tell, or a BC row under a pattern's rows step. */
export const markableGuideMark = (k: Pick<GuideMarkKey, 'step' | 'context'>): boolean =>
    k.context === undefined ? MARKABLE_STEPS.has(k.step) : ROW_STEPS.has(k.step);

/** Fewest events for the events step to be done: a flow can be told with them. */
export const MIN_EVENTS = 5;

/** The most findings a snapshot keeps (`GuideSnapshot.findings`), and the most of one kind per subject. */
export const GUIDE_LIMITS = { findings: 10, perKind: 3 } as const;

const value = <T>(made: Result<T, unknown>): T | undefined => (made.ok ? made.value : undefined);
const tally = (n: number): Collaboration.Tally => {
    const made = Collaboration.makeTally(Math.max(0, Math.floor(n)));
    if (!made.ok) throw new Error(`Not a count: ${n}`);
    return made.value;
};
const stepKey = (key: string): Collaboration.GuideStepKey => {
    const made = Collaboration.makeGuideStepKey(key);
    if (!made.ok) throw new Error(`Not a step key: ${key}`);
    return made.value;
};

/**
 * The world the person is in: none while nothing is written; else the view's (a storming, or a `.dt` view), else the
 * selection's, else what the files hold.
 */
export function guideWorld(
    workspace: Pick<GuideWorkspace, 'model' | 'stormings'>,
    viewedAt?: Collaboration.ViewedAt,
    focus?: Collaboration.ModelTarget,
): Collaboration.GuideWorld {
    const stormings = workspace.stormings.length > 0;
    const model = (workspace.model?.contexts.length ?? 0) > 0;
    // nothing written yet: neither world, whatever the view
    if (!stormings && !model) return 'None';
    if (viewedAt) return viewedAt.view.kind === 'Storming' ? 'Storming' : 'Model';
    if (focus && focus.kind !== 'Workspace') return focus.kind === 'DtElement' ? 'Model' : 'Storming';
    if (stormings && !model) return 'Storming';
    if (model && !stormings) return 'Model';
    return 'None';
}

/** The storming the map is about: the one in view, else the selection's, else the first. */
export function guideStorming(stormings: readonly Storming[], viewedAt?: Collaboration.ViewedAt, focus?: Collaboration.ModelTarget): Storming | undefined {
    const named =
        viewedAt?.view.kind === 'Storming'
            ? viewedAt.view.storming
            : focus && focus.kind !== 'Workspace' && focus.kind !== 'DtElement'
              ? focus.storming
              : undefined;
    return stormings.find((s) => s.id === named) ?? stormings[0];
}

// ---- What the files tell: the event storming ----

/** What the map reads of a storming. */
export interface StormingFacts {
    readonly brief: boolean;
    readonly events: number;
    readonly flows: number;
    readonly exceptions: number;
    /** Its stages, each with whether it has an exception. */
    readonly stages: readonly { readonly id: string; readonly label?: string; readonly exceptions: number }[];
    readonly hotspots: readonly NodeElement[];
    readonly openHotspots: readonly NodeElement[];
    readonly commands: number;
    readonly aggregates: number;
    /** Elements with a `ref` to the model. */
    readonly refs: number;
}

const isResolved = (el: NodeElement): boolean => el.clauses.some((c) => c.type === 'status' && c.value === 'resolved');

export function stormingFacts(storming: Storming): StormingFacts {
    const nodes = storming.elements.filter((el): el is NodeElement => el.kind !== 'timeline' && el.kind !== 'stage');
    const timelines = allTimelines(storming);
    const hotspots = nodes.filter((n) => n.kind === 'hotspot');
    const count = (kind: NodeElement['kind']): number => nodes.filter((n) => n.kind === kind).length;
    return {
        brief: (storming.doc ?? '').trim() !== '',
        events: count('event'),
        flows: timelines.filter((t) => !t.exception).length,
        exceptions: timelines.filter((t) => t.exception).length,
        stages: storming.elements.flatMap((el) =>
            el.kind === 'stage'
                ? [{ id: el.id, ...(el.label !== undefined && { label: el.label }), exceptions: el.timelines.filter((t) => t.exception).length }]
                : [],
        ),
        hotspots,
        openHotspots: hotspots.filter((h) => !isResolved(h)),
        commands: count('command'),
        aggregates: count('aggregate'),
        refs: nodes.filter((n) => n.clauses.some((c) => c.type === 'ref')).length,
    };
}

/** Whether each step of the event storming is done, for a storming (none: none is). */
export function esStepDone(step: EsStep, facts: StormingFacts | undefined): boolean {
    if (!facts) return false;
    switch (step) {
        case 'brief':
            return facts.brief;
        case 'events':
            return facts.events >= MIN_EVENTS;
        case 'flows':
            return facts.flows > 0;
        case 'exceptions':
            return facts.flows > 0 && (facts.stages.length > 0 ? facts.stages.every((s) => s.exceptions > 0) : facts.exceptions > 0);
        case 'questions':
            return facts.hotspots.length > 0 && facts.openHotspots.length === 0;
        case 'designLevel':
            return facts.commands > 0 && facts.aggregates > 0;
    }
}

// ---- What the files tell: the model ----

/** What the map reads of a `.dt` context. */
export interface ContextFacts {
    readonly name: string;
    readonly shared: boolean;
    readonly terms: number;
    readonly aggregates: readonly Extract<ElementModel, { kind: 'aggregate' }>[];
    readonly commands: number;
    readonly invariants: number;
}

const aggregateInvariants = (a: Extract<ElementModel, { kind: 'aggregate' }>): number =>
    a.invariants.length + a.states.reduce((n, s) => n + s.invariants.length, 0);

export function contextFacts(model: DomainModel | null): readonly ContextFacts[] {
    if (!model) return [];
    return model.contexts.map((c) => {
        const aggregates = model.elements.filter((e): e is Extract<ElementModel, { kind: 'aggregate' }> => e.kind === 'aggregate' && e.context === c.name);
        return {
            name: c.name,
            shared: c.shared,
            terms: c.terms.length,
            aggregates,
            commands: aggregates.reduce((n, a) => n + a.commands.length, 0),
            invariants: aggregates.reduce((n, a) => n + aggregateInvariants(a), 0),
        };
    });
}

/** The fields of an element (its states' and commands' too), to find what it refers to. */
function fieldsOf(e: ElementModel): readonly FieldModel[] {
    switch (e.kind) {
        case 'aggregate':
            return [...e.fields, ...e.states.flatMap((s) => s.fields), ...e.commands.flatMap((c) => c.params)];
        case 'valueObject':
        case 'entity':
        case 'event':
        case 'error':
        case 'fieldSet':
            return e.fields;
        default:
            return [];
    }
}

/** Whether an element of one context refers to an element of another (not shared) context: the context map has a line. */
export function crossContextReferences(model: DomainModel | null): number {
    if (!model) return 0;
    const own = new Set<string>(model.contexts.filter((c) => !c.shared).map((c) => c.name));
    const other = (from: string, qualified: string | undefined): boolean => {
        const ctx = qualified?.split('.')[0];
        return ctx !== undefined && ctx !== from && own.has(ctx);
    };
    let n = 0;
    for (const e of model.elements) {
        if (e.kind === 'policy' && other(e.context, e.policy.event)) n += 1;
        for (const f of fieldsOf(e)) if ((f.type.kind === 'ref' && other(e.context, f.type.ref)) || other(e.context, f.target)) n += 1;
    }
    return n;
}

/** A BC row is done: a shared context always; another with aggregates, each with a command and an invariant. */
export const contextDone = (c: ContextFacts): boolean =>
    c.shared || (c.aggregates.length > 0 && c.aggregates.every((a) => a.commands.length > 0 && aggregateInvariants(a) > 0));

/** What a modeling step reads: the contexts, the stormings, the model and the findings. */
interface ModelFacts {
    readonly contexts: readonly ContextFacts[];
    readonly model: DomainModel | null;
    readonly stormings: readonly StormingFacts[];
    readonly diagnostics: readonly Diagnostic[];
    /** Whether a BC row is done: by the files, else by a person's mark on it. */
    readonly rowDone?: (c: ContextFacts) => boolean;
}

/** Whether a modeling step is done by the files (a markable one may be done by a mark too). */
export function modelStepDone(step: string, pattern: Collaboration.GuidePattern, facts: ModelFacts): boolean {
    const own = facts.contexts.filter((c) => !c.shared);
    const aggregates = facts.contexts.flatMap((c) => c.aggregates);
    // the subject's elements only (a journey on one context reads that context)
    const names = new Set<string>(facts.contexts.map((c) => c.name));
    const elements = (facts.model?.elements ?? []).filter((e) => names.has(e.context));
    switch (step) {
        case 'terms':
            return facts.contexts.some((c) => c.terms > 0);
        case 'contextMap':
            return own.length >= 2 && crossContextReferences(facts.model) > 0;
        case 'contexts':
            return own.length > 0 && facts.contexts.every(facts.rowDone ?? contextDone);
        case 'bcCarved':
            return own.length > 0;
        case 'aggregates':
            return own.length > 0 && own.every((c) => c.aggregates.length > 0);
        case 'values':
            return elements.some((e) => e.kind === 'valueObject' || e.kind === 'id' || e.kind === 'primitive');
        case 'commands': {
            const each = aggregates.length > 0 && aggregates.every((a) => a.commands.length > 0);
            if (pattern === 'FromStorming') return each && (facts.stormings.length === 0 || facts.stormings.some((s) => s.refs > 0));
            if (pattern === 'OneContext') return each && aggregates.some((a) => a.commands.some((c) => c.emits.length > 0));
            return each;
        }
        case 'invariants':
            return aggregates.length > 0 && aggregates.every((a) => aggregateInvariants(a) > 0);
        case 'policies':
            return elements.some((e) => e.kind === 'policy');
        case 'diagnostics':
            return own.length > 0 && !facts.diagnostics.some((d) => !d.file.endsWith('.dtes'));
        default:
            // judged by a person only
            return false;
    }
}

// ---- The map ----

/** What the maps are computed from. */
export interface GuideMapInput {
    readonly workspace: GuideWorkspace;
    readonly goal: GuideGoal;
    /** The marks a person set. */
    readonly marks: GuideMarkReader;
    readonly viewedAt?: Collaboration.ViewedAt;
    readonly focus?: Collaboration.ModelTarget;
}

/** A step as the map is first built: done or not, goal, past the goal; `Here` is placed after. */
interface Laid {
    readonly key: string;
    readonly done: boolean;
    readonly goal: boolean;
    readonly after: boolean;
    readonly markable: boolean;
    readonly marked: boolean;
}

/** The steps placed: done, the first not done up to the goal here, the rest to do. */
function placed(steps: readonly Laid[]): [Collaboration.GuideStep, ...Collaboration.GuideStep[]] {
    const here = steps.findIndex((s) => !s.done && !s.after);
    const out = steps.map((s, i): Collaboration.GuideStep => ({
        key: stepKey(s.key),
        state: s.done ? 'Done' : i === here ? 'Here' : 'Todo',
        goal: s.goal,
        after: s.after,
        markable: s.markable,
        marked: s.marked,
    }));
    const [first, ...rest] = out;
    if (!first) throw new Error('A map has a step');
    return [first, ...rest];
}

/** A journey's path laid out: each step's done-ness (a markable step also by a mark), the goal, the steps after it. */
function laid<K extends string>(journey: string, keys: readonly K[], goal: string, done: (key: K) => boolean, marks: GuideMarkReader): Laid[] {
    const at = keys.findIndex((k) => k === goal);
    return keys.map((key, i) => {
        const markable = MARKABLE_STEPS.has(key);
        const mark = markable && marks.has({ journey, step: key });
        return { key, done: done(key) || mark, goal: i === at, after: at >= 0 && i > at, markable, marked: mark };
    });
}

/** The BC rows: one per context, in the model's order, done by the files or a mark; the first not done is here while its step is. */
function contextRows(
    journey: string,
    step: string,
    contexts: readonly ContextFacts[],
    stepHere: boolean,
    marks: GuideMarkReader,
): Collaboration.GuideContextRow[] {
    const marked = (c: ContextFacts): boolean => marks.has({ journey, step, context: c.name });
    const done = (c: ContextFacts): boolean => contextDone(c) || marked(c);
    const here = contexts.findIndex((c) => !done(c));
    return contexts.flatMap((c, i): Collaboration.GuideContextRow[] => {
        const name = value(Collaboration.makeContextName(c.name));
        if (!name) return [];
        return [
            {
                context: name,
                shared: c.shared,
                aggregates: tally(c.aggregates.length),
                commands: tally(c.commands),
                invariants: tally(c.invariants),
                state: done(c) ? 'Done' : stepHere && i === here ? 'Here' : 'Todo',
                marked: marked(c),
            },
        ];
    });
}

/** The modeling step a goal names, else the pattern's last goal. */
export function modelGoalStep(pattern: Collaboration.GuidePattern, goal: string | undefined): string {
    const path = MODEL_PATTERNS[pattern];
    return goal !== undefined && path.goals.includes(goal) ? goal : (path.goals.at(-1) ?? path.steps.at(-1) ?? '');
}

/** The map without a goal: "set the goal" only. */
function goalToSet(world: Collaboration.GuideWorld, storming?: Collaboration.StormingName): Collaboration.GuideMap {
    return {
        world,
        ...(storming && { storming }),
        steps: [{ key: stepKey(SET_GOAL), state: 'Here', goal: false, after: false, markable: false, marked: false }],
        contexts: [],
    };
}

/** The most modeling journeys a snapshot keeps a map of (`GuideSnapshot.maps`). */
export const MAX_JOURNEY_MAPS = 10;

/**
 * A modeling journey's map: its pattern's path to its goal over its subject — the context it deepens (C), the stormings
 * it carves from (B), else the whole model — with a row per context under the pattern's rows step.
 */
export function journeyMap(workspace: GuideWorkspace, journey: ModelJourney, marks: GuideMarkReader): Collaboration.GuideMap {
    const { pattern } = journey;
    const path = MODEL_PATTERNS[pattern];
    const all = contextFacts(workspace.model);
    const contexts = journey.context === undefined ? all : all.filter((c) => c.name === journey.context);
    const stormings = journey.stormings === undefined ? workspace.stormings : workspace.stormings.filter((s) => journey.stormings?.includes(s.id));
    const rowDone = (c: ContextFacts): boolean => contextDone(c) || marks.has({ journey: journey.id, step: path.rowsAt, context: c.name });
    const facts: ModelFacts = { contexts, model: workspace.model, stormings: stormings.map(stormingFacts), diagnostics: workspace.diagnostics, rowDone };
    const steps = placed(laid(journey.id, path.steps, modelGoalStep(pattern, journey.goal), (k) => modelStepDone(k, pattern, facts), marks));
    const rowsHere = steps.some((s) => s.key === path.rowsAt && s.state === 'Here');
    const key = value(Collaboration.makeGuideJourneyKey(journey.id));
    return {
        world: 'Model',
        ...(key && { journey: key }),
        journeyName: journey.name,
        pattern,
        steps,
        contexts: contextRows(journey.id, path.rowsAt, contexts, rowsHere, marks),
        contextsAt: stepKey(path.rowsAt),
    };
}

/**
 * The guide's maps for the world the person is in: the event storming's path to its storming's goal (the storming in
 * view), or one map per modeling journey (the card offers a picker when there are several); "set the goal" when the
 * world has none (or the person is in neither).
 */
export function guideMaps(input: GuideMapInput): [Collaboration.GuideMap, ...Collaboration.GuideMap[]] {
    const { workspace, goal, marks } = input;
    const world = guideWorld(workspace, input.viewedAt, input.focus);
    if (world === 'Storming') {
        const storming = guideStorming(workspace.stormings, input.viewedAt, input.focus);
        const name = storming && value(Collaboration.makeStormingName(storming.id));
        const journey = storming && goal.es?.[storming.id];
        if (!storming || !journey) return [goalToSet(world, name)];
        const facts = stormingFacts(storming);
        const id = esJourneyKey(storming.id);
        const key = value(Collaboration.makeGuideJourneyKey(id));
        const steps = laid(id, ES_STEPS, ES_GOALS[journey.level], (k) => esStepDone(k, facts), marks);
        return [{ world, ...(key && { journey: key }), ...(name && { storming: name }), steps: placed(steps), contexts: [] }];
    }
    const journeys = world === 'Model' ? (goal.model ?? []).slice(0, MAX_JOURNEY_MAPS) : [];
    const [first, ...rest] = journeys.map((j) => journeyMap(workspace, j, marks));
    return first ? [first, ...rest] : [goalToSet(world)];
}

/** The first of the maps (the one map of the storming world, or the first modeling journey's). */
export const guideMap = (input: GuideMapInput): Collaboration.GuideMap => guideMaps(input)[0];

// ---- What is known at once ----

const stormingName = (id: string): Collaboration.StormingName | undefined => value(Collaboration.makeStormingName(id));

/** A finding: its kind and count, what it is about, where to go. */
function finding(
    kind: Collaboration.GuideFindingKind,
    count: number,
    more: { readonly subject?: string; readonly target?: Collaboration.ModelTarget; readonly view?: Collaboration.ViewShown } = {},
): Collaboration.GuideFinding {
    return {
        kind,
        count: tally(count),
        ...(more.subject !== undefined && { subject: more.subject }),
        ...(more.target && { target: more.target }),
        ...(more.view && { view: more.view }),
    };
}

/** The element a diagnostic is about, as a target: a storming's (`es/<storming>/<local>`) or the model's. */
export function diagnosticTarget(d: Pick<Diagnostic, 'elementId'>): Collaboration.ModelTarget | undefined {
    const id = d.elementId;
    if (!id) return undefined;
    if (id.startsWith('es/')) {
        const [, storming, local] = id.split('/');
        return storming ? parseElementReference(local ? `@{es:${storming}/${local}}` : `@{es:${storming}}`) : undefined;
    }
    return parseElementReference(`@{${id}}`);
}

/** The storming's view at Big Picture, a stage of it, its exceptions shown. */
function stormingView(storming: string, stage?: string): Collaboration.ViewShown | undefined {
    const name = stormingName(storming);
    if (!name) return undefined;
    const stageName = stage === undefined ? undefined : value(Collaboration.makeStageName(stage));
    return { kind: 'Storming', storming: name, level: 'BigPicture', ...(stageName && { stage: stageName }), exceptions: true };
}

/** The long-label warning (S015): a note too small for its label. */
const LONG_LABEL = 'S015';

function stormingFindings(storming: Storming, diagnostics: readonly Diagnostic[]): Collaboration.GuideFinding[] {
    const facts = stormingFacts(storming);
    const out: Collaboration.GuideFinding[] = [];
    const subject = storming.label ?? storming.id;
    if (!facts.brief) out.push(finding('StormingWithoutBrief', 1, { subject, ...ifTarget(parseElementReference(`@{es:${storming.id}}`)) }));
    if (facts.flows > 0) {
        const bare = facts.stages.filter((s) => s.exceptions === 0);
        for (const s of bare.slice(0, GUIDE_LIMITS.perKind))
            out.push(finding('StageWithoutExceptions', 1, { subject: s.label ?? s.id, ...ifView(stormingView(storming.id, s.id)) }));
        if (facts.stages.length === 0 && facts.exceptions === 0)
            out.push(finding('FlowWithoutExceptions', facts.flows, { subject, ...ifView(stormingView(storming.id)) }));
    }
    const open = facts.openHotspots[0];
    if (open) out.push(finding('OpenHotspots', facts.openHotspots.length, { subject, ...ifTarget(parseElementReference(`@{es:${storming.id}/${open.id}}`)) }));
    const long = diagnostics.filter((d) => d.code === LONG_LABEL && d.elementId?.startsWith(`es/${storming.id}/`));
    const first = long[0];
    if (first) out.push(finding('LongLabels', long.length, { subject, ...ifTarget(diagnosticTarget(first)) }));
    return out;
}

const ifTarget = (target: Collaboration.ModelTarget | undefined): { readonly target?: Collaboration.ModelTarget } => (target ? { target } : {});
const ifView = (view: Collaboration.ViewShown | undefined): { readonly view?: Collaboration.ViewShown } => (view ? { view } : {});

function modelFindings(model: DomainModel | null): Collaboration.GuideFinding[] {
    const contexts = contextFacts(model);
    const out: Collaboration.GuideFinding[] = [];
    for (const c of contexts.filter((x) => !x.shared && x.aggregates.length === 0).slice(0, GUIDE_LIMITS.perKind)) {
        const name = value(Collaboration.makeContextName(c.name));
        out.push(finding('ContextWithoutAggregates', 1, { subject: c.name, ...ifView(name && { kind: 'Structure', level: 'Detail', focus: [name] }) }));
    }
    const aggregates = contexts.flatMap((c) => c.aggregates);
    const noCommands = aggregates.filter((a) => a.commands.length === 0);
    if (noCommands[0]) out.push(finding('AggregatesWithoutCommands', noCommands.length, ifTarget(parseElementReference(`@{${noCommands[0].id}}`))));
    const noInvariants = aggregates.filter((a) => aggregateInvariants(a) === 0);
    if (noInvariants[0]) out.push(finding('AggregatesWithoutInvariants', noInvariants.length, ifTarget(parseElementReference(`@{${noInvariants[0].id}}`))));
    return out;
}

/** `dt check`'s errors and warnings (the long labels told on their own), on the files of the world. */
function diagnosticFindings(diagnostics: readonly Diagnostic[]): Collaboration.GuideFinding[] {
    const out: Collaboration.GuideFinding[] = [];
    for (const [kind, severity] of [
        ['Errors', 'error'],
        ['Warnings', 'warning'],
    ] as const) {
        const found = diagnostics.filter((d) => d.severity === severity && d.code !== LONG_LABEL);
        const first = found.find((d) => diagnosticTarget(d)) ?? found[0];
        if (first) out.push(finding(kind, found.length, ifTarget(diagnosticTarget(first))));
    }
    return out;
}

/**
 * What is known at once, for the world the person is in: in a storming, its brief, stages without exceptions, open
 * hotspots and long labels; in the model, contexts without aggregates, aggregates without commands or invariants; and
 * `dt check`'s errors and warnings on the world's files. Neither world: both. At most `GUIDE_LIMITS.findings`.
 */
export function guideFindings(workspace: GuideWorkspace, world: Collaboration.GuideWorld, storming: Storming | undefined): Collaboration.GuideFinding[] {
    const esFile = (d: Diagnostic): boolean => d.file.endsWith('.dtes');
    const es = world !== 'Model' && storming ? stormingFindings(storming, workspace.diagnostics) : [];
    const model = world !== 'Storming' ? modelFindings(workspace.model) : [];
    const diagnostics = workspace.diagnostics.filter((d) => (world === 'Storming' ? esFile(d) : world === 'Model' ? !esFile(d) : true));
    return [...es, ...model, ...diagnosticFindings(diagnostics)].slice(0, GUIDE_LIMITS.findings);
}

/** The snapshot `/guide` keeps when it starts: the map and what is known at once. */
export function guideSnapshot(input: GuideMapInput): Collaboration.GuideSnapshot {
    const maps = guideMaps(input);
    const world = maps[0].world;
    const storming = world === 'Model' ? undefined : guideStorming(input.workspace.stormings, input.viewedAt, input.focus);
    return { maps, findings: guideFindings(input.workspace, world, storming) };
}

// ---- As the AI is given it ----

/** A view as the AI is given a finding's place: the storming and its stage, or the context in focus. */
function viewData(view: {
    readonly kind: string;
    readonly storming?: string;
    readonly stage?: string;
    readonly timeline?: string;
    readonly focus?: readonly string[];
}): Record<string, unknown> {
    return {
        view: view.kind,
        ...(view.storming !== undefined && { storming: `@{es:${view.storming}}` }),
        ...(view.stage !== undefined && view.storming !== undefined && { stage: `@{es:${view.storming}/${view.stage}}` }),
        ...(view.focus && view.focus.length > 0 && { contexts: view.focus }),
    };
}

/**
 * The snapshot as the AI is given it in the data block: per map, the world, the journey, the goal step and the step
 * here, the steps with their states (and which a person marked done), the BC rows; and what is known at once, each
 * with where to go as element references. Accepts the snapshot or its JSON.
 */
export function guideData(snapshot: {
    readonly maps: readonly {
        readonly world: string;
        readonly journey?: string;
        readonly journeyName?: string;
        readonly pattern?: string;
        readonly storming?: string;
        readonly steps: readonly { readonly key: string; readonly state: string; readonly goal: boolean; readonly after: boolean; readonly marked: boolean }[];
        readonly contexts: readonly {
            readonly context: string;
            readonly shared: boolean;
            readonly aggregates: number;
            readonly commands: number;
            readonly invariants: number;
            readonly state: string;
            readonly marked?: boolean;
        }[];
        readonly contextsAt?: string;
    }[];
    readonly findings: readonly {
        readonly kind: string;
        readonly count: number;
        readonly subject?: string;
        readonly target?: Parameters<typeof elementReferenceOf>[0];
        readonly view?: Parameters<typeof viewData>[0];
    }[];
}): Record<string, unknown> {
    return {
        maps: snapshot.maps.map((m) => ({
            world: m.world,
            ...(m.journey !== undefined && { journey: m.journey }),
            ...(m.journeyName !== undefined && { journeyName: m.journeyName }),
            ...(m.pattern !== undefined && { pattern: m.pattern }),
            ...(m.storming !== undefined && { storming: `@{es:${m.storming}}` }),
            goal: m.steps.find((s) => s.goal)?.key ?? null,
            here: m.steps.find((s) => s.state === 'Here')?.key ?? null,
            steps: m.steps.map(
                (s) => `${s.key}: ${s.state}${s.goal ? ' (goal)' : ''}${s.after ? ' (past the goal)' : ''}${s.marked ? ' (marked done by a person)' : ''}`,
            ),
            ...(m.contexts.length > 0 && {
                contextsUnder: m.contextsAt,
                contexts: m.contexts.map(
                    (r) =>
                        `${r.context}${r.shared ? ' (shared)' : ''}: ${r.aggregates} aggregates, ${r.commands} commands, ${r.invariants} invariants — ${r.state}${r.marked ? ' (marked done by a person)' : ''}`,
                ),
            }),
        })),
        findings: snapshot.findings.map((f) => ({
            kind: f.kind,
            count: f.count,
            ...(f.subject !== undefined && { subject: f.subject }),
            ...(f.target && { goTo: elementReferenceOf(f.target) }),
            ...(f.view && { open: viewData(f.view) }),
        })),
    };
}

/** A target as an element reference (`@{es:Orders/Placed}`, `@{Sales.Order}`). */
const elementReferenceOf = (t: Parameters<typeof elementReference>[0]): string => elementReference(t);
