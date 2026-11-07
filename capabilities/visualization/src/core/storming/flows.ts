// What the canvas of a storming carries (ADR 0032 §11): every flow, or one main flow, drawn in the same layout — the
// other main flows (and the exceptions branching off them) left out where they stood — and the exceptions as a layer
// over it, one of which can be emphasized: its path dark, the rest faint. Nothing is laid out again for either, so no
// sticky moves. The page draws it alone, and `dt export svg --timeline` the same way (without the emphasis).
import { buildSemanticGraph, type Storming } from '@domaintrail/storming';
import type { Graph, GraphEdge, GraphNode } from '../graph/ir.js';
import { filterEdges } from './filter.js';
import type { RenderGraph, RenderNode } from './ir.js';

/** What the flows need to know of a storming's timelines, in its order (`StormingView.timelines`). */
export interface FlowTimeline {
    readonly id: string;
    readonly label?: string | undefined;
    readonly stageId?: string | undefined;
    readonly exception?: true | undefined;
}

/**
 * A main flow, as the breadcrumb lists it. Drawn in sections (stages or exceptions), the trunk — the first main flow of
 * each stage, one straight row through every stage — is one main flow (its ID: the first stage's), and every other main
 * flow of a stage is one, after the trunk before it; otherwise each timeline is one.
 */
export interface MainFlow {
    readonly id: string;
    readonly label?: string | undefined;
    /** Its timelines: the trunk's of every stage, or the one. */
    readonly timelines: readonly string[];
}

/** The main flows of a storming (`MainFlow`), the trunk first. `stages`: its stages in time order. */
export function mainFlows(timelines: readonly FlowTimeline[], stages: readonly { readonly id: string }[] | undefined): MainFlow[] {
    const mains = timelines.filter((t) => !t.exception);
    const inSections = (stages?.length ?? 0) > 0 || timelines.some((t) => t.exception);
    const one = (t: FlowTimeline): MainFlow => ({ id: t.id, ...(t.label !== undefined && { label: t.label }), timelines: [t.id] });
    if (!inSections) return mains.map(one);
    const known = new Set((stages ?? []).map((s) => s.id));
    const sections = [...(stages ?? []).map((s) => s.id), undefined];
    const trunks = sections.flatMap((id) => {
        const t = mains.find((m) => (id === undefined ? m.stageId === undefined || !known.has(m.stageId) : m.stageId === id));
        return t ? [t] : [];
    });
    const first = trunks[0];
    if (!first) return [];
    const trunk: MainFlow = { id: first.id, ...(first.label !== undefined && { label: first.label }), timelines: trunks.map((t) => t.id) };
    return [trunk, ...mains.filter((m) => !trunks.includes(m)).map(one)];
}

/** The main flow a timeline is part of (an exception: none). */
export const mainFlowOf = (flows: readonly MainFlow[], timelineId: string): MainFlow | undefined => flows.find((f) => f.timelines.includes(timelineId));

/** What a canvas draws of its layout: the main flow shown, if one is, and the exception emphasized, if one is. */
export interface FlowChoice {
    readonly main?: MainFlow | undefined;
    readonly focus?: string | undefined;
}

/** The notes of a view (render node IDs) a flow choice leaves out, draws faint, and the stage frames it leaves empty. */
export interface FlowNotes {
    /** Not drawn, their place left empty: the other main flows', and what stands with them. */
    readonly hidden: ReadonlySet<string>;
    /** Off the path of the exception emphasized: drawn faint. */
    readonly dimmed: ReadonlySet<string>;
    /** Stage frames with nothing drawn in them: drawn dashed. */
    readonly unused: ReadonlySet<string>;
    /** The exceptions drawn (in a view with them): every one, or those branching off the main flow shown. */
    readonly exceptions: readonly string[];
}

const timelinesAt = (n: RenderNode | undefined): string[] =>
    n?.type === 'event' ? n.occurrences.map((o) => o.timelineId) : n?.type === 'group' ? n.groups.map((g) => g.timelineId) : [];

/**
 * The notes of a view of `storming` that `choice` leaves out or draws faint (`FlowNotes`). A view of sections (its
 * grid) keeps a note with its step; the merged canvas of a storming without stages nor exceptions keeps the events of
 * the main flow and the elements its timeline's view relates to them (`filterEdges`).
 */
