/**
 * The Event Storming DSL (`.dtes`, docs/dtes-v0.1.md, ADR 0032): the types shared by its parser, validator, `.dt` linker,
 * projection, CLI and Live View (ADR 0024). Three layers, kept apart (spec §7):
 *
 * - the **storming IR** (`Storming`, here): what a file says, as written — every clause in source order with its range,
 *   also the invalid ones, so that the validator reports from it and the formatter-independent tools need no AST;
 * - the **semantic graph** and the **occurrences** (`./semantic.ts`): what it means, its valid elements and relations;
 * - the **render graph** (`@domaintrail/visualization`): what the projection makes of it for the Live View.
 */
import type { Diagnostic, Position, Severity } from '@domaintrail/kernel';
import type { StormingRuleId } from './rule-ids.js';

// ---- Storming IR ----

/** A span of a source file, 1-based like `Diagnostic` (the end column is exclusive). */
export interface SourceRange {
    /** Path as given to the analyzer (relative to the workspace root). */
    file: string;
    start: Position;
    end: Position;
}

/** The kinds of declarations; they share one namespace per storming (spec §2, §14). */
export type ElementKind = 'event' | 'actor' | 'external' | 'command' | 'policy' | 'aggregate' | 'readmodel' | 'hotspot' | 'timeline' | 'group' | 'stage';

/** The declarations drawn as nodes of their own (a timeline, a group and a stage are drawn through their events). */
export type NodeElementKind = Exclude<ElementKind, 'timeline' | 'group' | 'stage'>;

/**
 * The keywords of a relation clause inside an element's body (spec §3.2, ADR 0032): Event Storming's design-level
 * grammar. A command is issued `by` an actor or external system, who `reads` read models to decide it, and is
 * `handledBy` an aggregate or external system, which `emits` its events; a command issued `by` an actor may be `on` the
 * events that person reacts to (ADR 0032 §14: a judgement, not a rule); a policy is `on` events, `reads` read models
 * to decide and `issues` a command (whoever decides has the `reads`: a command a policy issues has none, S030);
 * a read model is fed `from` events and an event arrives `from` an external system; a hotspot is `on` any sticky.
 */
export type RelationKeyword = 'by' | 'reads' | 'handledBy' | 'emits' | 'on' | 'issues' | 'from';

/** Every relation keyword, in the canonical order of a body (`dt fmt`, ADR 0032). */
export const RELATION_KEYWORDS: readonly RelationKeyword[] = ['by', 'reads', 'handledBy', 'emits', 'on', 'issues', 'from'];

/** The relation keywords of v0.1 that ADR 0032 removed: parsed only to be reported (S023), with the one that replaces each. */
export type RemovedKeyword = 'actor' | 'target';
export const REMOVED_KEYWORDS: Readonly<Record<RemovedKeyword, RelationKeyword>> = { actor: 'by', target: 'handledBy' };
export const isRemovedKeyword = (keyword: string): keyword is RemovedKeyword => keyword === 'actor' || keyword === 'target';

/**
 * A clause of an element's body, as written. The grammar accepts every clause in every body, so that a misplaced one is
 * reported by the validator with a message of its own rather than as a syntax error.
 */
export type Clause =
    /** `ref Delivery.Shipment.cancel`: the `.dt` symbol the element corresponds to (spec §5.1). */
    | { type: 'ref'; path: string; segments: string[]; range: SourceRange }
    /**
     * `handledBy Shipment`: a reference to another element of the same storming, by local ID. `emits A, B` is two
     * clauses, one per target, with the range of the whole clause; `removed` for a keyword of v0.1 (S023).
     */
    | { type: 'relation'; keyword: RelationKeyword | RemovedKeyword; target: string; range: SourceRange; targetRange: SourceRange }
    /** `status open`: the word as written (only `open` and `resolved` are valid). */
    | { type: 'status'; value: string; range: SourceRange }
    /** `resolution "..."`: the text without its quotes, escapes resolved. */
    | { type: 'resolution'; text: string; range: SourceRange }
    /** `level design`: the word as written, hyphens included (only `design`, on an event, is valid). */
    | { type: 'level'; value: string; range: SourceRange };

interface Declaration {
    /** Local ID, unique in the storming across kinds. */
    id: string;
    /** The display name (the string after the ID); for a hotspot, its question. */
    label?: string;
    /** Description from `///` comments. */
    doc?: string;
    /** The whole declaration. */
    range: SourceRange;
    /** The ID after the keyword, where diagnostics about the declaration itself are reported. */
    nameRange: SourceRange;
}

/** `event`, `actor`, `external`, `command`, `policy`, `aggregate`, `readmodel` or `hotspot`, with its body's clauses. */
export interface NodeElement extends Declaration {
    kind: NodeElementKind;
    clauses: Clause[];
}

/** An event of a timeline, by ID (it should name an event; anything else is a kind error). */
export interface EventStepRef {
    eventId: string;
    range: SourceRange;
}

/** `group Id "label" { A B }`: events of one step, without an order among them (spec §3.4). */
export interface Group extends Declaration {
    kind: 'group';
    events: EventStepRef[];
}

export type TimelineStep = ({ type: 'event' } & EventStepRef) | ({ type: 'group' } & Group);

