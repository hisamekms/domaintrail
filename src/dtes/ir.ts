/**
 * The Event Storming DSL (`.dtes`, docs/dtes-v0.1.md): the types shared by its parser, validator, `.dt` linker,
 * projection, CLI and Live View (ADR 0024). Three layers, kept apart (spec §7):
 *
 * - the **storming IR** (`Storming`): what a file says, as written — every clause in source order with its range, also
 *   the invalid ones, so that the validator reports from it and the formatter-independent tools need no AST;
 * - the **semantic graph** (`SemanticGraph`): the valid elements and relations only, independent of timelines;
 * - the **render graph** (`RenderGraph`): the nodes and edges of one view (`ViewOptions`), where one event node may stand
 *   for several occurrences of the same event (a pure drawing optimization: it never adds a semantic edge).
 */
import type { Diagnostic, Position, RuleId, Severity } from '../core/diagnostics.js';

// ---- Storming IR ----

/** A span of a source file, 1-based like `Diagnostic` (the end column is exclusive). */
export interface SourceRange {
    /** Path as given to the analyzer (relative to the workspace root). */
    file: string;
    start: Position;
    end: Position;
}

/** The kinds of declarations; they share one namespace per storming (spec §2, §14). */
export type ElementKind = 'event' | 'actor' | 'external' | 'command' | 'policy' | 'aggregate' | 'readmodel' | 'hotspot' | 'timeline' | 'group';

/** The declarations drawn as nodes of their own (a timeline and a group are drawn through their events). */
export type NodeElementKind = Exclude<ElementKind, 'timeline' | 'group'>;

/** The keywords of a relation clause inside an element's body (spec §3.2). */
export type RelationKeyword = 'actor' | 'reads' | 'target' | 'emits' | 'on' | 'issues';

/**
 * A clause of an element's body, as written. The grammar accepts every clause in every body, so that a misplaced one is
 * reported by the validator with a message of its own rather than as a syntax error.
 */
export type Clause =
    /** `ref Delivery.Shipment.cancel`: the `.dt` symbol the element corresponds to (spec §5.1). */
    | { type: 'ref'; path: string; segments: string[]; range: SourceRange }
    /** `target Shipment`: a reference to another element of the same storming, by local ID. */
    | { type: 'relation'; keyword: RelationKeyword; target: string; range: SourceRange; targetRange: SourceRange }
    /** `status open`: the word as written (only `open` and `resolved` are valid). */
    | { type: 'status'; value: string; range: SourceRange }
    /** `resolution "..."`: the text without its quotes, escapes resolved. */
    | { type: 'resolution'; text: string; range: SourceRange };

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

/** `group Id "label" { A B }`: events of one stage, without an order among them (spec §3.4). */
export interface Group extends Declaration {
    kind: 'group';
    events: EventStepRef[];
}

export type TimelineStep = ({ type: 'event' } & EventStepRef) | ({ type: 'group' } & Group);

/** A partial time order of events: event references and groups only (spec §3.4). */
export interface Timeline extends Declaration {
    kind: 'timeline';
    steps: TimelineStep[];
}

export type StormingElement = NodeElement | Timeline;

/** Any declaration of a storming, groups included. */
export type AnyDeclaration = NodeElement | Timeline | Group;

