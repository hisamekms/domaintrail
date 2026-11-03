/**
 * The views of a storming drawn in sections (spec §3.7, §6): one with stages or exceptions. Its integrated canvas shows
 * its sections in time order (its stages, or its top-level timelines when it has none), the view of a stage that stage
 * alone. Each section is a tree of its timelines' steps: its trunk (its first main flow) from its first step, and every
 * other timeline — a main flow or an exception — from the step it branches off from (its first step is that step,
 * shared as a prefix is, spec §8); timelines that go on alike share their steps too. A `then` is an edge back to the
 * step of a main flow; an `after`, an edge from the end of the previous stage's trunk to the start of this one's.
 *
 * Every node gets a cell (`StageGrid`): a column per step, strictly later to the right through every stage, the trunks
 * on row 0, every other timeline on a lane of its own below the step it branches off from (the other main flows above
 * the exceptions; lanes that do not overlap share a row), the other elements of the level above the event they belong
 * to (a copy of an actor, external system, read model or aggregate above the command it stands beside, `uses.ts`). As
 * in the other views, sharing a node is a drawing optimization only: every edge is a semantic edge's drawing, or
 * one of the time order (`sequence`, `rejoin`, `stage`).
 *
 * At Big Picture the events marked `level design` are left out as if their steps were not written; a timeline whose
 * branch point is hidden branches off from the nearest visible step before it (or starts the section), and a `then` to
 * a hidden step returns to the nearest visible step after it (or before it). Without the exceptions
 * (`hideExceptions`), the exceptions are not drawn, nor the events only they have, nor the hotspots on those events.
 */
import {
    branchPoints,
    buildSemanticGraph,
    drawnInSections,
    firstDeclarations,
    isDesignLevelOnly,
    type NodeElement,
    type NodeElementKind,
    orderStages,
    rejoinPoint,
    sections,
    semanticEdgeKey,
    stormingTimelines,
    type EventOccurrence,
    type Section,
    type SemanticEdge,
    type Storming,
    type Timeline,
    type TimelineStep,
    timelineOccurrences,
    trunk,
} from '@domaintrail/storming';
import {
    LEVEL_KINDS,
    stepKey,
    type GridCell,
    type RenderEdge,
    type RenderElementNode,
    type RenderGraph,
    type RenderNode,
    type StageGrid,
    type Step,
    type ViewOptions,
} from './ir.js';
import { filterEdges } from './filter.js';
import { compare, compareOccurrences } from './trie.js';
import { useEnds, useNodeId, usesOf } from './uses.js';

/** A step of a section's tree. */
interface StageNode {
    id: string;
    step: Step;
    parent?: StageNode;
    children: Map<string, StageNode>;
    /** The occurrences of each event of the step. */
    occurrences: Map<string, EventOccurrence[]>;
    groups: { timelineId: string; groupId: string }[];
    /** Column within the section (its depth from the section's start). */
    col: number;
    /** On the trunk. */
    trunk: boolean;
    row?: number;
}

/** A section's tree: its steps, the steps of each timeline (by source step index; none for a hidden one) and its `then`s. */
interface StageTree {
    section: Section;
    root: StageNode;
    nodes: StageNode[];
    /** The trunk's nodes, in order. */
    trunk: StageNode[];
    /** The node of each step of each timeline (none for a hidden step). */
    at: Map<string, (StageNode | undefined)[]>;
    /** The nodes of each timeline in order, from the step it branches off from (the trunk's from its first). */
    paths: Map<string, StageNode[]>;
    /** The exceptions that return with `then`, and where to. */
    rejoins: { timeline: Timeline; eventId: string }[];
}

/** The render node ID of an event of a group step. */
const memberOf = (node: StageNode, eventId: string): string => `${node.id}/${eventId}`;

/** Whether a storming's integrated canvas is a view of sections (`drawnInSections`: it has stages or exceptions). */
export const hasStages = drawnInSections;

