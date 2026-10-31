import type { DomainModel, ElementModel } from '../../../model/model.js';
import { bodyWidth } from './build.js';
import { LINE_HEIGHT, type Graph, type GraphLine, type GraphNode } from './ir.js';

export interface ModelDiff {
    added: string[];
    changed: string[];
    removed: string[];
}

export const EMPTY_DIFF: ModelDiff = { added: [], changed: [], removed: [] };

/**
 * Fingerprints of every addressable item (elements, states, commands) by stable ID.
 * Source locations are excluded so that moving code around is not a change.
 */
export function fingerprints(model: DomainModel): Map<string, string> {
    const out = new Map<string, string>();
    for (const el of Object.values(model.elements)) {
        out.set(el.id, JSON.stringify(strip(el)));
        for (const s of el.states ?? []) out.set(s.id, JSON.stringify({ ...s, location: undefined }));
        for (const c of el.commands ?? []) out.set(c.id, JSON.stringify({ ...c, location: undefined }));
    }
    return out;
}

function strip(el: ElementModel): unknown {
    return {
        ...el,
        location: undefined,
        states: el.states?.map((s) => ({ ...s, location: undefined })),
        commands: el.commands?.map((c) => ({ ...c, location: undefined })),
    };
}

/** Additions, changes and removals between the previous valid model and the current one. */
export function diffModels(prev: DomainModel | undefined, next: DomainModel): ModelDiff {
    if (!prev) return EMPTY_DIFF;
    const a = fingerprints(prev);
    const b = fingerprints(next);
    const diff: ModelDiff = { added: [], changed: [], removed: [] };
    for (const [id, fp] of b) {
        const old = a.get(id);
        if (old === undefined) diff.added.push(id);
        else if (old !== fp) diff.changed.push(id);
    }
    for (const id of a.keys()) if (!b.has(id)) diff.removed.push(id);
    return diff;
}

export const isEmptyDiff = (d: ModelDiff): boolean => !d.added.length && !d.changed.length && !d.removed.length;

/**
 * Marks the body rows (fields…) of `graph`'s nodes against the same nodes in `base`, the graph of the baseline model:
 * added and changed rows, and the baseline's removed rows inserted as ghosts where they were, the node growing to
 * hold them. Nodes that are not in `base` (added elements) are left as they are. Rows are matched by their key (a
 * field's name), the n-th row of a key with the n-th one.
 */
export function markLineChanges(graph: Graph, base: Graph | undefined): Graph {
    if (!base) return graph;
    const before = new Map(base.nodes.map((n) => [n.id, n]));
    return { ...graph, nodes: graph.nodes.map((n) => markNode(n, before.get(n.id))) };
}

function markNode(n: GraphNode, base: GraphNode | undefined): GraphNode {
    if (!base || base.kind !== n.kind || (!n.lines.length && !base.lines.length)) return n;
    const keys = lineKeys(n.lines);
    const baseKeys = lineKeys(base.lines);
    const baseByKey = new Map(baseKeys.map((k, i) => [k, base.lines[i]]));
    const present = new Set(keys);
    const out: GraphLine[] = [];
    let marked = false;
    // a removed row goes after the row that preceded it in the baseline, or first
    const removedAfter = new Map<string | undefined, GraphLine[]>();
    let previous: string | undefined;
    baseKeys.forEach((k, i) => {
        if (present.has(k)) previous = k;
        else removedAfter.set(previous, [...(removedAfter.get(previous) ?? []), { ...base.lines[i], change: 'removed' }]);
    });
    out.push(...(removedAfter.get(undefined) ?? []));
    n.lines.forEach((line, i) => {
        const old = baseByKey.get(keys[i]);
        const change = !old ? 'added' : JSON.stringify(old) !== JSON.stringify(line) ? 'changed' : undefined;
        if (change) marked = true;
        out.push(change ? { ...line, change } : line);
        out.push(...(removedAfter.get(keys[i]) ?? []));
    });
    const removed = out.length - n.lines.length;
    if (!marked && !removed) return n;
    return {
        ...n,
        lines: out,
        width: Math.max(n.width, bodyWidth(out)),
        // a body gets its padding with its first row
        height: n.height + removed * LINE_HEIGHT + (n.lines.length === 0 ? 10 : 0),
    };
}

/** A row's identity: its key by name, numbered when the key repeats (the same field in two union variants). */
function lineKeys(lines: GraphLine[]): string[] {
    const seen = new Map<string, number>();
    return lines.map((l) => {
        const k = l.key.en.name;
        const i = seen.get(k) ?? 0;
        seen.set(k, i + 1);
        return `${k}#${i}`;
    });
}
