import { contextDependencies, groupByContext, supportingContexts } from '../model/dependencies.js';
import type { DomainModel, ElementKind } from '../model/model.js';
import { elementList } from '../model/model.js';
import { named, sized } from './build.js';
import { maxUnits, sameText, type Graph, type GraphEdge, type GraphLine, type GraphNode, type Texts } from './ir.js';

/** Width of one character of a node label (15px bold), in pixels. */
const LABEL_CHAR_WIDTH = 10;

/** Context map without shared and ID-only contexts. */
export const CONTEXT_MAP_GRAPH_ID = 'context-map';
/** Context map with every context. */
export const CONTEXT_MAP_ALL_GRAPH_ID = 'context-map-all';

/**
 * Node ID of a context in the Context Map. It differs from the context's group node in the Structure View, since
 * shapes are reused by ID across views and a node cannot turn into a group.
 */
export const contextNodeId = (ctx: string): string => `map:${ctx}`;

/** Kinds counted on a context node, with their names. */
const COUNTED: { kind: ElementKind; name: string; label: string }[] = [
    { kind: 'aggregate', name: 'aggregates', label: '集約' },
    { kind: 'entity', name: 'entities', label: 'Entity' },
    { kind: 'valueObject', name: 'value objects', label: 'Value Object' },
    { kind: 'union', name: 'unions', label: 'Union' },
    { kind: 'enum', name: 'enums', label: 'Enum' },
    { kind: 'primitive', name: 'primitives', label: 'Domain Primitive' },
    { kind: 'id', name: 'IDs', label: 'ID' },
    { kind: 'event', name: 'events', label: 'Event' },
];

/** `ID 12 · 型 3` / `ID 12 · type 3`, leaving out zero counts. */
export function dependencyCounts(ids: number, types: number): Texts {
    const part = (word: string, n: number): string[] => (n ? [`${word} ${n}`] : []);
    const label = [...part('ID', ids), ...part('型', types)].join(' · ');
    const name = [...part('ID', ids), ...part('type', types)].join(' · ');
    return { label, name, both: label };
}

/**
 * Context Map: one node per bounded context and one edge per pair of contexts with a dependency, from the
 * dependent to its dependency. Edges that borrow types (not only IDs) are drawn solid. Without `all`, shared
 * contexts and contexts that only declare IDs are left out, since nearly everything depends on them.
 */
export function buildContextMapGraph(model: DomainModel, opts: { all?: boolean } = {}): Graph {
    const hidden = opts.all ? new Set<string>() : supportingContexts(model);
    const shownContexts = model.contexts.filter((c) => !hidden.has(c));
    const nodes: GraphNode[] = shownContexts.map((ctx) => {
        const els = elementList(model).filter((e) => e.context === ctx);
        const lines: GraphLine[] = COUNTED.flatMap(({ kind, name, label }) => {
            const n = els.filter((e) => e.kind === kind).length;
            return n ? [{ key: { name, label, both: label }, value: sameText(String(n)) }] : [];
        });
        const shared = model.sharedContexts.includes(ctx);
        const idOnly = !shared && els.length > 0 && els.every((e) => e.kind === 'id');
        const node = sized({
            id: contextNodeId(ctx),
            kind: 'boundedContext',
            label: named(ctx, model.contextLabels[ctx]),
            stereotype: shared ? '«shared kernel»' : idOnly ? '«external»' : '«bounded context»',
            lines,
            elementId: ctx,
        });
        // the label is drawn larger and bold than body rows; keep it on one line
        return { ...node, width: Math.max(node.width, Math.ceil(maxUnits(node.label) * LABEL_CHAR_WIDTH + 40)) };
    });
    const edges: GraphEdge[] = groupByContext(contextDependencies(model))
        .filter((g) => !hidden.has(g.from) && !hidden.has(g.to))
        .map((g) => ({
            // `<from>|<to>`: selecting the edge selects the dependent context
            id: `${g.from}|${g.to}`,
            kind: g.types > 0 ? 'dependsOn' : 'references',
            source: contextNodeId(g.from),
            target: contextNodeId(g.to),
            label: dependencyCounts(g.ids, g.types),
        }));
    return { id: opts.all ? CONTEXT_MAP_ALL_GRAPH_ID : CONTEXT_MAP_GRAPH_ID, nodes, edges };
}