export function projectStageView(storming: Storming, options: ViewOptions): RenderGraph {
    const semantic = buildSemanticGraph(storming);
    const kinds = new Map<string, NodeElementKind>(semantic.nodes.map((n) => [n.id, n.kind]));
    const hidden = new Set(options.level === 'big-picture' ? semantic.nodes.filter(isDesignLevelOnly).map((n) => n.id) : []);
    const visible = (id: string): boolean => kinds.get(id) === 'event' && !hidden.has(id);
    const order = orderStages(storming);
    const one = options.stageId !== undefined ? order.stages.find((s) => s.id === options.stageId) : undefined;
    const shown = one ? [one] : sections(storming, order);
    const byId = firstDeclarations(storming);
    const isException = new Map(stormingTimelines(storming).map((t) => [t.id, !!t.exception]));
    const withoutExceptions = options.hideExceptions === true;
    // the events of exceptions only: not drawn without the exceptions
    const inMain = new Set(stormingTimelines(storming).flatMap((t) => (t.exception ? [] : timelineOccurrences(t).map((o) => o.eventId))));
    const exceptionOnly = new Set(
        withoutExceptions
            ? stormingTimelines(storming)
                  .flatMap((t) => (t.exception ? timelineOccurrences(t).map((o) => o.eventId) : []))
                  .filter((id) => !inMain.has(id))
            : [],
    );

    const owns = (t: Timeline): boolean => byId.get(t.id) === t && !(withoutExceptions && t.exception);
    const trees = shown.map((section) => stageTree(section, visible, owns));
    const nodes = new Map<string, RenderNode>();
    const edges = new Map<string, RenderEdge>();
    const cells: Record<string, GridCell> = {};
    const frames: StageGrid['frames'] = {};
    const captions: StageGrid['captions'] = {};
    /** The render nodes of each event in this view, with their columns. */
    const eventNodes = new Map<string, { id: string; col: number }[]>();
    const addEvent = (id: string, eventId: string, occurrences: EventOccurrence[], col: number): void => {
        nodes.set(id, { type: 'event', id, eventId, occurrences: [...occurrences].sort(compareOccurrences) });
        eventNodes.set(eventId, [...(eventNodes.get(eventId) ?? []), { id, col }]);
    };
    const addSequence = (type: 'sequence' | 'rejoin', source: string, target: string, timelineId: string): string => {
        const id = `${type === 'sequence' ? 's' : 'r'}:${source}->${target}`;
        const edge = edges.get(id);
        if (edge && edge.type === type) {
            if (!edge.timelineIds.includes(timelineId)) edge.timelineIds.push(timelineId);
        } else edges.set(id, { type, id, source, target, timelineIds: [timelineId] });
        return id;
    };

    // ---- the sections, left to right: their steps, lanes and time order ----
    let base = 0;
    let maxRow = 0;
    for (const tree of trees) {
        const width = Math.max(1, ...tree.nodes.map((n) => n.col + 1));
        if (tree.section.id !== '') {
            const stageNode = `st:${tree.section.id}`;
            nodes.set(stageNode, { type: 'stage', id: stageNode, stageId: tree.section.id });
            frames[stageNode] = { from: base, to: base + width - 1 };
        }
        assignRows(tree, (n) => [...n.occurrences.values()].flat().every((o) => isException.get(o.timelineId)));
        for (const node of tree.nodes) {
            const cell = { col: base + node.col, row: node.row! };
            maxRow = Math.max(maxRow, cell.row);
            cells[node.id] = cell;
            const occurrencesOf = (eventId: string): EventOccurrence[] => node.occurrences.get(eventId) ?? [];
            if (node.step.type === 'event') {
                addEvent(node.id, node.step.eventId, occurrencesOf(node.step.eventId), cell.col);
                continue;
            }
            for (const eventId of node.step.eventIds) addEvent(memberOf(node, eventId), eventId, occurrencesOf(eventId), cell.col);
            nodes.set(node.id, {
                type: 'group',
                id: node.id,
                members: node.step.eventIds.map((eventId) => memberOf(node, eventId)),
                groups: [...node.groups].sort((a, b) => compare(a.timelineId, b.timelineId) || compare(a.groupId, b.groupId)),
            });
        }
        for (const [timelineId, path] of tree.paths) {
            for (let i = 1; i < path.length; i++) {
                const id = addSequence('sequence', path[i - 1]!.id, path[i]!.id, timelineId);
                // the first step of a lane: its timelines caption the edge into it
                if (!path[i]!.trunk && path[i]!.row !== path[i - 1]!.row) captions[id] = [...new Set([...(captions[id] ?? []), timelineId])];
            }
        }
        base += width;
    }
    for (const list of Object.values(captions)) list.sort(compare);
    // the time order of exceptions only: drawn as an exception's
    for (const edge of edges.values()) if (edge.type === 'sequence' && edge.timelineIds.every((t) => isException.get(t))) edge.exception = true;

    // `after`: the end of the previous stage's trunk to the start of this one's
    const treeOf = new Map(trees.map((t) => [t.section.id, t]));
    for (const tree of trees) {
        const previous = order.previous.get(tree.section.id);
        const from = previous !== undefined ? treeOf.get(previous)?.trunk.at(-1) : undefined;
        const to = tree.trunk[0];
        if (!from || !to) continue;
        const id = `a:${from.id}->${to.id}`;
        edges.set(id, { type: 'stage', id, source: from.id, target: to.id, stageId: tree.section.id });
    }

    // `then`: the last step of an exception back to the step of a main flow (the nearest visible one)
    for (const tree of trees) {
        for (const { timeline, eventId } of tree.rejoins) {
            const point = rejoinPoint(storming, tree.section, eventId, order);
            const steps = point && treeOf.get(point.sectionId)?.at.get(point.timelineId);
            if (!point || !steps) continue;
            const node = steps.slice(point.step).find((n) => !!n) ?? steps.slice(0, point.step).findLast((n) => !!n);
            const source = tree.paths.get(timeline.id)?.at(-1);
            if (!node || !source) continue;
            const end = node.step.type === 'group' && node.step.eventIds.includes(eventId) ? memberOf(node, eventId) : node.id;
            addSequence('rejoin', source.id, end, timeline.id);
        }
    }

    // ---- the elements of the level, and their semantic edges ----
    const shownKinds = new Set(LEVEL_KINDS[options.level]);
    let drawn: SemanticEdge[] = semantic.edges;
    if (one) {
        const events = new Set(
            one.timelines
                .filter(owns)
                .flatMap((t) => timelineOccurrences(t).map((o) => o.eventId))
                .filter((id) => kinds.get(id) === 'event'),
        );
        drawn = filterEdges(semantic.edges, events);
    }
    // without the exceptions, a hotspot on an event only they have goes with them
    const gone = new Set(semantic.edges.filter((e) => e.kind === 'hotspot-on' && exceptionOnly.has(e.targetId)).map((e) => e.sourceId));
    drawn = drawn.filter((e) => !gone.has(e.sourceId) && !gone.has(e.targetId));
    const loose: string[] = [];
    // R15: the events of no section (of the integrated canvas only)
    if (!one) {
        for (const n of semantic.nodes) {
            if (n.kind !== 'event' || eventNodes.has(n.id) || hidden.has(n.id) || exceptionOnly.has(n.id)) continue;
            addEvent(`e:${n.id}`, n.id, [], -1);
            loose.push(`e:${n.id}`);
        }
    }
    const elements = semantic.nodes.filter(
        (n): n is NodeElement & { kind: Exclude<NodeElementKind, 'event'> } =>
            n.kind !== 'event' && shownKinds.has(n.kind) && !gone.has(n.id) && (!one || drawn.some((e) => e.sourceId === n.id || e.targetId === n.id)),
    );
    // an actor, external system, read model or aggregate beside each command that uses it; once when none does
    const commands = new Set(elements.filter((n) => n.kind === 'command').map((n) => n.id));
    const uses = usesOf(drawn, (id) => commands.has(id));
    const elementNodes: RenderElementNode[] = elements.flatMap((n): RenderElementNode[] => {
        const users = uses.get(n.id);
        if (!users) return [{ type: 'element', id: `n:${n.id}`, elementId: n.id, kind: n.kind }];
        return users.map((use) => ({ type: 'element', id: useNodeId(n.id, use), elementId: n.id, kind: n.kind, use }));
    });
    for (const n of elementNodes) nodes.set(n.id, n);

    // each element above the earliest note of the events it belongs to; a copy above its command
    /** The column of each element's render node. */
    const colOf = new Map<string, number>();
    const eventCol = (id: string): number | undefined => {
        const cols = (eventNodes.get(id) ?? []).map((n) => n.col).filter((c) => c >= 0);
        return cols.length ? Math.min(...cols) : undefined;
    };
    const place = (id: string, cols: (number | undefined)[]): void => {
        const known = cols.filter((c): c is number => c !== undefined);
        if (!colOf.has(id) && known.length) colOf.set(id, Math.min(...known));
    };
    /** The other ends of the `kind` edges of `id` (`end`: which end of the edge to take). */
    const related = (kind: SemanticEdge['kind'], end: 'sourceId' | 'targetId', id: string): string[] =>
        drawn.filter((e) => e.kind === kind && e[end === 'sourceId' ? 'targetId' : 'sourceId'] === id).map((e) => e[end]);
    const ofKind = (...ks: NodeElementKind[]): RenderElementNode[] => elementNodes.filter((n) => ks.includes(n.kind));
    for (const n of ofKind('hotspot')) place(n.id, related('hotspot-on', 'targetId', n.elementId).map(eventCol));
    for (const n of ofKind('policy')) place(n.id, related('on', 'sourceId', n.elementId).map(eventCol));
    for (const n of ofKind('command')) place(n.id, related('emits', 'targetId', n.elementId).map(eventCol));
    for (const n of ofKind('command'))
        place(
            n.id,
            related('issues', 'sourceId', n.elementId).map((p) => colOf.get(`n:${p}`)),
        );
    // a copy in its command's stack (an element no command uses has no column: it goes below the sections)
    for (const n of elementNodes) if (n.use !== undefined) place(n.id, [colOf.get(`n:${n.use}`)]);
    const stacks = new Map<number, RenderElementNode[]>();
    for (const n of elementNodes) {
        const col = colOf.get(n.id);
        if (col === undefined) {
            loose.push(n.id);
            continue;
        }
        stacks.set(col, [...(stacks.get(col) ?? []), n]);
    }
    const kindRank = (n: RenderElementNode): number => ELEMENT_ORDER.findIndex((k) => k === n.kind);
    for (const [col, stack] of stacks) {
        stack.sort((a, b) => kindRank(a) - kindRank(b) || compare(a.id, b.id));
        stack.forEach((n, i) => (cells[n.id] = { col, row: -1 - i }));
    }

    // the notes outside the sections, below them
    let looseRow: number | undefined;
    if (loose.length) {
        looseRow = maxRow + 1;
        const perRow = Math.max(base, 5);
        loose.sort(compare).forEach((id, i) => (cells[id] = { col: i % perRow, row: looseRow! + Math.floor(i / perRow) }));
    }

    const renderNodesOf = (id: string): string[] =>
        kinds.get(id) === 'event' ? (eventNodes.get(id) ?? []).map((n) => n.id) : nodes.has(`n:${id}`) ? [`n:${id}`] : [];
    const ends = (e: SemanticEdge, end: 'sourceId' | 'targetId'): string[] => useEnds(e, end, (id) => nodes.has(id), renderNodesOf);
    for (const e of drawn) {
        const key = semanticEdgeKey(e);
        for (const source of ends(e, 'sourceId')) {
            for (const target of ends(e, 'targetId')) {
                const id = `${key}@${source}->${target}`;
                edges.set(id, { type: 'semantic', id, kind: e.kind, source, target, semantic: key });
            }
        }
    }
    for (const edge of edges.values()) if (edge.type === 'sequence' || edge.type === 'rejoin') edge.timelineIds.sort(compare);

    return {
        stormingId: storming.id,
        options: {
            level: options.level,
            ...(one && { stageId: one.id }),
            ...(withoutExceptions && { hideExceptions: true as const }),
        },
        nodes: [...nodes.values()].sort((a, b) => compare(a.id, b.id)),
        edges: [...edges.values()].sort((a, b) => compare(a.id, b.id)),
        grid: { cells, frames, ...(looseRow !== undefined && { looseRow }), captions },
    };
}

