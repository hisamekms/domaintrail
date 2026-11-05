/**
 * The render graph of one view of a storming (spec §6, §7.3, §9.2, §9.3): the prefix trie of its timelines, the events
 * of none, and the other elements of the level with their semantic edges. Sharing an event node between occurrences is
 * a drawing optimization only: every render edge is either the drawing of a semantic edge or a timeline `sequence` edge.
 *
 * At Big Picture, the events marked `level design` are left out as if their timeline steps were not written: the trie is
 * built over the visible steps only, so the order edges join the neighbours of a hidden event, a group of hidden events
 * only disappears, and timelines that differ only in hidden events share their prefix (§8 on the visible sequence).
 * Hotspots stay, without their `on` edge to a hidden event; a hotspot on a sticky of Design Level (a command, …) does not.
 */
import {
    buildSemanticGraph,
    isDesignLevelOnly,
    type NodeElement,
    type NodeElementKind,
    type SemanticEdge,
    type Storming,
    stormingTimelines,
    timelineOccurrences,
} from '@domaintrail/storming';
import { LEVEL_KINDS, type RenderEdge, type RenderEventNode, type RenderGraph, type RenderNode, type ViewOptions } from './ir.js';
import { buildTrie, compare, memberId, type TrieNode } from './trie.js';
import { filterEdges } from './filter.js';
import { hasStages, projectStageView } from './stage-view.js';
import { drawChains, hotspotsOnDesignLevel, type EventPlace } from './chains.js';

export function projectView(storming: Storming, options: ViewOptions): RenderGraph {
    // a storming with stages: its integrated canvas and its stages are views of stages (a timeline's view is as ever)
    if (options.stageId !== undefined || (options.timelineId === undefined && hasStages(storming))) return projectStageView(storming, options);
    const semantic = buildSemanticGraph(storming);
    const kinds = new Map<string, NodeElementKind>(semantic.nodes.map((n) => [n.id, n.kind]));
    const hidden = new Set(options.level === 'big-picture' ? semantic.nodes.filter(isDesignLevelOnly).map((n) => n.id) : []);
    const timelines = stormingTimelines(storming);
    const trie = buildTrie(timelines, (id) => kinds.get(id) === 'event' && !hidden.has(id));
    const timelineId = options.timelineId !== undefined && trie.paths.has(options.timelineId) ? options.timelineId : undefined;
    const shown = new Set(LEVEL_KINDS[options.level]);

    const nodes = new Map<string, RenderNode>();
    const edges = new Map<string, RenderEdge>();
    /** The render nodes of each event in this view. */
    const eventNodes = new Map<string, string[]>();
    /**
     * Where each event note stands, for the copies of the elements drawn along the grammar (`chains.ts`): a timeline's
     * view at its step (its place on the path), the integrated canvas, which draws each event as one note, at one slot.
     */
    const places: EventPlace[] = [];
    const addEvent = (node: RenderEventNode, slot: string = '', position: number = 0): void => {
        nodes.set(node.id, node);
        eventNodes.set(node.eventId, [...(eventNodes.get(node.eventId) ?? []), node.id]);
        places.push({ id: node.id, eventId: node.eventId, slot: timelineId === undefined ? '' : slot, position });
    };
    const addStep = (node: TrieNode, position: number = 0): void => {
        const occurrencesOf = (eventId: string) => (node.occurrences.get(eventId) ?? []).filter((o) => timelineId === undefined || o.timelineId === timelineId);
        if (node.step.type === 'event') {
            addEvent({ type: 'event', id: node.id, eventId: node.step.eventId, occurrences: occurrencesOf(node.step.eventId) }, node.id, position);
            return;
        }
        for (const eventId of node.step.eventIds)
            addEvent({ type: 'event', id: memberId(node, eventId), eventId, occurrences: occurrencesOf(eventId) }, node.id, position);
        nodes.set(node.id, {
            type: 'group',
            id: node.id,
            members: node.step.eventIds.map((eventId) => memberId(node, eventId)),
            groups: node.groups.filter((g) => timelineId === undefined || g.timelineId === timelineId),
        });
    };
    const addSequence = (id: string, path: readonly TrieNode[]): void => {
        for (let i = 1; i < path.length; i++) {
            const [source, target] = [path[i - 1].id, path[i].id];
            const edgeId = `s:${source}->${target}`;
            const edge = edges.get(edgeId);
            if (edge?.type === 'sequence') edge.timelineIds.push(id);
            else edges.set(edgeId, { type: 'sequence', id: edgeId, source, target, timelineIds: [id] });
        }
    };

    let drawn: SemanticEdge[];
    if (timelineId === undefined) {
        for (const node of trie.nodes) addStep(node);
        for (const [id, path] of trie.paths) addSequence(id, path);
        // R15: the events of no timeline
        for (const n of semantic.nodes)
            if (n.kind === 'event' && !eventNodes.has(n.id) && !hidden.has(n.id)) addEvent({ type: 'event', id: `e:${n.id}`, eventId: n.id, occurrences: [] });
        drawn = semantic.edges;
    } else {
        const path = trie.paths.get(timelineId) ?? [];
        path.forEach((node, i) => addStep(node, i));
        addSequence(timelineId, path);
        // the timeline's events, hidden ones included: a hotspot on one is still shown (its edge has nothing to end at)
        const events = timelineOccurrences(timelines.find((t) => t.id === timelineId)!).map((o) => o.eventId);
        drawn = filterEdges(semantic.edges, new Set(events.filter((id) => kinds.get(id) === 'event')));
    }

    // at Big Picture, a hotspot on a sticky of Design Level goes with it
    const designOnly = options.level === 'big-picture' ? hotspotsOnDesignLevel(semantic.edges, kinds) : new Set<string>();
    const elements = semantic.nodes.filter(
        (n): n is NodeElement & { kind: Exclude<NodeElementKind, 'event'> } =>
            n.kind !== 'event' &&
            shown.has(n.kind) &&
            !designOnly.has(n.id) &&
            (timelineId === undefined || drawn.some((e) => e.sourceId === n.id || e.targetId === n.id)),
    );
    // the Design Level along the grammar: copies per use (and, in a timeline's view, per step), the handler deciding
    const chains = drawChains(elements, drawn, places);
    for (const n of chains.nodes) nodes.set(n.id, n);
    for (const e of chains.edges) edges.set(e.id, e);
    for (const edge of edges.values()) if (edge.type === 'sequence') edge.timelineIds.sort(compare);

    return {
        stormingId: storming.id,
        options: timelineId === undefined ? { level: options.level } : { level: options.level, timelineId },
        nodes: [...nodes.values()].sort((a, b) => compare(a.id, b.id)),
        edges: [...edges.values()].sort((a, b) => compare(a.id, b.id)),
    };
}

