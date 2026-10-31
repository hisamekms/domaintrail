/**
 * The views of a storming (docs/dtes-v0.1.md, ADR 0024): the types the projection produces from the storming IR
 * (`Storming`, in `src/dtes/ir.ts`) and the Live View draws (spec §7):
 *
 * - the **semantic graph** (`SemanticGraph`): the valid elements and relations only, independent of timelines;
 * - the **render graph** (`RenderGraph`): the nodes and edges of one view (`ViewOptions`), where one event node may stand
 *   for several occurrences of the same event (a pure drawing optimization: it never adds a semantic edge).
 */
import type { NodeElement, NodeElementKind, TimelineStep } from '../../../dtes/ir.js';

// ---- Semantic graph (spec §7.1, §9.1) ----

/**
 * The kind of a semantic edge. `hotspot-on` is a hotspot's `on`, which is not causal; a policy's `on` is `on`.
 * `actor`, `reads` and `target` relate, `on`, `issues` and `emits` are type-level causal candidates.
 */
export type SemanticEdgeKind = 'on' | 'issues' | 'emits' | 'target' | 'actor' | 'reads' | 'hotspot-on';

/** A valid relation, directed as in spec §9.1 (`Event → Policy`, `Actor → Command`, `Read Model → Command`, the others from the owner). */
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
