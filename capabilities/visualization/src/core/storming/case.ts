// One exception's case (the 流れ「例外: …」, ADR 0032 §11): the main flows and that exception, drawn from the layout of
// every flow (「例外も」) without the other exceptions, so that the events they share stand where they stood and the
// room of the others stays empty. Never laid out of its own: a layout per exception would multiply the views by the
// exceptions. The page draws it alone, and `dt export svg --exception` the same way.
import type { Graph, GraphEdge, GraphNode } from '../graph/ir.js';
import type { RenderGraph, RenderNode } from './ir.js';

/** What a case needs to know of a storming's timelines: which ones are exceptions. */
export interface CaseTimeline {
    readonly id: string;
    readonly exception?: true | undefined;
}

/** The render nodes of a view of sections a case leaves out, and those it draws faint. */
export interface CaseNotes {
    /** Notes of the other exceptions only: not drawn, their place left empty. */
    readonly hidden: ReadonlySet<string>;
    /**
     * Notes of the exception's section off its path: the main flows after it branches off and before it returns (all
     * of them when it does not), and the other main flows. Drawn faint, so that the case reads as one line.
     */
    readonly dimmed: ReadonlySet<string>;
}

const NONE: CaseNotes = { hidden: new Set(), dimmed: new Set() };

/**
 * The notes of a view of sections (`render.grid`) that the case of `exceptionId` leaves out or draws faint. Nothing for
 * a view that is not one of sections, or does not draw the exception.
 */
export function caseNotes(render: RenderGraph, timelines: readonly CaseTimeline[], exceptionId: string): CaseNotes {
    const grid = render.grid;
    if (!grid) return NONE;
    const exceptions = new Set(timelines.filter((t) => t.exception).map((t) => t.id));
    if (!exceptions.has(exceptionId)) return NONE;
    const drawnTimeline = (id: string): boolean => !exceptions.has(id) || id === exceptionId;
    const byId = new Map(render.nodes.map((n) => [n.id, n]));
    const groupOf = new Map(render.nodes.flatMap((n) => (n.type === 'group' ? n.members.map((m) => [m, n.id] as const) : [])));
    /** The timelines a step's node is in (an event's, or a group's). */
    const timelinesAt = (n: RenderNode | undefined): string[] =>
        n?.type === 'event' ? n.occurrences.map((o) => o.timelineId) : n?.type === 'group' ? n.groups.map((g) => g.timelineId) : [];
    if (!render.nodes.some((n) => timelinesAt(n).includes(exceptionId))) return NONE;

    // what is left out: a step of the other exceptions only, and the notes standing at one (a gap with its command)
    const stepKept = (id: string): boolean => {
        const at = timelinesAt(byId.get(id));
        return at.length === 0 || at.some(drawnTimeline);
    };
    const slotOf = (n: RenderNode): string | undefined => grid.slots[n.id];
    const hidden = new Set<string>();
    for (const n of render.nodes) {
        if (n.type === 'event' || n.type === 'group') {
            if (!stepKept(n.id)) hidden.add(n.id);
        } else if (n.type === 'element' || n.type === 'gap') {
            const slot = slotOf(n);
            if (slot !== undefined && !stepKept(slot)) hidden.add(n.id);
        }
    }

    // its path: the steps it is in, the main flows' steps before it branches off, and from where it returns, the main
    // flows' steps there onwards
    const own = render.nodes.filter((n) => timelinesAt(n).includes(exceptionId)).map((n) => n.id);
    const onPath = new Set(own);
    const sequences = render.edges.filter((e) => e.type === 'sequence');
    const mainsAt = (id: string): Set<string> => new Set(timelinesAt(byId.get(id)).filter((t) => !exceptions.has(t)));
    const rowOf = (id: string): number | undefined => grid.cells[id]?.row;
    /**
     * Adds the steps of the main flows at `start` (`mains`) one way from it, the way the time order runs or back, along
     * its row: the other main flows' lanes stay off the path.
     */
    const walk = (start: string, mains: ReadonlySet<string>, forward: boolean): void => {
        const seen = new Set<string>();
        const todo = [start];
        const row = rowOf(start);
        while (todo.length) {
            const id = todo.pop()!;
            if (seen.has(id) || rowOf(id) !== row) continue;
            seen.add(id);
            onPath.add(id);
            for (const e of sequences) {
                if (!e.timelineIds.some((t) => mains.has(t))) continue;
                if (forward && e.source === id) todo.push(e.target);
                if (!forward && e.target === id) todo.push(e.source);
            }
        }
    };
    for (const id of own) {
        const mains = mainsAt(id);
        if (mains.size) walk(id, mains, false);
    }
    for (const e of render.edges) {
        if (e.type !== 'rejoin' || !e.timelineIds.includes(exceptionId)) continue;
        const start = groupOf.get(e.target) ?? e.target;
        walk(start, mainsAt(start), true);
    }
    for (const id of onPath) {
        const n = byId.get(id);
        if (n?.type === 'group') for (const m of n.members) onPath.add(m);
    }

    // faint: the notes of its section that are drawn and off its path (another section is drawn as it is)
    const cols = [...onPath].flatMap((id) => (grid.cells[id] ? [grid.cells[id].col] : []));
    const frame = Object.values(grid.frames).find((f) => cols.some((c) => c >= f.from && c <= f.to));
    const framed = (col: number): boolean => Object.values(grid.frames).some((f) => col >= f.from && col <= f.to);
    const inSection = (id: string): boolean => {
        const cell = grid.cells[groupOf.get(id) ?? id];
        if (!cell || (grid.looseRow !== undefined && cell.row >= grid.looseRow)) return false;
        return frame ? cell.col >= frame.from && cell.col <= frame.to : !framed(cell.col);
    };
    const dimmed = new Set<string>();
    for (const n of render.nodes) {
        if (hidden.has(n.id) || n.type === 'stage' || !inSection(n.id)) continue;
        const step = n.type === 'event' || n.type === 'group' ? n.id : slotOf(n);
        if (step !== undefined && !onPath.has(step)) dimmed.add(n.id);
    }
    return { hidden, dimmed };
}

/**
 * A view's graph drawn as the case of `exceptionId` (`caseNotes`): the other exceptions' notes and their lines left out
 * (nothing moves), the notes off its path and their lines faint (`dimmed`). `render` is the view's render graph (the
 * graph's nodes keep its IDs). The graph itself when the view draws no such case.
 */
export function caseInDrawing<G extends Graph>(graph: G, render: RenderGraph, timelines: readonly CaseTimeline[], exceptionId: string): G {
    const { hidden, dimmed } = caseNotes(render, timelines, exceptionId);
    if (!hidden.size && !dimmed.size) return graph;
    const exceptions = new Set(timelines.filter((t) => t.exception && t.id !== exceptionId).map((t) => t.id));
    const renderEdges = new Map(render.edges.map((e) => [e.id, e]));
    /** A time order of the other exceptions only. */
    const othersOnly = (id: string): boolean => {
        const e = renderEdges.get(id);
        return (e?.type === 'sequence' || e?.type === 'rejoin') && e.timelineIds.every((t) => exceptions.has(t));
    };
    const edges = graph.edges.filter((e) => !hidden.has(e.source) && !hidden.has(e.target) && !othersOnly(e.id));
    return {
        ...graph,
        nodes: graph.nodes.filter((n) => !hidden.has(n.id)).map((n): GraphNode => (dimmed.has(n.id) ? { ...n, dimmed: true } : n)),
        edges: edges.map((e): GraphEdge => (dimmed.has(e.source) || dimmed.has(e.target) ? { ...e, dimmed: true } : e)),
    };
}