/** A partial time order of events: event references and groups only (spec §3.4). */
export interface Timeline extends Declaration {
    kind: 'timeline';
    /** Written `exception`: an exception from the main flows (spec §3.7); `timeline` is a main flow. */
    exception?: true;
    steps: TimelineStep[];
    /** `then <Event>`: the event of a main flow an exception returns to after its last step (spec §3.7). */
    rejoin?: EventStepRef;
}

/** `after <Stage>` of a stage, by ID (it should name another stage). */
export interface StageRef {
    stageId: string;
    range: SourceRange;
}

/**
 * `stage Id "label" after Prev { timeline … exception … }`: a time section of the flow (spec §3.7): its main flows
 * (`timeline`; the first is its trunk) and its exceptions (`exception`); `after` puts it after another stage (at most
 * one is valid).
 */
export interface Stage extends Declaration {
    kind: 'stage';
    afters: StageRef[];
    timelines: Timeline[];
}

export type StormingElement = NodeElement | Timeline | Stage;

/** Any declaration of a storming, stages, their timelines and groups included. */
export type AnyDeclaration = NodeElement | Timeline | Group | Stage;

/** `storming Id "label" { ... }`: the unit of Event Storming. */
export interface Storming extends Declaration {
    /** Top-level declarations in source order (groups are inside their timelines, the timelines of a stage inside it). */
    elements: StormingElement[];
}

/** The stormings of a workspace as analyzed: the contract between the analyzer (ADR 0024, T6) and the Live View (T7). */
export interface StormingAnalysis {
    /** The `.dtes` files analyzed, as given to the analyzer. */
    files: string[];
    /** The stormings of every file that parses, in file order, then source order. */
    stormings: Storming[];
    /** Syntax, validation and `.dt` link diagnostics of the `.dtes` files. */
    diagnostics: Diagnostic[];
    /** True when every `.dtes` file parsed. */
    syntaxOk: boolean;
}

/** Every declaration of a storming, stages, their timelines and groups included, in source order. */
export function declarations(storming: Storming): AnyDeclaration[] {
    const timeline = (t: Timeline): AnyDeclaration[] => [t, ...t.steps.filter((s): s is { type: 'group' } & Group => s.type === 'group')];
    return storming.elements.flatMap((el): AnyDeclaration[] =>
        el.kind === 'timeline' ? timeline(el) : el.kind === 'stage' ? [el, ...el.timelines.flatMap(timeline)] : [el],
    );
}

/** Every timeline of a storming in source order: the top-level ones and those of its stages. */
export function allTimelines(storming: Storming): Timeline[] {
    return storming.elements.flatMap((el): Timeline[] => (el.kind === 'timeline' ? [el] : el.kind === 'stage' ? el.timelines : []));
}

/** The node elements of a storming (not its timelines, groups or stages), in source order. */
export function nodeElements(storming: Storming): NodeElement[] {
    return storming.elements.filter((el): el is NodeElement => el.kind !== 'timeline' && el.kind !== 'stage');
}

// ---- Rules shared by the validator and the projection ----

/** The stickies a hotspot may be `on`: every node kind but a hotspot (ADR 0032). */
const STICKIES: readonly NodeElementKind[] = ['event', 'actor', 'external', 'command', 'policy', 'aggregate', 'readmodel'];

/**
 * Which relation clauses each element kind takes, and the kinds their targets must have (spec §3.2, §5.1, §14; ADR
 * 0032). A relation outside this table, or to a target of another kind, is invalid: reported by the validator, left
 * out of the semantic graph. Multiplicities are checked by the validator only.
 */
export const RELATION_RULES: Readonly<Partial<Record<NodeElementKind, Readonly<Partial<Record<RelationKeyword, readonly NodeElementKind[]>>>>>> = {
    command: { by: ['actor', 'external'], on: ['event'], reads: ['readmodel'], handledBy: ['aggregate', 'external'], emits: ['event'] },
    policy: { by: ['actor'], reads: ['readmodel'], on: ['event'], issues: ['command'] },
    readmodel: { from: ['event'] },
    event: { from: ['external'] },
    hotspot: { on: STICKIES },
};

/** The element kinds that may have a `ref` to `.dt` (spec §5.1). */
export const REF_KINDS: readonly NodeElementKind[] = ['event', 'aggregate', 'command'];

/** The only valid value of a `level` clause. */
export const DESIGN_LEVEL = 'design';

/**
 * Whether an element is an event shown at Design Level only (`level design`, spec §6). Without the clause, or with an
 * invalid one (reported by the validator, S004/S006/S016), it is shown at both levels: a typo never hides an event.
 */
export const isDesignLevelOnly = (el: NodeElement): boolean => el.kind === 'event' && el.clauses.find((c) => c.type === 'level')?.value === DESIGN_LEVEL;

// ---- IDs and diagnostics ----

/** Workspace-wide ID of a storming's element (diagnostics' `elementId`, the Live View's selection). */
export const esElementId = (stormingId: string, localId?: string): string => (localId === undefined ? `es/${stormingId}` : `es/${stormingId}/${localId}`);

/** A diagnostic at a range of a `.dtes` file. */
export function esDiagnostic(
    severity: Severity,
    code: StormingRuleId,
    message: string,
    range: SourceRange,
    extra: { hint?: string; elementId?: string } = {},
): Diagnostic {
    return {
        file: range.file,
        start: range.start,
        end: range.end,
        severity,
        code,
        message,
        ...(extra.hint ? { hint: extra.hint } : {}),
        ...(extra.elementId ? { elementId: extra.elementId } : {}),
    };
}
