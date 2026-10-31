import { contextDependencies, groupByContext, supportingContexts } from '../../../model/dependencies.js';
import type { DomainModel, ElementKind } from '../../../model/model.js';
import { elementList } from '../../../model/model.js';
import { named, sized } from './build.js';
import { maxUnits, perLang, sameText, type Graph, type GraphEdge, type GraphLine, type GraphNode, type Texts } from './ir.js';

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
const COUNTED: { kind: ElementKind; ja: string; en: string }[] = [
    { kind: 'aggregate', ja: '集約', en: 'aggregates' },
    { kind: 'entity', ja: 'エンティティ', en: 'entities' },
    { kind: 'valueObject', ja: '値オブジェクト', en: 'value objects' },
    { kind: 'union', ja: 'ユニオン', en: 'unions' },
    { kind: 'enum', ja: '列挙型', en: 'enums' },
    { kind: 'primitive', ja: 'ドメインプリミティブ', en: 'primitives' },
    { kind: 'id', ja: 'ID', en: 'IDs' },
    { kind: 'event', ja: 'ドメインイベント', en: 'events' },
];

/** `ID 12 · 型 3 · イベント 1` / `ID 12 · type 3 · event 1`, leaving out zero counts. */
export function dependencyCounts(ids: number, types: number, events = 0): Texts {
    const part = (word: string, n: number): string[] => (n ? [`${word} ${n}`] : []);
    return perLang({
        ja: [...part('ID', ids), ...part('型', types), ...part('イベント', events)].join(' · '),
        en: [...part('ID', ids), ...part('type', types), ...part('event', events)].join(' · '),
    });
}

/**
 * Context Map: one node per bounded context and one edge per pair of contexts with a dependency, from the
 * dependent to its dependency. Edges that borrow types (not only IDs) are drawn solid; so are those of policies that react
 * to events of the other context (counted as events). Without `all`, shared
 * contexts and contexts that only declare IDs are left out, since nearly everything depends on them.
 */
export function buildContextMapGraph(model: DomainModel, opts: { all?: boolean } = {}): Graph {
    const hidden = opts.all ? new Set<string>() : supportingContexts(model);
    const shownContexts = model.contexts.filter((c) => !hidden.has(c));
    const nodes: GraphNode[] = shownContexts.map((ctx) => {
        const els = elementList(model).filter((e) => e.context === ctx);
        const lines: GraphLine[] = COUNTED.flatMap(({ kind, ja, en }) => {
            const n = els.filter((e) => e.kind === kind).length;
            return n ? [{ key: perLang({ ja, en }), value: sameText(String(n)) }] : [];
        });
        const shared = model.sharedContexts.includes(ctx);
        const idOnly = !shared && els.length > 0 && els.every((e) => e.kind === 'id');
        const node = sized({
            id: contextNodeId(ctx),
            kind: 'boundedContext',
            label: named(ctx, model.contextLabels[ctx]),
            stereotype: perLang(
                shared
                    ? { ja: '«共有カーネル»', en: '«shared kernel»' }
                    : idOnly
                      ? { ja: '«外部»', en: '«external»' }
                      : { ja: '«境界づけられたコンテキスト»', en: '«bounded context»' },
            ),
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
            kind: g.types > 0 || g.events > 0 ? 'dependsOn' : 'references',
            source: contextNodeId(g.from),
            target: contextNodeId(g.to),
            label: dependencyCounts(g.ids, g.types, g.events),
        }));
    return { id: opts.all ? CONTEXT_MAP_ALL_GRAPH_ID : CONTEXT_MAP_GRAPH_ID, nodes, edges };
}