/** The elements stacked above an event, nearest first. */
const ELEMENT_ORDER = ['hotspot', 'command', 'policy', 'aggregate', 'readmodel', 'actor', 'external'] as const;

/** The visible part of a step (a group keeps its visible events, sorted; none when nothing is visible). */
function visibleStep(
    s: TimelineStep,
    timelineId: string,
    index: number,
    visible: (id: string) => boolean,
): { step: Step; occurrences: EventOccurrence[] } | undefined {
    const occurrences = (
        s.type === 'event' ? [{ eventId: s.eventId, stepPath: [index] }] : s.events.map((e, j) => ({ eventId: e.eventId, stepPath: [index, j] }))
    )
        .filter((o) => visible(o.eventId))
        .map((o): EventOccurrence => ({ timelineId, ...o }));
    if (!occurrences.length) return undefined;
    const step: Step =
        s.type === 'event' ? { type: 'event', eventId: s.eventId } : { type: 'group', eventIds: [...new Set(occurrences.map((o) => o.eventId))].sort() };
    return { step, occurrences };
}

/** The tree of a section's timelines that `owns` (those that own their ID; without exceptions, its main flows). */
function stageTree(section: Section, visible: (id: string) => boolean, owns: (t: Timeline) => boolean): StageTree {
    const prefix = `s:${section.id}:`;
    const root: StageNode = { id: prefix, step: { type: 'event', eventId: '' }, children: new Map(), occurrences: new Map(), groups: [], col: -1, trunk: true };
    const nodes: StageNode[] = [];
    const paths = new Map<string, StageNode[]>();
    const at = new Map<string, (StageNode | undefined)[]>();
    const child = (parent: StageNode, step: Step, onTrunk: boolean): StageNode => {
        const key = stepKey(step);
        let node = parent.children.get(key);
        if (!node) {
            const id = parent === root ? `${prefix}${key}` : `${parent.id}>${key}`;
            node = { id, step, parent, children: new Map(), occurrences: new Map(), groups: [], col: parent.col + 1, trunk: onTrunk };
            parent.children.set(key, node);
            nodes.push(node);
        }
        return node;
    };
    const record = (node: StageNode, s: TimelineStep, timelineId: string, occurrences: EventOccurrence[]): void => {
        for (const o of occurrences) node.occurrences.set(o.eventId, [...(node.occurrences.get(o.eventId) ?? []), o]);
        if (s.type === 'group') node.groups.push({ timelineId, groupId: s.id });
    };
    /** Adds a timeline's steps from `from` on, after `start`; its node of each step (none for a hidden one). */
    const walk = (t: Timeline, start: StageNode, from: number, onTrunk: boolean, out: (StageNode | undefined)[], path: StageNode[]): void => {
        let cur = start;
        for (let i = from; i < t.steps.length; i++) {
            const v = visibleStep(t.steps[i]!, t.id, i, visible);
            if (!v) {
                out[i] = undefined;
                continue;
            }
            cur = child(cur, v.step, onTrunk);
            record(cur, t.steps[i]!, t.id, v.occurrences);
            out[i] = cur;
            path.push(cur);
        }
    };

    const timelines = section.timelines.filter(owns);
    const main = trunk(section);
    const rejoins: StageTree['rejoins'] = [];
    const trunkPath: StageNode[] = [];
    if (main && timelines.includes(main)) {
        const trunkAt: (StageNode | undefined)[] = [];
        walk(main, root, 0, true, trunkAt, trunkPath);
        at.set(main.id, trunkAt);
        paths.set(main.id, trunkPath);
    }
    const points = branchPoints(section);
    const pending = timelines.filter((t) => t !== main && t.steps.length > 0);
    // a timeline after the one it branches off from; the dangling ones at the section's start
    while (pending.length) {
        const i = pending.findIndex((t) => {
            const p = points.get(t.id);
            return !p || at.has(p.timelineId);
        });
        const t = pending.splice(i < 0 ? 0 : i, 1)[0]!;
        const point = points.get(t.id);
        const out: (StageNode | undefined)[] = [];
        const path: StageNode[] = [];
        const source = point && at.get(point.timelineId);
        if (!point || !source) {
            walk(t, root, 0, false, out, path);
        } else {
            const v = visibleStep(t.steps[0]!, t.id, 0, visible);
            const shared = v ? source[point.step] : undefined;
            if (shared && v) {
                record(shared, t.steps[0]!, t.id, v.occurrences);
                out[0] = shared;
            }
            // a hidden branch point: the nearest visible step before it, or the section's start
            const start = shared ?? source.slice(0, point.step).findLast((n) => !!n) ?? root;
            if (start !== root) path.push(start);
            walk(t, start, 1, false, out, path);
        }
        at.set(t.id, out);
        paths.set(t.id, path);
        if (t.exception && t.rejoin) rejoins.push({ timeline: t, eventId: t.rejoin.eventId });
    }
    return { section, root, nodes, trunk: trunkPath, at, paths, rejoins };
}

