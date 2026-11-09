/**
 * An Event Storming view as a Graph IR (ADR 0024, T7): the render graph of one view (`projectView`) drawn with the
 * existing layout and Live View. In a timeline's view every render node becomes one graph node, keeping its path-derived
 * ID, and every render edge one graph edge. The integrated view merges the render nodes of each event into one note.
 */
import { named } from '../graph/build.js';
import {
    mapTexts,
    perLang,
    type EdgeKind,
    type EdgeRelation,
    type Graph,
    type GraphEdge,
    type GraphNode,
    type LineRelation,
    type NodeKind,
    type Texts,
} from '../graph/ir.js';
import { esElementId, firstDeclarations, STICKY_NOTE, type AnyDeclaration, type NodeElementKind, type Storming } from '@domaintrail/storming';
import { isCausal, type RenderEdge, type RenderGraph, type RenderNode, type ViewOptions } from './ir.js';

/**
 * What a view is of: a timeline's ID, `@<stage ID>` for a stage, nothing for the integrated canvas; `-<kind>` after it
 * for each kind it is laid out without (`ViewOptions.hidden`: `-exceptions`).
 */
const scopeOf = (options: ViewOptions): string =>
    (options.timelineId ?? (options.stageId !== undefined ? `@${options.stageId}` : '')) + (options.hidden ?? []).map((k) => `-${k}`).join('');

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
    handledBy: perLang({ ja: '何が処理する？', en: 'What handles it?' }),
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
    const byRender = new Map(render.nodes.map((n) => [n.id, n]));
    const commandOfKey = (key: string): string => key.slice(key.indexOf(':') + 1, key.indexOf('->'));
    /** The timelines of a view of one timeline (its time order names it), or none. */
    const viewTimeline = render.options.timelineId;
    /** Every timeline whose time order the view draws: an order in all of them names none. */
    const everyTimeline = new Set(render.edges.flatMap((e) => (e.type === 'sequence' ? e.timelineIds : [])));
    /**
     * What a line means (ADR 0032): its relation, which the Live View says in plain words with the labels of its two
     * ends, e.g. 「「配車を組む」を「配車組」が受けて処理する」.
     */
    const explain = (e: RenderEdge, captions: Record<string, string[]> = {}): { relation?: EdgeRelation } => {
        const kindOfNode = (id: string): string | undefined => {
            const n = byRender.get(id);
            return n?.type === 'element' ? n.kind : n?.type;
        };
        const relation = (kind: LineRelation, names?: readonly string[]): { relation: EdgeRelation } => ({
            relation: { kind, ...(names?.length && { names: names.map(label) }) },
        });
        if (e.type === 'rejoin') return relation('returns', e.timelineIds);
        if (e.type === 'stage') return relation('order');
        if (e.type === 'sequence') {
            const lane = captions[e.id];
            if (lane?.length) return relation(e.exception ? 'branches' : 'order', lane);
            const named = viewTimeline !== undefined || e.timelineIds.length < everyTimeline.size;
            return relation('order', named ? e.timelineIds : []);
        }
        switch (e.kind) {
            case 'by':
                return relation(kindOfNode(e.target) === 'policy' ? 'follows' : 'issues');
            case 'reads':
                return relation('looksAt');
            case 'handledBy':
                return relation('handles');
            case 'emits':
                if (kindOfNode(e.source) === 'command') return relation('results');
                return relation('decides', e.merged?.map(commandOfKey));
            case 'on':
                return relation('triggers');
            case 'command-on':
                return relation('notices');
            case 'issues':
                return relation('policyIssues');
            case 'readmodel-from':
                return relation('updates');
            case 'event-from':
                return relation('arrives');
            case 'hotspot-on':
                return relation('question');
        }
        return {};
    };
    /**
     * The line from an open hotspot's empty slot (`gap`) to its command: no time order, what is not decided yet. Not
     * drawn in a layered layout's block (the slot is stuck on its command there), but said the same.
     */
    const gapEdges = (): GraphEdge[] =>
        render.nodes.flatMap((n) =>
            n.type === 'gap'
                ? [
                      {
                          id: `gap:${n.id}`,
                          kind: 'esHotspot' as const,
                          source: n.id,
                          target: `n:${n.use}`,
                          relation: { kind: n.missing === 'by' ? ('undecidedIssuer' as const) : ('undecidedHandler' as const) },
                      },
                  ]
                : [],
        );
    const timelinesOf = (ids: readonly string[]): Texts => {
        const texts = ids.map(label);
        return mapTexts(texts[0], (_, lang, mode) => texts.map((t) => t[lang][mode]).join(' / '));
    };
    if (render.grid) {
        // a view of stages: every render node is drawn, in its cell; the edge into an exception's lane names it
        const { cells, frames, looseRow, captions } = render.grid;
        // at Design Level the grid's columns show the time order: only a lane's branch and a `then` are drawn, and the
        // branch only where no line of the design joins its two events already (ADR 0032 §15)
        const joined = design ? joinedByLines(render) : (): boolean => false;
        const quiet = (e: RenderEdge): boolean => design && ((e.type === 'sequence' && (!captions[e.id] || joined(e.source, e.target))) || e.type === 'stage');
        const edge = (e: RenderEdge): GraphEdge => ({
            id: e.id,
            kind: edgeKind(e),
            source: e.source,
            target: e.target,
            ...(captions[e.id] && { label: timelinesOf(captions[e.id]) }),
            ...explain(e, captions),
            ...(quiet(e) && { hidden: true as const }),
            // a lane's branch not drawn still names its lane, where it is laid out
            ...(quiet(e) && captions[e.id] && { labelDrawn: true as const }),
        });
        return {
            id: stormingGraphId(storming.id, render.options),
            nodes: render.nodes.map(node),
            edges: [...render.edges.map(edge), ...gapEdges()],
            grid: { cells, frames, ...(looseRow !== undefined && { looseRow }) },
        };
    }
    if (render.options.timelineId !== undefined) {
        const edge = (e: RenderEdge): GraphEdge => ({
            id: e.id,
            kind: edgeKind(e),
            source: e.source,
            target: e.target,
            ...explain(e),
            ...(design && e.type === 'sequence' && { hidden: true as const }),
        });
        return attach({ id: stormingGraphId(storming.id, render.options), nodes: render.nodes.map(node), edges: [...render.edges.map(edge), ...gapEdges()] });
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
                    edges.set(id, { id, kind: edgeKind(e), source, target, ...explain(e) });
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
            relation: { kind: 'order', ...(ids.length < every.size && { names: ids.map(label) }) },
            ...(design && { hidden: true as const }),
        });
    }
    return attach({ id: stormingGraphId(storming.id, render.options), nodes: [...nodes.values()], edges: [...edges.values(), ...gapEdges()] });
}

