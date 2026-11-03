/**
 * The views of a storming (docs/dtes-v0.1.md, ADR 0024): the types the projection produces from the storming IR and
 * its semantic graph and occurrences (`Storming`, `SemanticGraph`, `EventOccurrence`: Storming's, in
 * `@domaintrail/modeling`) and the Live View draws (spec §7): the **render graph** (`RenderGraph`), the nodes and edges
 * of one view (`ViewOptions`), where one event node may stand for several occurrences of the same event (a pure drawing
 * optimization: it never adds a semantic edge).
 */
import type { EventOccurrence, NodeElementKind, SemanticEdgeKind, TimelineStep } from '@domaintrail/storming';

// ---- Semantic edges as drawn (spec §9.4) ----

/** How a semantic edge is drawn (spec §9.4): solid causal, dotted related. */
export const isCausal = (kind: SemanticEdgeKind): boolean => kind === 'on' || kind === 'issues' || kind === 'emits';

// ---- Timeline steps compared (spec §7.2, §8.3) ----

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
    /**
     * Absent, with no `stageId`: the integrated canvas (every timeline, and the events and elements of none); of a
     * storming with stages, its stages in time order.
     */
    timelineId?: string;
    /** One stage of a storming with stages: its main flows and its exceptions (never with `timelineId`). */
    stageId?: string;
    /**
     * Without the exceptions (the integrated canvas and a stage of a storming drawn in sections only): their steps, the
     * events only they have and the hotspots on those events are not drawn.
     */
    hideExceptions?: true;
}

export type ViewLevel = ViewOptions['level'];
export const VIEW_LEVELS: ViewLevel[] = ['big-picture', 'design-level'];

/**
 * The element kinds shown at each level (spec §6): Big Picture shows events and hotspots only, and of the events not
 * those marked `level design` (`isDesignLevelOnly`, applied by the projection).
 */
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

/** A stage, drawn as a frame around its main flow and its exceptions (views of a storming with stages, spec §3.7). */
export interface RenderStageNode {
    type: 'stage';
    /** `st:<stage ID>`. */
    id: string;
    stageId: string;
}

export type RenderNode = RenderEventNode | RenderGroupNode | RenderElementNode | RenderStageNode;

export type RenderEdge =
    /** The drawing of a semantic edge; one semantic edge may be drawn several times when its event is. */
    | { type: 'semantic'; id: string; kind: SemanticEdgeKind; source: string; target: string; semantic: string }
    /**
     * Time order between consecutive steps of timelines (from or to a group node, never inside it); `exception` when
     * every one of them is an exception (a view of sections only).
     */
    | { type: 'sequence'; id: string; source: string; target: string; timelineIds: string[]; exception?: true }
    /** `then <Event>`: from the last step of exceptions back to the step of a main flow they return to. */
    | { type: 'rejoin'; id: string; source: string; target: string; timelineIds: string[] }
    /** `after`: from the last step of a stage's main flow to the first step of the next stage's. */
    | { type: 'stage'; id: string; source: string; target: string; stageId: string };

/** A cell of a view of stages: a column (left to right, in time order) and a row (0: the main flows, below: exceptions). */
export interface GridCell {
    col: number;
    row: number;
}

/**
 * Where a view of stages puts its nodes (spec §3.7, §10): every column is a step later than the one on its left, the
 * main flows run along row 0 through every stage, an exception hangs below the step it branches off from, and the
 * other elements stand above the event they belong to (negative rows). The layout turns cells into coordinates.
 */
export interface StageGrid {
    /** The cell of each event, group and element node (a group's members are inside it). */
    cells: Record<string, GridCell>;
    /** The columns of each stage's frame, by stage node ID. */
    frames: Record<string, { from: number; to: number }>;
    /** The first row of the nodes outside every stage (events of no stage, elements of no step), if there are some. */
    looseRow?: number;
    /** The edges into the first step of an exception's lane, with the exceptions they start (their labels caption it). */
    captions: Record<string, string[]>;
}

/** One view of a storming. Canonical: the same storming and options give the same graph, whatever the declaration order. */
export interface RenderGraph {
    stormingId: string;
    options: ViewOptions;
    /** Sorted by ID. */
    nodes: RenderNode[];
    /** Sorted by ID. */
    edges: RenderEdge[];
    /** A view of stages: the cells of its nodes. */
    grid?: StageGrid;
}
