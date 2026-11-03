/**
 * An Event Storming view as a Graph IR (ADR 0024, T7): the render graph of one view (`projectView`) drawn with the
 * existing layout and Live View. In a timeline's view every render node becomes one graph node, keeping its path-derived
 * ID, and every render edge one graph edge. The integrated view merges the render nodes of each event into one note.
 */
import { named } from '../graph/build.js';
import { mapTexts, perLang, type EdgeKind, type Graph, type GraphEdge, type GraphNode, type NodeKind, type Texts } from '../graph/ir.js';
import { esElementId, firstDeclarations, STICKY_NOTE, type NodeElementKind, type Storming } from '@domaintrail/storming';
import { isCausal, type RenderEdge, type RenderGraph, type RenderNode, type ViewOptions } from './ir.js';

/**
 * What a view is of: a timeline's ID, `@<stage ID>` for a stage, nothing for the integrated canvas; `-exceptions` after
 * it without the exceptions.
 */
const scopeOf = (options: ViewOptions): string =>
    (options.timelineId ?? (options.stageId !== undefined ? `@${options.stageId}` : '')) + (options.hideExceptions ? '-exceptions' : '');

/**
 * Graph ID of a view: `storming:<StormingId>:<level>:<timelineId, @stageId or *>` (the `storming` prefix lays it out left
 * to right).
 */
export const stormingGraphId = (stormingId: string, options: ViewOptions): string => `storming:${stormingId}:${options.level}:${scopeOf(options) || '*'}`;

/** The key of a view among a storming's views in the Live View's payload: `<level>|<timelineId, @stageId or empty>`. */
export const stormingViewKey = (options: ViewOptions): string => `${options.level}|${scopeOf(options)}`;

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
        if (n.type === 'stage') {
            // sized by the layout around its cells
            return { id: n.id, kind: 'esStage', label: label(n.stageId), lines: [], elementId: esElementId(storming.id, n.stageId), width: 0, height: 0 };
        }
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
        // every note is the same square, whatever its label: the canvas shrinks the label to fit it (`STICKY_NOTE`)
        return {
            id: n.id,
            kind: NODE_KINDS[kind],
            label: label(elementId),
            stereotype: STEREOTYPES[kind],
            lines: [],
            elementId: esElementId(storming.id, elementId),
            ...(parent !== undefined ? { parent } : {}),
            width: STICKY_NOTE.side,
            height: STICKY_NOTE.side,
        };
    };
    const timelinesOf = (ids: readonly string[]): Texts => {
        const texts = ids.map(label);
        return mapTexts(texts[0], (_, lang, mode) => texts.map((t) => t[lang][mode]).join(' / '));
    };
    if (render.grid) {
        // a view of stages: every render node is drawn, in its cell; the edge into an exception's lane names it
        const { cells, frames, looseRow, captions } = render.grid;
        const edge = (e: RenderEdge): GraphEdge => ({
            id: e.id,
            kind: edgeKind(e),
            source: e.source,
            target: e.target,
            ...(captions[e.id] && { label: timelinesOf(captions[e.id]) }),
        });
        return {
            id: stormingGraphId(storming.id, render.options),
            nodes: render.nodes.map(node),
            edges: render.edges.map(edge),
            grid: { cells, frames, ...(looseRow !== undefined && { looseRow }) },
        };
    }
    if (render.options.timelineId !== undefined) {
        const edge = (e: RenderEdge): GraphEdge => ({ id: e.id, kind: edgeKind(e), source: e.source, target: e.target });
        return { id: stormingGraphId(storming.id, render.options), nodes: render.nodes.map(node), edges: render.edges.map(edge) };
    }

    // The integrated view draws each event once, without the groups: a step shared or not, an event is one note, and the
    // time order between two events is one edge naming the timelines it is in (none when it is in every timeline).
    const eventOf = new Map(render.nodes.flatMap((n) => (n.type === 'event' ? [[n.id, `e:${n.eventId}`] as const] : [])));
    const membersOf = new Map(render.nodes.flatMap((n) => (n.type === 'group' ? [[n.id, n.members] as const] : [])));
    const ends = (id: string): string[] => (membersOf.get(id) ?? [id]).map((m) => eventOf.get(m) ?? m);
    const nodes = new Map<string, GraphNode>();
    for (const n of render.nodes) {
        if (n.type === 'group') continue;
        const id = eventOf.get(n.id) ?? n.id;
        if (!nodes.has(id)) {
            const { parent: _, ...note } = node(n);
            nodes.set(id, { ...note, id });
        }
    }
    const every = new Set(render.edges.flatMap((e) => (e.type === 'sequence' ? e.timelineIds : [])));
    const sequences = new Map<string, { source: string; target: string; timelineIds: Set<string> }>();
    const edges = new Map<string, GraphEdge>();
    for (const e of render.edges) {
        for (const source of ends(e.source)) {
            for (const target of ends(e.target)) {
                if (e.type === 'sequence') {
                    const id = `s:${source}->${target}`;
                    const s = sequences.get(id) ?? { source, target, timelineIds: new Set<string>() };
                    for (const t of e.timelineIds) s.timelineIds.add(t);
                    sequences.set(id, s);
                } else if (e.type === 'semantic') {
                    const id = `${e.semantic}@${source}->${target}`;
                    edges.set(id, { id, kind: edgeKind(e), source, target });
                }
            }
        }
    }
    for (const [id, s] of sequences) {
        const ids = [...s.timelineIds].sort();
        edges.set(id, { id, kind: 'esSequence', source: s.source, target: s.target, ...(ids.length < every.size ? { label: timelinesOf(ids) } : {}) });
    }
    return { id: stormingGraphId(storming.id, render.options), nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** §9.4: causal edges solid and directed, the time order dashed, other relations dotted; a hotspot's `on` has no direction. */
const edgeKind = (e: RenderEdge): EdgeKind =>
    e.type === 'rejoin'
        ? 'esRejoin'
        : e.type === 'sequence' && e.exception
          ? 'esException'
          : e.type !== 'semantic'
            ? 'esSequence'
            : isCausal(e.kind)
              ? 'esCausal'
              : e.kind === 'hotspot-on'
                ? 'esHotspot'
                : 'esRelated';