export function flowNotes(render: RenderGraph, storming: Storming, timelines: readonly FlowTimeline[], choice: FlowChoice): FlowNotes {
    const grid = render.grid;
    const exceptionIds = new Set(timelines.filter((t) => t.exception).map((t) => t.id));
    const byId = new Map(render.nodes.map((n) => [n.id, n]));
    const steps = render.nodes.filter((n) => n.type === 'event' || n.type === 'group');
    const allExceptions = timelines.filter((t) => t.exception && steps.some((n) => timelinesAt(n).includes(t.id))).map((t) => t.id);
    const main = choice.main;
    if (!grid) {
        if (!main) return { hidden: new Set(), dimmed: new Set(), unused: new Set(), exceptions: allExceptions };
        const members = new Set(main.timelines);
        const events = new Set(render.nodes.flatMap((n) => (n.type === 'event' && n.occurrences.some((o) => members.has(o.timelineId)) ? [n.eventId] : [])));
        const related = new Set(filterEdges(buildSemanticGraph(storming).edges, events).flatMap((e) => [e.sourceId, e.targetId]));
        const hidden = new Set(
            render.nodes.flatMap((n) =>
                (n.type === 'event' && !events.has(n.eventId)) || (n.type === 'element' && !related.has(n.elementId)) || n.type === 'gap' ? [n.id] : [],
            ),
        );
        return { hidden, dimmed: new Set(), unused: new Set(), exceptions: [] };
    }

    const sequences = render.edges.filter((e) => e.type === 'sequence' || e.type === 'stage');
    const trunkIds = new Set(trunkTimelines(timelines));
    /** Adds the steps reached from `starts` along the time order (`forward`, or back), on the timelines `along`. */
    const walk = (
        starts: readonly string[],
        along: ReadonlySet<string>,
        forward: boolean,
        within: ReadonlySet<string> | undefined,
        into: Set<string>,
    ): void => {
        const todo = [...starts];
        const seen = new Set<string>();
        while (todo.length) {
            const id = todo.pop()!;
            if (seen.has(id) || (within && !within.has(id))) continue;
            seen.add(id);
            into.add(id);
            for (const e of sequences) {
                const on = e.type === 'stage' || e.timelineIds.some((t) => along.has(t));
                if (!on) continue;
                if (forward && e.source === id) todo.push(e.target);
                if (!forward && e.target === id) todo.push(e.source);
            }
        }
    };
    const groupOf = new Map(render.nodes.flatMap((n) => (n.type === 'group' ? n.members.map((m) => [m, n.id] as const) : [])));
    const stepOf = (id: string): string => groupOf.get(id) ?? id;

    // what is drawn: every step, or the main flow's (with the trunk before it) and the exceptions branching off it
    let drawn: Set<string> | undefined;
    let exceptions = allExceptions;
    if (main) {
        const members = new Set(main.timelines);
        const own = steps.filter((n) => timelinesAt(n).some((t) => members.has(t))).map((n) => n.id);
        drawn = new Set(own);
        walk(
            own.filter((id) => timelinesAt(byId.get(id)).some((t) => trunkIds.has(t))),
            trunkIds,
            false,
            undefined,
            drawn,
        );
        exceptions = allExceptions.filter((x) => [...drawn!].some((id) => timelinesAt(byId.get(id)).includes(x)));
        for (const n of steps) if (timelinesAt(n).some((t) => exceptions.includes(t))) drawn.add(n.id);
        for (const id of drawn) {
            const n = byId.get(id);
            if (n?.type === 'group') for (const m of n.members) drawn.add(m);
        }
    }
    const drawsStep = (id: string | undefined): boolean => drawn === undefined || (id !== undefined && drawn.has(stepOf(id)));
    const hidden = new Set<string>();
    if (drawn) {
        for (const n of render.nodes) {
            if (n.type === 'stage') continue;
            const step = n.type === 'event' || n.type === 'group' ? n.id : grid.slots[n.id];
            if (!drawsStep(step)) hidden.add(n.id);
        }
    }

    // the emphasis: the exception's steps, the main flow before it branches off and from where it returns onwards
    const dimmed = new Set<string>();
    const focus = choice.focus;
    if (focus !== undefined && exceptions.includes(focus)) {
        const within = new Set(steps.map((n) => n.id).filter((id) => !hidden.has(id)));
        const along = (id: string): Set<string> => {
            if (main) return new Set([...main.timelines, ...trunkIds]);
            const here = timelinesAt(byId.get(id)).filter((t) => !exceptionIds.has(t));
            return new Set(here.some((t) => trunkIds.has(t)) ? trunkIds : here);
        };
        const path = new Set<string>();
        const own = steps.filter((n) => timelinesAt(n).includes(focus)).map((n) => n.id);
        for (const id of own) path.add(id);
        for (const id of own) if (timelinesAt(byId.get(id)).some((t) => !exceptionIds.has(t))) walk([id], along(id), false, within, path);
        for (const e of render.edges) {
            if (e.type !== 'rejoin' || !e.timelineIds.includes(focus)) continue;
            const start = stepOf(e.target);
            walk([start], main ? new Set(main.timelines) : along(start), true, within, path);
        }
        for (const id of path) {
            const n = byId.get(id);
            if (n?.type === 'group') for (const m of n.members) path.add(m);
        }
        for (const n of render.nodes) {
            if (hidden.has(n.id) || n.type === 'stage') continue;
            const step = n.type === 'event' || n.type === 'group' ? n.id : grid.slots[n.id];
            if (step === undefined || !path.has(stepOf(step))) dimmed.add(n.id);
        }
    }

    // a stage frame with nothing drawn in it
    const unused = new Set<string>();
    if (drawn) {
        for (const [frame, { from, to }] of Object.entries(grid.frames)) {
            const any = [...drawn].some((id) => {
                const c = grid.cells[id];
                return c !== undefined && c.col >= from && c.col <= to;
            });
            if (!any) unused.add(frame);
        }
    }
    return { hidden, dimmed, unused, exceptions };
}

