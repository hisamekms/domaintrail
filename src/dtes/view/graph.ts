/**
 * An Event Storming view as a Graph IR (ADR 0024, T7): the render graph of one view (`projectView`) drawn with the
 * existing layout and Live View. Every render node becomes one graph node, keeping its path-derived ID, and every render
 * edge one graph edge; nothing is added or merged, so the drawing stays the render graph's.
 */
import { named, sized } from '../../graph/build.js';
import { mapTexts, maxUnits, perLang, type EdgeKind, type Graph, type GraphEdge, type GraphNode, type NodeKind, type Texts } from '../../graph/ir.js';
import { esElementId, isCausal, type NodeElementKind, type RenderEdge, type RenderGraph, type RenderNode, type Storming, type ViewOptions } from '../ir.js';
import { firstDeclarations } from '../project/semantic.js';

/** Graph ID of a view: `storming:<StormingId>:<level>:<timelineId or *>` (the `storming` prefix lays it out left to right). */
export const stormingGraphId = (stormingId: string, options: ViewOptions): string => `storming:${stormingId}:${options.level}:${options.timelineId ?? '*'}`;

/** The key of a view among a storming's views in the Live View's payload. */
export const stormingViewKey = (options: ViewOptions): string => `${options.level}|${options.timelineId ?? ''}`;

const NODE_KINDS: Record<NodeElementKind, NodeKind> = {
    event: 'esEvent',
    command: 'esCommand',
    policy: 'esPolicy',
    actor: 'esActor',
    external: 'esExternal',
    aggregate: 'esAggregate',
    readmodel: 'esReadModel',
    hotspot: 'esHotspot',
};

/** Width of one ASCII character of a node's label (17px bold sans-serif). */
const LABEL_CHAR_WIDTH = 10.5;

const stereotype = (ja: string, en: string): Texts => perLang({ ja: `«${ja}»`, en: `«${en}»` });
const STEREOTYPES: Record<NodeElementKind, Texts> = {
    event: stereotype('イベント', 'event'),
    command: stereotype('コマンド', 'command'),
    policy: stereotype('ポリシー', 'policy'),
    actor: stereotype('アクター', 'actor'),
    external: stereotype('外部システム', 'external system'),
    aggregate: stereotype('集約', 'aggregate'),
    readmodel: stereotype('リードモデル', 'read model'),
    hotspot: stereotype('ホットスポット', 'hotspot'),
};

export function renderToGraph(render: RenderGraph, storming: Storming): Graph {
    const declared = firstDeclarations(storming);
    const label = (id: string): Texts => named(id, declared.get(id)?.label);
    const parentOf = new Map(render.nodes.flatMap((n) => (n.type === 'group' ? n.members.map((m) => [m, n.id] as const) : [])));

    const node = (n: RenderNode): GraphNode => {
        if (n.type === 'group') {
            // the groups a shared step stands for may have other IDs and labels in each timeline
            const ids = [...new Set(n.groups.map((g) => g.groupId))];
            const texts = ids.map(label);
            return {
                id: n.id,
                kind: 'esGroup',
                label: mapTexts(texts[0], (_, lang, mode) => [...new Set(texts.map((t) => t[lang][mode]))].join(' / ')),
                lines: [],
                elementId: esElementId(storming.id, ids[0]),
                width: 0,
                height: 0,
            };
        }
        const [elementId, kind] = n.type === 'event' ? [n.eventId, 'event' as const] : [n.elementId, n.kind];
        const parent = parentOf.get(n.id);
        const note = sized({
            id: n.id,
            kind: NODE_KINDS[kind],
            label: label(elementId),
            stereotype: STEREOTYPES[kind],
            lines: [],
            elementId: esElementId(storming.id, elementId),
            ...(parent !== undefined ? { parent } : {}),
        });
        // a note's label is on one line, in the bold text of the label (wider than the body rows `sized` measures)
        return { ...note, width: Math.max(note.width, Math.ceil(maxUnits(note.label) * LABEL_CHAR_WIDTH + 28)) };
    };
    const edge = (e: RenderEdge): GraphEdge => ({ id: e.id, kind: edgeKind(e), source: e.source, target: e.target });

    return { id: stormingGraphId(storming.id, render.options), nodes: render.nodes.map(node), edges: render.edges.map(edge) };
}

/** §9.4: causal edges solid and directed, the time order dashed, other relations dotted. */
const edgeKind = (e: RenderEdge): EdgeKind => (e.type === 'sequence' ? 'esSequence' : isCausal(e.kind) ? 'esCausal' : 'esRelated');
