/**
 * An Event Storming view as a Graph IR (ADR 0024, T7): the render graph of one view (`projectView`) drawn with the
 * existing layout and Live View. In a timeline's view every render node becomes one graph node, keeping its path-derived
 * ID, and every render edge one graph edge. The integrated view merges the render nodes of each event into one note.
 */
import { named, sized } from '../graph/build.js';
import { mapTexts, maxUnits, perLang, type EdgeKind, type Graph, type GraphEdge, type GraphNode, type NodeKind, type Texts } from '../graph/ir.js';
import { esElementId, type NodeElementKind, type Storming } from '../../../dtes/ir.js';
import { isCausal, type RenderEdge, type RenderGraph, type RenderNode, type ViewOptions } from './ir.js';
import { firstDeclarations } from './semantic.js';

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
/** A note is a square at least this wide: its label wraps, and a label too long for it makes it larger. */
const NOTE_SIDE = 150;
/** Of a note: the horizontal padding, the height of its stereotype and vertical padding, and of one line of its label. */
const NOTE_PADDING_X = 28;
const NOTE_CHROME_HEIGHT = 40;
const NOTE_LINE_HEIGHT = 24;

/** The side of a note whose wrapped label fits in it (lines wrap short of the full width, hence the margin). */
function noteSide(label: Texts): number {
    const width = maxUnits(label) * LABEL_CHAR_WIDTH * 1.15;
    let side = NOTE_SIDE;
    while (NOTE_CHROME_HEIGHT + Math.ceil(width / (side - NOTE_PADDING_X)) * NOTE_LINE_HEIGHT > side) side += 10;
    return side;
}

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
        const side = noteSide(note.label);
        return { ...note, width: side, height: side };
    };
    const timelinesOf = (ids: readonly string[]): Texts => {
        const texts = ids.map(label);
        return mapTexts(texts[0], (_, lang, mode) => texts.map((t) => t[lang][mode]).join(' / '));
    };
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
                } else {
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
    e.type === 'sequence' ? 'esSequence' : isCausal(e.kind) ? 'esCausal' : e.kind === 'hotspot-on' ? 'esHotspot' : 'esRelated';