/** `storming Id "label" { ... }`: the unit of Event Storming. */
export interface Storming extends Declaration {
    /** Top-level declarations in source order (groups are inside their timelines). */
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

/** Every declaration of a storming, groups included, in source order. */
export function declarations(storming: Storming): AnyDeclaration[] {
    return storming.elements.flatMap((el): AnyDeclaration[] =>
        el.kind === 'timeline' ? [el, ...el.steps.filter((s): s is { type: 'group' } & Group => s.type === 'group')] : [el],
    );
}

// ---- Rules shared by the validator and the projection ----

/**
 * Which relation clauses each element kind takes, and the kinds their targets must have (spec §3.2, §5.1, §14).
 * A relation outside this table, or to a target of another kind, is invalid: reported by the validator, left out of
 * the semantic graph. Multiplicities are checked by the validator only.
 */
export const RELATION_RULES: Readonly<Partial<Record<NodeElementKind, Readonly<Partial<Record<RelationKeyword, readonly NodeElementKind[]>>>>>> = {
    command: { actor: ['actor', 'external'], reads: ['readmodel'], target: ['aggregate'], emits: ['event'] },
    policy: { on: ['event'], issues: ['command'] },
    hotspot: { on: ['event'] },
};

/** The element kinds that may have a `ref` to `.dt` (spec §5.1). */
export const REF_KINDS: readonly NodeElementKind[] = ['event', 'aggregate', 'command'];

// ---- Semantic graph (spec §7.1, §9.1) ----

/**
 * The kind of a semantic edge. `hotspot-on` is a hotspot's `on`, which is not causal; a policy's `on` is `on`.
 * `actor`, `reads` and `target` relate, `on`, `issues` and `emits` are type-level causal candidates.
 */
export type SemanticEdgeKind = 'on' | 'issues' | 'emits' | 'target' | 'actor' | 'reads' | 'hotspot-on';

/** A valid relation, directed as in spec §9.1 (`Actor → Command`, `Read Model → Command`, the others from the owner). */
export interface SemanticEdge {
    /** Local IDs. */
    sourceId: string;
    targetId: string;
    kind: SemanticEdgeKind;
}

export interface SemanticGraph {
    stormingId: string;
    /** The node elements of the storming (not timelines or groups), in source order. */
    nodes: NodeElement[];
    /** Each valid relation clause once, in source order, never inferred ones (no Event → Command across a policy). */
    edges: SemanticEdge[];
}

/** Identity of a semantic edge, for render edges to point back to it. */
export const semanticEdgeKey = (e: SemanticEdge): string => `${e.kind}:${e.sourceId}->${e.targetId}`;

/** How a semantic edge is drawn (spec §9.4): solid causal, dotted related. */
export const isCausal = (kind: SemanticEdgeKind): boolean => kind === 'on' || kind === 'issues' || kind === 'emits';

// ---- Timelines and occurrences (spec §7.2, §8.3) ----

/**
 * One appearance of an event in a timeline. Not persistent: `stepPath` changes when a step is inserted before it.
 * Occurrences of the same event in two timelines are never taken to be the same happening.
 */
export interface EventOccurrence {
    timelineId: string;
    /** `[step]` for an event step, `[step, index]` for the index-th event of a group step (source order). */
    stepPath: number[];
    eventId: string;
}

/** A timeline step for comparison: an event, or the set of a group's events (sorted, each once). */
export type Step = { type: 'event'; eventId: string } | { type: 'group'; eventIds: string[] };

/** The comparison key of a step: equal for equal steps, whatever the group's ID or the order of its events. */
export type StepKey = string;

export const stepKey = (step: Step): StepKey => (step.type === 'event' ? `e:${step.eventId}` : `g:${step.eventIds.join(',')}`);

/** The step of a timeline step (a group's events sorted and deduplicated; its ID and order do not matter). */
export const stepOf = (s: TimelineStep): Step =>
    s.type === 'event' ? { type: 'event', eventId: s.eventId } : { type: 'group', eventIds: [...new Set(s.events.map((e) => e.eventId))].sort() };

// ---- Views and the render graph (spec §6, §7.3, §9.3) ----

/** The two independent axes of a view; neither changes the `.dtes`. */
export interface ViewOptions {
    level: 'big-picture' | 'design-level';
    /** Absent: the integrated canvas (every timeline, and the events and elements of none). */
    timelineId?: string;
}

export type ViewLevel = ViewOptions['level'];
export const VIEW_LEVELS: ViewLevel[] = ['big-picture', 'design-level'];

/** The element kinds shown at each level (spec §6): Big Picture shows events and hotspots only. */
export const LEVEL_KINDS: Record<ViewLevel, readonly NodeElementKind[]> = {
    'big-picture': ['event', 'hotspot'],
    'design-level': ['event', 'actor', 'external', 'command', 'policy', 'aggregate', 'readmodel', 'hotspot'],
};

/**
 * An event drawn once for some occurrences of it: those of one prefix-trie node (a step shared by timelines that agree
 * up to it), or none for an event in no timeline. Never mixes events, nor two occurrences of one timeline.
 */
export interface RenderEventNode {
    type: 'event';
    /** `t:<step keys from the root, joined by '>'>` (`…/<eventId>` inside a group), or `e:<eventId>` outside timelines. */
    id: string;
    eventId: string;
    /** Sorted by timeline ID, then step path. */
    occurrences: EventOccurrence[];
}

/** A group step shared by the timelines whose prefix includes it: its events, without an order. */
export interface RenderGroupNode {
    type: 'group';
    /** `t:<step keys from the root, joined by '>'>`. */
    id: string;
    /** The event nodes of the group, sorted by event ID. */
    members: string[];
    /** The groups it stands for (their IDs and labels may differ between timelines), sorted. */
    groups: { timelineId: string; groupId: string }[];
}

/** Any other element, drawn once per view. */
export interface RenderElementNode {
    type: 'element';
    /** `n:<local ID>`. */
    id: string;
    elementId: string;
    kind: Exclude<NodeElementKind, 'event'>;
}

export type RenderNode = RenderEventNode | RenderGroupNode | RenderElementNode;

export type RenderEdge =
    /** The drawing of a semantic edge; one semantic edge may be drawn several times when its event is. */
    | { type: 'semantic'; id: string; kind: SemanticEdgeKind; source: string; target: string; semantic: string }
    /** Time order between consecutive steps of timelines (from or to a group node, never inside it). */
    | { type: 'sequence'; id: string; source: string; target: string; timelineIds: string[] };

/** One view of a storming. Canonical: the same storming and options give the same graph, whatever the declaration order. */
export interface RenderGraph {
    stormingId: string;
    options: ViewOptions;
    /** Sorted by ID. */
    nodes: RenderNode[];
    /** Sorted by ID. */
    edges: RenderEdge[];
}

// ---- IDs and diagnostics ----

/** Workspace-wide ID of a storming's element (diagnostics' `elementId`, the Live View's selection). */
export const esElementId = (stormingId: string, localId?: string): string => (localId === undefined ? `es/${stormingId}` : `es/${stormingId}/${localId}`);

/** A diagnostic at a range of a `.dtes` file. */
export function esDiagnostic(
    severity: Severity,
    code: RuleId,
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