/** The trunk's timelines: the first main flow of each stage, and of the timelines in no stage. */
function trunkTimelines(timelines: readonly FlowTimeline[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of timelines) {
        if (t.exception) continue;
        const key = t.stageId ?? '';
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t.id);
    }
    return out;
}

/**
 * A view's graph drawn as `choice` draws it in its layout (`flowNotes`): the notes left out and their lines not drawn
 * (nothing moves), the notes off the emphasized exception's path and their lines faint (`dimmed`), the stage frames
 * with nothing in them dashed (`unused`). `render` is the view's render graph (the graph keeps its node IDs; the
 * merged canvas's event notes are `e:<event>`). The graph itself when nothing changes.
 */
export function flowInDrawing<G extends Graph>(graph: G, render: RenderGraph, storming: Storming, timelines: readonly FlowTimeline[], choice: FlowChoice): G {
    if (!choice.main && choice.focus === undefined) return graph;
    const { hidden, dimmed, unused } = flowNotes(render, storming, timelines, choice);
    if (!hidden.size && !dimmed.size && !unused.size) return graph;
    // the merged canvas draws an event's render nodes as one note
    const noteOf = new Map(render.nodes.flatMap((n) => (n.type === 'event' && !render.grid ? [[n.id, `e:${n.eventId}`] as const] : [])));
    const gone = new Set([...hidden].map((id) => noteOf.get(id) ?? id));
    // an event note of the merged canvas stays while any of its render nodes is drawn
    for (const [id, note] of noteOf) if (!hidden.has(id)) gone.delete(note);
    const faint = new Set([...dimmed].map((id) => noteOf.get(id) ?? id));
    const drawnTimelines = new Set(
        timelines.map((t) => t.id).filter((id) => !choice.main || choice.main.timelines.includes(id) || timelines.find((t) => t.id === id)?.exception),
    );
    const renderEdges = new Map(render.edges.map((e) => [e.id, e]));
    /** A time order of none of the timelines drawn. */
    const otherFlow = (id: string): boolean => {
        const e = renderEdges.get(id);
        return choice.main !== undefined && (e?.type === 'sequence' || e?.type === 'rejoin') && !e.timelineIds.some((t) => drawnTimelines.has(t));
    };
    const edges = graph.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target) && !otherFlow(e.id));
    return {
        ...graph,
        nodes: graph.nodes
            .filter((n) => !gone.has(n.id))
            .map((n): GraphNode => (faint.has(n.id) ? { ...n, dimmed: true } : unused.has(n.id) ? { ...n, unused: true } : n)),
        edges: edges.map((e): GraphEdge => (faint.has(e.source) || faint.has(e.target) ? { ...e, dimmed: true } : e)),
    };
}

/**
 * The lanes of the exceptions of a view of sections, for the canvas to draw their bands and labels: each exception's
 * own steps (those of exceptions only) with the notes standing at them, and the edges into its lane whose caption
 * names it (`StageGrid.captions`). None for a view without a grid.
 */
export function exceptionLanes(render: RenderGraph, timelines: readonly FlowTimeline[]): Map<string, { notes: string[]; captions: string[] }> {
    const grid = render.grid;
    const out = new Map<string, { notes: string[]; captions: string[] }>();
    if (!grid) return out;
    const exceptionIds = new Set(timelines.filter((t) => t.exception).map((t) => t.id));
    for (const n of render.nodes) {
        const at = timelinesAt(n);
        if (!at.length || !at.every((t) => exceptionIds.has(t))) continue;
        for (const t of new Set(at)) {
            const lane = out.get(t) ?? { notes: [], captions: [] };
            lane.notes.push(n.id);
            out.set(t, lane);
        }
    }
    for (const [note, step] of Object.entries(grid.slots)) {
        for (const lane of out.values()) if (lane.notes.includes(step)) lane.notes.push(note);
    }
    for (const [edge, names] of Object.entries(grid.captions)) for (const t of names) out.get(t)?.captions.push(edge);
    return out;
}

/** The steps an exception's emphasis brings into view: its own, where it branches off, and where it returns to. */
export function exceptionSpan(render: RenderGraph, exceptionId: string): string[] {
    const own = render.nodes.filter((n) => timelinesAt(n).includes(exceptionId)).map((n) => n.id);
    const back = render.edges.flatMap((e) => (e.type === 'rejoin' && e.timelineIds.includes(exceptionId) ? [e.target] : []));
    return [...new Set([...own, ...back])];
}
