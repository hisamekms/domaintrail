import { bodyWidth } from './build.js';
import { LINE_HEIGHT, type Graph, type GraphLine, type GraphNode } from './ir.js';

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
