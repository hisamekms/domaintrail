import type { Diagnostic } from '../core/diagnostics.js';
import type { Storming } from '../dtes/ir.js';
import type { RenderGraph } from './domain/storming/ir.js';
import type { ModelDiff } from './domain/graph/diff.js';
import type { LaidOutGraph, TransitionLabels } from './domain/graph/ir.js';
import type { DomainModel } from '../model/model.js';
import type { GitCommit } from './application/ports.js';

export type ViewStatus = 'ok' | 'invalid' | 'syntax-error' | 'empty';

/** What the model is compared with: the previously shown model, or a git revision of the workspace. */
export type BaselineSpec = { kind: 'previous' } | { kind: 'git'; ref: string };

/** The baseline in use; for a git revision, the commit it resolves to, or why it cannot be compared with. */
export type Baseline =
    | { kind: 'previous' }
    | {
          kind: 'git';
          ref: string;
          commit?: GitCommit;
          /** The revision is unknown, or its sources do not parse (then nothing is marked as changed). */
          error?: string;
          /** Number of .dt files in the revision. */
          files: number;
      };

/** The baseline's model and its graphs as laid out for it (ghosts of removed elements are drawn where they were). */
export type BaseView = Pick<ViewPayload, 'model' | 'structure' | 'overview' | 'aggregates' | 'contextMap' | 'contextMapAll' | 'states'>;

/**
 * A storming of the workspace with every view of it laid out (ADR 0024): the level and the timeline filter are the page's
 * state, so switching between them needs no request and never touches the `.dtes` (spec §6, R11, R12).
 */
export interface StormingView {
    id: string;
    label?: string;
    file: string;
    timelines: { id: string; label?: string }[];
    /** The storming as written, for the inspector (`ref`s, clauses, timelines). */
    storming: Storming;
    /**
     * Keyed by `stormingViewKey` (`<level>|<timelineId or empty>`): the render graph (the occurrences each event node
     * stands for) and its drawing.
     */
    views: Record<string, { render: RenderGraph; graph: LaidOutGraph }>;
    /** True when its file no longer parses and this is the storming as it last did. */
    stale: boolean;
}

/** Message pushed from the view server to the browser over WebSocket (and served at /api/state). */
export interface ViewPayload {
    type: 'update';
    version: number;
    updatedAt: string;
    root: string;
    files: string[];
    /**
     * ok: no errors; invalid: parses but has semantic errors (still drawn);
     * syntax-error: the last drawable model is kept; empty: no .dt or .dtes files.
     */
    status: ViewStatus;
    /** True when the diagram shows an older model because the current sources do not parse. */
    stale: boolean;
    model: DomainModel | null;
    structure: LaidOutGraph | null;
    /** Structure overview: names only, larger text. */
    overview: LaidOutGraph | null;
    /** Structure View at the aggregates level: aggregates and the dependencies between them only. */
    aggregates: LaidOutGraph | null;
    /** State View graphs keyed by aggregate ID, laid out for each way of labeling transitions. */
    states: Record<string, Record<TransitionLabels, LaidOutGraph>>;
    /** Contexts that can be focused in the Structure View (the graphs are served on request at /api/focus). */
    focusContexts: string[];
    /** Context Map without shared / ID-only contexts, and with every context. */
    contextMap: LaidOutGraph | null;
    contextMapAll: LaidOutGraph | null;
    /** The Event Storming views, in file order, then source order (a storming whose ID is taken is left out, S001). */
    stormings: StormingView[];
    diagnostics: Diagnostic[];
    /** Current text of every .dt and .dtes file (even when it does not parse). */
    sources: { path: string; text: string }[];
    /** Incremented whenever the shown model changes (not on diagnostics-only updates). */
    modelVersion: number;
    /** Differences between the model shown and the baseline. */
    diff: ModelDiff;
    baseline: Baseline;
    /** The baseline's model and graphs; null when there is none (the first model shown, a revision that does not parse). */
    base: BaseView | null;
    layoutEngine: string;
}