/**
 * The rows of a section's steps: the trunk on row 0, then each lane — a run of steps that goes on from the step it
 * branches off from — on the first row below that step's that it shares with no lane it overlaps (one column apart).
 * Lanes are taken from the top of the tree down; among the lanes off one lane, the main flows before the exceptions
 * (`exceptional`), then those branching earlier.
 */
function assignRows(tree: StageTree, exceptional: (n: StageNode) => boolean): void {
    const rows = new Map<number, [number, number][]>();
    const free = (row: number, from: number, to: number): boolean => (rows.get(row) ?? []).every(([a, b]) => to < a || from > b);
    const take = (row: number, from: number, to: number): void => {
        rows.set(row, [...(rows.get(row) ?? []), [from, to]]);
    };
    const byKey = (a: StageNode, b: StageNode): number => Number(exceptional(a)) - Number(exceptional(b)) || compare(a.id, b.id);
    /** The lane that starts at `start`: it and, at each step, the next step of the trunk, or the first other one. */
    const laneFrom = (start: StageNode): StageNode[] => {
        const lane = [start];
        for (let n = start; ;) {
            const next = n.trunk ? [...n.children.values()].find((c) => c.trunk) : [...n.children.values()].sort(byKey)[0];
            if (!next || (n.trunk && !next.trunk)) break;
            lane.push(next);
            n = next;
        }
        return lane;
    };
    const queue: { lane: StageNode[]; parentRow: number }[] = [];
    const start = [...tree.root.children.values()].find((c) => c.trunk);
    if (start) queue.push({ lane: laneFrom(start), parentRow: -1 });
    for (const c of [...tree.root.children.values()].filter((c) => !c.trunk).sort(byKey)) queue.push({ lane: laneFrom(c), parentRow: 0 });
    while (queue.length) {
        const { lane, parentRow } = queue.shift()!;
        const from = lane[0]!.col - 1;
        const to = lane.at(-1)!.col;
        let row = lane[0]!.trunk ? 0 : parentRow + 1;
        if (!lane[0]!.trunk) while (!free(row, from, to)) row++;
        take(row, from, to);
        for (const n of lane) n.row = row;
        const branches = lane
            .flatMap((n) => [...n.children.values()].filter((c) => !lane.includes(c)))
            .sort((a, b) => Number(exceptional(a)) - Number(exceptional(b)) || a.col - b.col || compare(a.id, b.id));
        for (const b of branches) queue.push({ lane: laneFrom(b), parentRow: row });
    }
}