/**
 * Pairs the nodes of two render graphs of one view across an edit (spec §10.3): next ID → previous ID, for layout
 * hints. Equal IDs pair. Otherwise an event node pairs with a node of the same event that shares the most timelines and
 * neighbouring steps, when each is the other's only best match; a group node likewise among the groups of the same
 * events. An event with one unpaired node on each side pairs them. Ambiguous nodes stay unpaired, to be placed anew (R08).
 */
export function matchRenderNodes(previous: RenderGraph, next: RenderGraph): Map<string, string> {
    const pairs = new Map<string, string>();
    const previousById = new Map(previous.nodes.map((n) => [n.id, n]));
    for (const n of next.nodes) if (previousById.get(n.id)?.type === n.type) pairs.set(n.id, n.id);
    const paired = new Set(pairs.values());

    const prev = describe(previous);
    const curr = describe(next);
    for (const type of ['event', 'group'] as const) {
        const before = previous.nodes.filter((n) => n.type === type && !paired.has(n.id));
        const after = next.nodes.filter((n) => n.type === type && !pairs.has(n.id));
        const bestBefore = new Map<string, Best>();
        const bestAfter = new Map<string, Best>();
        for (const a of after) {
            for (const b of before) {
                const [x, y] = [curr.get(a.id), prev.get(b.id)];
                if (!x || !y || x.what !== y.what) continue;
                const score = overlap(x.timelines, y.timelines) + overlap(x.before, y.before) + overlap(x.after, y.after);
                if (score === 0) continue;
                offer(bestBefore, a.id, b.id, score);
                offer(bestAfter, b.id, a.id, score);
            }
        }
        for (const a of after) {
            const b = bestBefore.get(a.id);
            const back = b && bestAfter.get(b.id);
            if (b?.unique && back?.unique && back.id === a.id) {
                pairs.set(a.id, b.id);
                paired.add(b.id);
            }
        }
        // the one node left of the same event (or the same group of events) on each side
        const left = (nodes: RenderNode[], done: (id: string) => boolean, info: Map<string, NodeInfo>) => {
            const byWhat = new Map<string, RenderNode[]>();
            for (const n of nodes) {
                const what = info.get(n.id)?.what;
                if (what !== undefined && !done(n.id)) byWhat.set(what, [...(byWhat.get(what) ?? []), n]);
            }
            return byWhat;
        };
        const lefts = left(before, (id) => paired.has(id), prev);
        for (const [what, list] of left(after, (id) => pairs.has(id), curr)) {
            const others = lefts.get(what);
            if (list.length === 1 && others?.length === 1) {
                pairs.set(list[0].id, others[0].id);
                paired.add(others[0].id);
            }
        }
    }
    return pairs;
}

/** The best-scoring counterpart of a node so far, and whether no other one scores as much. */
interface Best {
    id: string;
    score: number;
    unique: boolean;
}

function offer(best: Map<string, Best>, id: string, other: string, score: number): void {
    const b = best.get(id);
    if (!b || score > b.score) best.set(id, { id: other, score, unique: true });
    else if (score === b.score) b.unique = false;
}

interface NodeInfo {
    /** The step key of the node itself: what must be equal for two nodes to pair. */
    what: string;
    timelines: string[];
    /** The step keys before and after it in its timelines (a group member's are its group's). */
    before: string[];
    after: string[];
}

function describe(graph: RenderGraph): Map<string, NodeInfo> {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const keyOf = (id: string): string => {
        const n = byId.get(id);
        return n?.type === 'event' ? `e:${n.eventId}` : n?.type === 'group' ? `g:${n.members.map((m) => keyOf(m).slice(2)).join(',')}` : id;
    };
    const sequences = graph.edges.filter((e) => e.type === 'sequence');
    const neighbours = (id: string) => ({
        before: sequences.filter((e) => e.target === id).map((e) => keyOf(e.source)),
        after: sequences.filter((e) => e.source === id).map((e) => keyOf(e.target)),
    });
    const groupOf = new Map(graph.nodes.flatMap((n) => (n.type === 'group' ? n.members.map((m) => [m, n.id] as const) : [])));
    const info = new Map<string, NodeInfo>();
    for (const n of graph.nodes) {
        if (n.type === 'event')
            info.set(n.id, { what: keyOf(n.id), timelines: [...new Set(n.occurrences.map((o) => o.timelineId))], ...neighbours(groupOf.get(n.id) ?? n.id) });
        else if (n.type === 'group') info.set(n.id, { what: keyOf(n.id), timelines: [...new Set(n.groups.map((g) => g.timelineId))], ...neighbours(n.id) });
    }
    return info;
}

const overlap = (a: readonly string[], b: readonly string[]): number => a.filter((x) => b.includes(x)).length;