/**
 * Whether the semantic lines of a view join one event note to another (ADR 0032 §15): a path along their direction,
 * over every kind but a hotspot's `on` (a question, not a step), through the notes of other elements only — never
 * another event, a hotspot or an open hotspot's empty slot. On the render nodes as drawn (a shared handler is one note).
 */
function joinedByLines(render: RenderGraph): (from: string, to: string) => boolean {
    const byId = new Map(render.nodes.map((n) => [n.id, n]));
    const next = new Map<string, string[]>();
    for (const e of render.edges) if (e.type === 'semantic' && e.kind !== 'hotspot-on') next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
    const through = (id: string): boolean => {
        const n = byId.get(id);
        return n?.type === 'element' && n.kind !== 'hotspot';
    };
    return (from, to) => {
        if (byId.get(from)?.type !== 'event' || byId.get(to)?.type !== 'event') return false;
        const seen = new Set([from]);
        const queue = [from];
        for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
            for (const n of next.get(at) ?? []) {
                if (n === to) return true;
                if (seen.has(n) || !through(n)) continue;
                seen.add(n);
                queue.push(n);
            }
        }
        return false;
    };
}

/**
 * The notes stuck on another one in a layered layout (`GraphNode.attachTo`; the grid places them in its cells itself): a
 * hotspot on the one sticky it is `on`, an actor or external system on the command it issues (its copy beside it, when
 * no read model and no event it reacts to leads to it). Only a note whose every edge joins it to that node, in the same container, is stuck on it.
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
