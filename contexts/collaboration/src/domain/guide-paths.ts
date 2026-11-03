// The guide's vocabulary (the plan's "ガイド (`/guide`)" and "The journey file's format and contents"): the paths of
// steps — the event storming's and each modeling pattern's (A–D) — the goals each may end at, the steps a person marks
// done, and where a pattern grows its BC rows. One vocabulary for the guide's engine (`guide.ts`), the journey file
// (`journey.ts`: its schema's enums, the marks it may hold) and the page. The IDs are English and fixed: they are
// written into `domaintrail.journey.json`. Pure.
import type { Collaboration } from '../generated/index.js';

/** How far an event storming goes: Big Picture (to the questions) or Design Level. */
export type EsGoalLevel = 'BigPicture' | 'DesignLevel';

/** The event storming's levels, in order. */
export const ES_LEVELS: readonly EsGoalLevel[] = ['BigPicture', 'DesignLevel'];

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

/** The modeling patterns (A–D of `/model:start`), by the names the journey file writes. */
export const MODEL_PATTERNS: Readonly<Record<Collaboration.GuidePattern, GuidePatternPath>> = {
    // A. 全体から: terms → subdomains → BC split → context map → each BC in depth → invariants
    Whole: {
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
export const GUIDE_PATTERNS: readonly Collaboration.GuidePattern[] = ['Whole', 'FromStorming', 'OneContext', 'Review'];

/**
 * The steps a person may mark done: those the files cannot tell (the subdomains classified, the BCs split, the terms
 * aligned…; the context map is told by the files too), and in the event storming the exceptions (a stage that needs
 * none) and the questions (a storming that raised none).
 */
export const MARKABLE_STEPS: ReadonlySet<string> = new Set([
    'subdomains',
    'bcSplit',
    'contextMap',
    'review',
    'termsAligned',
    'boundaries',
    'exceptions',
    'questions',
]);

/** The one step of a map without a goal. */
export const SET_GOAL = 'setGoal';

/** Every step key a map may show. */
export const GUIDE_STEP_KEYS: ReadonlySet<string> = new Set([SET_GOAL, ...ES_STEPS, ...Object.values(MODEL_PATTERNS).flatMap((p) => p.steps)]);

/** The steps under which a pattern grows its BC rows: a row is marked done by the context's name under one. */
export const ROW_STEPS: ReadonlySet<string> = new Set(Object.values(MODEL_PATTERNS).map((p) => p.rowsAt));

/** The event storming's steps a person may mark done. */
export const ES_MARKABLE: readonly EsStep[] = ES_STEPS.filter((s) => MARKABLE_STEPS.has(s));

/** A pattern's steps a person may mark done. */
export const patternMarkable = (pattern: Collaboration.GuidePattern): readonly string[] => MODEL_PATTERNS[pattern].steps.filter((s) => MARKABLE_STEPS.has(s));

/** Whether the pattern takes a subject: the stormings it carves from (B), the context it deepens (C). */
export const PATTERN_SUBJECT: Readonly<Record<Collaboration.GuidePattern, 'stormings' | 'context' | undefined>> = {
    Whole: undefined,
    FromStorming: 'stormings',
    OneContext: 'context',
    Review: undefined,
};
