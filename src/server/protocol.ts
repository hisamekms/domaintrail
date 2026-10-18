import type { Diagnostic } from '../core/diagnostics.js';
import type { ModelDiff } from '../graph/diff.js';
import type { LaidOutGraph, TransitionLabels } from '../graph/ir.js';
import type { DomainModel } from '../model/model.js';

export type ViewStatus = 'ok' | 'invalid' | 'syntax-error' | 'empty';

/** Message pushed from the view server to the browser over WebSocket (and served at /api/state). */
export interface ViewPayload {
    type: 'update';
    version: number;
    updatedAt: string;
    root: string;
    files: string[];
    /**
     * ok: no errors; invalid: parses but has semantic errors (still drawn);
     * syntax-error: the last drawable model is kept; empty: no .dt files.
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
    diagnostics: Diagnostic[];
    /** Current text of every .dt file (even when it does not parse). */
    sources: { path: string; text: string }[];
    /** Incremented whenever the shown model changes (not on diagnostics-only updates). */
    modelVersion: number;
    /** Differences between the model shown and the previously shown model. */
    diff: ModelDiff;
    layoutEngine: string;
}
