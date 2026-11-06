/**
 * An Event Storming view as a Graph IR (ADR 0024, T7): the render graph of one view (`projectView`) drawn with the
 * existing layout and Live View. In a timeline's view every render node becomes one graph node, keeping its path-derived
 * ID, and every render edge one graph edge. The integrated view merges the render nodes of each event into one note.
 */
import { named } from '../graph/build.js';
import { mapTexts, perLang, type EdgeKind, type Graph, type GraphEdge, type GraphNode, type NodeKind, type Texts } from '../graph/ir.js';
import { esElementId, firstDeclarations, STICKY_NOTE, type AnyDeclaration, type NodeElementKind, type Storming } from '@domaintrail/storming';
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
/** What a gap's empty slot asks. */
const GAP_LABELS: Record<'by' | 'handledBy', Texts> = {
    by: perLang({ ja: '誰が発行する？', en: 'Who issues it?' }),
    handledBy: perLang({ ja: '誰が処理する？', en: 'Who handles it?' }),
};

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
    /** Design Level: the time order is laid out but drawn only where the placement cannot show it. */
    const design = render.options.level === 'design-level';
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
        if (n.type === 'gap') {
            // the empty slot of an undecided issuer or handler: a dashed note asking it, the hotspot's when selected
            return {
                id: n.id,
                kind: 'esGap',
                label: GAP_LABELS[n.missing],
                stereotype: stereotype('未決定', 'undecided'),
                lines: [],
                elementId: esElementId(storming.id, n.hotspotId),
                ...(render.grid ? {} : { attachTo: `n:${n.use}` }),
                width: STICKY_NOTE.side,
                height: STICKY_NOTE.side,
            };
        }
        const [elementId, kind] = n.type === 'event' ? [n.eventId, 'event' as const] : [n.elementId, n.kind];
        const commands = n.type === 'element' && n.commands ? [...new Set(n.commands.map((c) => esElementId(storming.id, c.split('#')[0]!)))] : undefined;
        const parent = parentOf.get(n.id);
        const settled = kind === 'hotspot' ? resolution(declared.get(elementId)) : undefined;
        // every note is the same square, whatever its label: the canvas shrinks the label to fit it (`STICKY_NOTE`)
        return {
            id: n.id,
            kind: NODE_KINDS[kind],
            label: label(elementId),
            stereotype: STEREOTYPES[kind],
            lines: [],
            elementId: esElementId(storming.id, elementId),
            ...(parent !== undefined ? { parent } : {}),
            ...(commands && { commands }),
            ...(settled !== undefined && { status: 'resolved' as const, resolution: settled }),
            width: STICKY_NOTE.side,
            height: STICKY_NOTE.side,
        };
    };
    /** The commands an `emits` from a merged handler stands for, on hover. */
    const tooltip = (e: RenderEdge): { tooltip?: Texts } => {
        if (e.type !== 'semantic' || !e.merged) return {};
        const texts = e.merged.map((key) => label(key.slice(key.indexOf(':') + 1, key.indexOf('->'))));
        return {
            tooltip: mapTexts(texts[0]!, (_, lang, mode) => `${lang === 'ja' ? 'コマンド: ' : 'Commands: '}${texts.map((t) => t[lang][mode]).join(' / ')}`),
        };
    };
    const timelinesOf = (ids: readonly string[]): Texts => {
        const texts = ids.map(label);
        return mapTexts(texts[0], (_, lang, mode) => texts.map((t) => t[lang][mode]).join(' / '));
    };
    if (render.grid) {
        // a view of stages: every render node is drawn, in its cell; the edge into an exception's lane names it
        const { cells, frames, looseRow, captions } = render.grid;
        // at Design Level the grid's columns show the time order: only a lane's branch and a `then` are drawn
        const quiet = (e: RenderEdge): boolean => design && ((e.type === 'sequence' && !captions[e.id]) || e.type === 'stage');
        const edge = (e: RenderEdge): GraphEdge => ({
            id: e.id,
            kind: edgeKind(e),
            source: e.source,
            target: e.target,
            ...(captions[e.id] && { label: timelinesOf(captions[e.id]) }),
            ...tooltip(e),
            ...(quiet(e) && { hidden: true as const }),
        });
        return {
            id: stormingGraphId(storming.id, render.options),
            nodes: render.nodes.map(node),
            edges: render.edges.map(edge),
            grid: { cells, frames, ...(looseRow !== undefined && { looseRow }) },
        };
    }
    if (render.options.timelineId !== undefined) {
        const edge = (e: RenderEdge): GraphEdge => ({
            id: e.id,
            kind: edgeKind(e),
            source: e.source,
            target: e.target,
            ...tooltip(e),
            ...(design && e.type === 'sequence' && { hidden: true as const }),
        });
        return attach({ id: stormingGraphId(storming.id, render.options), nodes: render.nodes.map(node), edges: render.edges.map(edge) });
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
                    edges.set(id, { id, kind: edgeKind(e), source, target, ...tooltip(e) });
                }
            }
        }
    }
    for (const [id, s] of sequences) {
        const ids = [...s.timelineIds].sort();
        edges.set(id, {
            id,
            kind: 'esSequence',
            source: s.source,
            target: s.target,
            ...(ids.length < every.size ? { label: timelinesOf(ids) } : {}),
            ...(design && { hidden: true as const }),
        });
    }
    return attach({ id: stormingGraphId(storming.id, render.options), nodes: [...nodes.values()], edges: [...edges.values()] });
}

/**
 * The notes stuck on another one in a layered layout (`GraphNode.attachTo`; the grid places them in its cells itself): a
 * hotspot on the one sticky it is `on`, an actor or external system on the command it issues (its copy beside it, when
 * no read model leads to it). Only a note whose every edge joins it to that node, in the same container, is stuck on it.
 */
function attach(graph: Graph): Graph {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const nodes = graph.nodes.map((n): GraphNode => {
        if (n.kind !== 'esHotspot' && n.kind !== 'esActor' && n.kind !== 'esExternal') return n;
        const own = graph.edges.filter((e) => e.source === n.id || e.target === n.id);
        const others = new Set(own.map((e) => (e.source === n.id ? e.target : e.source)));
        if (others.size !== 1) return n;
        const anchor = byId.get([...others][0]!);
        const fits = n.kind === 'esHotspot' ? anchor !== undefined && anchor.kind !== 'esHotspot' : anchor?.kind === 'esCommand' || anchor?.kind === 'esPolicy';
        return anchor && fits && anchor.parent === n.parent ? { ...n, attachTo: anchor.id } : n;
    });
    return { ...graph, nodes };
}

/** What a resolved hotspot's team agreed (§3.5; empty when its `resolution` is missing); none while it is open. */
function resolution(declaration: AnyDeclaration | undefined): string | undefined {
    if (declaration?.kind !== 'hotspot' || declaration.clauses.find((c) => c.type === 'status')?.value !== 'resolved') return undefined;
    return declaration.clauses.find((c) => c.type === 'resolution')?.text ?? '';
}

/**
 * §9.4: causal edges solid and directed, the time order dashed, other relations dotted: an event feeding a read model
 * with an arrowhead, an issuer's and a read model's relation to a command (`by`, `reads`) and a hotspot's `on` without.
 */
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
                : e.kind === 'readmodel-from'
                  ? 'esFeeds'
                  : 'esRelated';
