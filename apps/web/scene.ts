// The scene the canvas draws (`@domaintrail/visualization`'s drawing: every item at its place on the page with what it
// shows), and what the page does with one: which item draws an element, and which stay in view around a selection.
import type { Point, SceneEdge, SceneId, SceneItem, SceneNode } from '@domaintrail/visualization';

export {
    edgeItemId,
    ghostItemId,
    graphNodeOf,
    internalItemId,
    nodeItemId,
    rectCenter,
    rectContains,
    sceneItems,
    unionRects,
    type ChangeMark,
    type DiagMark,
    type EdgeProps,
    type EdgeTone,
    type GroupProps,
    type InternalProps,
    type NodeProps,
    type Point,
    type Rect,
    type Scene,
    type SceneEdge,
    type SceneGroup,
    type SceneId,
    type SceneInternal,
    type SceneItem,
    type SceneItemType,
    type SceneNode,
} from '@domaintrail/visualization';

/**
 * The item drawing `elementId`: its node if it has one, else the first item that stands for it. An element drawn as
 * several notes (a storming's actor beside each command it issues) is the note nearest `near` (the viewport's centre),
 * or without it the first in reading order (top to bottom, then left to right).
 */
export function itemForElement(items: readonly SceneItem[], elementId: string, near?: Point): SceneItem | undefined {
    const nodes = items.filter((s): s is SceneNode => s.elementId === elementId && s.type === 'node');
    if (!nodes.length) return items.find((s) => s.elementId === elementId);
    const centre = (n: SceneNode): Point => ({ x: n.x + n.props.w / 2, y: n.y + n.props.h / 2 });
    const distance = (n: SceneNode): number => (near ? Math.hypot(centre(n).x - near.x, centre(n).y - near.y) : 0);
    return nodes.reduce((best, n) => {
        const [d, b] = [distance(n), distance(best)];
        return d < b || (d === b && (n.y < best.y || (n.y === best.y && n.x < best.x))) ? n : best;
    });
}

/**
 * The other notes of the elements whose notes are selected (`selected`): an element drawn more than once (a storming's
 * actor, read model or aggregate beside each command that uses it) shows all its notes when one is selected.
 */
export function sameElementNodes(items: Iterable<SceneItem>, selected: ReadonlySet<SceneId>): Set<SceneId> {
    const nodes = [...items].filter((s) => s.type === 'node' && !s.ghost);
    const elements = new Set(nodes.filter((s) => selected.has(s.id)).map((s) => s.elementId));
    return new Set(nodes.filter((s) => elements.has(s.elementId) && !selected.has(s.id)).map((s) => s.id));
}

/** The kinds of an Event Storming note (`dn-es…`): what the canvas focuses on when one is selected. */
const isStormingNote = (item: SceneItem): item is SceneNode => item.type === 'node' && !item.ghost && item.props.kind.startsWith('es');

/**
 * What stays in full view while storming notes are selected (docs/plans/layout.md, step 5): the notes of the selected
 * elements (every copy of an element drawn once per use or per step), the notes joined to them by an edge (the previous
 * and next steps, what causes an event and the policies reacting to it, its hotspots; for a command its actor, read
 * model and aggregate), and those edges. The drawing follows Event Storming's grammar, command → aggregate → event: an
 * event caused through an aggregate brings the commands that go to that aggregate along, and a command brings the
 * events its aggregate emits. A command that causes a selected event brings its actor or external system and its read
 * model along. A selected event in a group is joined through its group (the time order runs to and from the group), and
 * a group joined to it brings its events. Containers are never dimmed, so they are not listed. `undefined` when no
 * storming note is selected: nothing is dimmed.
 */
export function focusedItems(items: Iterable<SceneItem>, selected: ReadonlySet<SceneId>): Set<SceneId> | undefined {
    const all = [...items];
    const seeds = all.filter((s) => selected.has(s.id) && isStormingNote(s));
    if (seeds.length === 0) return undefined;
    const elements = new Set(seeds.map((s) => s.elementId));
    const notes = all.filter(isStormingNote);
    const edges = all.filter((s): s is SceneEdge => s.type === 'edge' && !s.ghost);
    const byId = new Map(all.map((s) => [s.id, s]));
    const members = (group: SceneId): SceneId[] => notes.filter((n) => n.parent === group).map((n) => n.id);
    const kindOf = (id: SceneId): string | undefined => {
        const item = byId.get(id);
        return item?.type === 'node' ? item.props.kind : undefined;
    };
    const kept = new Set<SceneId>();
    /** Keeps a note, or a group's events (the group itself is never dimmed). */
    const keep = (id: SceneId): void => {
        if (byId.get(id)?.type !== 'group') kept.add(id);
        else for (const m of members(id)) kept.add(m);
    };
    // the selected elements' notes, and what their edges end at (a note in a group: its group's edges too)
    const own = notes.filter((n) => elements.has(n.elementId));
    const ends = new Set(own.flatMap((n) => (n.parent === undefined ? [n.id] : [n.id, n.parent])));
    for (const n of own) kept.add(n.id);
    const causes: SceneId[] = [];
    /** The aggregates that decide a selected event (their commands are its cause). */
    const deciding: SceneId[] = [];
    /** The aggregates a selected command goes to (their events are its). */
    const decided: SceneId[] = [];
    for (const e of edges) {
        const [from, to] = [ends.has(e.source), ends.has(e.target)];
        if (!from && !to) continue;
        kept.add(e.id);
        const other = from ? e.target : e.source;
        keep(other);
        if (e.props.kind !== 'esCausal') continue;
        // a command (or an aggregate) whose solid edge leads into a selected note: what causes it
        if (to && kindOf(e.source) === 'esCommand') causes.push(e.source);
        if (to && kindOf(e.source) === 'esAggregate' && kindOf(e.target) !== 'esAggregate') deciding.push(e.source);
        if (from && kindOf(e.source) === 'esCommand' && kindOf(e.target) === 'esAggregate') decided.push(e.target);
    }
    for (const e of edges) {
        if (e.props.kind !== 'esCausal') continue;
        // the command going to an aggregate that decides a selected event
        if (deciding.includes(e.target) && kindOf(e.source) === 'esCommand') {
            kept.add(e.id);
            keep(e.source);
            causes.push(e.source);
        }
        // the events emitted by the aggregate of a selected command
        if (decided.includes(e.source)) {
            kept.add(e.id);
            keep(e.target);
        }
    }
    // the cause's actor or external system and read model (the dotted relations of the command)
    for (const e of edges) {
        if (e.props.kind !== 'esRelated') continue;
        const at = causes.includes(e.source) ? e.target : causes.includes(e.target) ? e.source : undefined;
        if (at === undefined) continue;
        kept.add(e.id);
        keep(at);
    }
    return kept;
}
