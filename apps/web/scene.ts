// The diagram as the canvas draws it, independent of the canvas library (docs/plans/react-flow.md): every item at its
// place on the page with what it shows. `render.ts` builds a scene from a laid-out graph; a canvas (`view/diagram.ts`)
// draws it. Pure data: no React, no canvas library.

export type ChangeMark = 'none' | 'added' | 'changed' | 'removed';
export type DiagMark = 'none' | 'warning' | 'error';
export type EdgeTone = 'normal' | 'added' | 'changed';

/** A point on the page (page units; the layout's coordinates). */
export interface Point {
    readonly x: number;
    readonly y: number;
}

/** What a model element's box shows (aggregate root, entity, value object, state, storming note...). */
export interface NodeProps {
    w: number;
    h: number;
    kind: string;
    label: string;
    stereotype: string;
    /** Text size factor (1 = normal; the Structure overview uses larger text). */
    scale: number;
    /** Body rows; `v` is empty for rows without a value column; `o`: the field set a field comes from; `c`: the row's change from the baseline. */
    rows: { k: string; v: string; o?: string; c?: string }[];
    /** Height of the internal transitions' compartment at the bottom (0 = none); its rows are items of their own. */
    compartment: number;
    change: ChangeMark;
    /** The change badge's text (in the Live View's language), empty without one. */
    badge: string;
    diag: DiagMark;
    /** A resolved hotspot (`.dtes` §3.5): what was agreed, empty when not written. Absent while open and on other nodes. */
    resolution?: string;
}

/** What a container shows: a bounded context, an aggregate boundary, a storming group. */
export interface GroupProps {
    w: number;
    h: number;
    kind: string;
    label: string;
    /** Description rows under the label (contexts at the aggregates level). */
    lines: string[];
    scale: number;
    change: ChangeMark;
    diag: DiagMark;
}

/** What a command that leaves a state as it is shows: a row in the state's compartment (a UML internal transition). */
export interface InternalProps {
    w: number;
    h: number;
    /** The command or its events, and a smaller second line (the events under the command), if any. */
    label: string;
    sub: string;
    /** The command shown in place of missing events. */
    faded: boolean;
    scale: number;
    change: ChangeMark;
    diag: DiagMark;
}

/** What an edge shows: the route computed by the layout engine (bends included) and its label box. */
export interface EdgeProps {
    /** Route relative to the item's origin. */
    points: { x: number; y: number }[];
    kind: string;
    label: string;
    /** A smaller second line of the label (a transition's events), and whether the label is faded (a transition's command in place of missing events). */
    sub: string;
    faded: boolean;
    scale: number;
    /** Label box relative to the item's origin; w = 0 when there is no label. */
    lx: number;
    ly: number;
    lw: number;
    lh: number;
    tone: EdgeTone;
    /** A resolved hotspot's `on`: drawn quieter, as its note is. */
    resolved?: true;
}

/** What every item has: a stable ID (unchanged items keep their identity and selection), its origin and its element. */
interface ItemBase {
    /** Stable across redraws: `n:<graph node>`, `i:<internal transition>`, `e:<edge>`, `ghost:<graph node>`, `ghost:i:<internal transition>`. */
    readonly id: SceneId;
    readonly x: number;
    readonly y: number;
    /** The model element it stands for (what selecting it selects). */
    readonly elementId: string;
    /** A removed element, drawn where it was in the baseline (not clickable). */
    readonly ghost?: true;
}

export interface SceneNode extends ItemBase {
    readonly type: 'node';
    /** The graph node it draws (not on ghosts). */
    readonly graphNode?: string;
    readonly props: NodeProps;
}

export interface SceneGroup extends ItemBase {
    readonly type: 'group';
    readonly graphNode: string;
    readonly props: GroupProps;
}

export interface SceneInternal extends ItemBase {
    readonly type: 'internal';
    /** The graph's internal transition. */
    readonly edge: string;
    readonly props: InternalProps;
}

export interface SceneEdge extends ItemBase {
    readonly type: 'edge';
    /** The graph edge it draws. */
    readonly edge: string;
    /** The items of the graph nodes it joins (`nodeItemId` of its source and target; groups included). */
    readonly source: SceneId;
    readonly target: SceneId;
    readonly props: EdgeProps;
}

export type SceneItem = SceneNode | SceneGroup | SceneInternal | SceneEdge;
export type SceneItemType = SceneItem['type'];

/** An item's ID in a scene (and on the canvas showing it). */
export type SceneId = string;

/**
 * A diagram to draw, in layers from back to front: contexts and other containers behind aggregate boundaries
 * (`groups`, in that order once drawn), then the nodes, the ghosts of removed nodes, the internal transitions over
 * their nodes, and the edges on top.
 */
export interface Scene {
    readonly groups: readonly SceneGroup[];
    readonly nodes: readonly SceneNode[];
    /** Removed nodes and their internal transitions, where they were in the baseline. */
    readonly ghosts: readonly (SceneNode | SceneInternal)[];
    readonly internal: readonly SceneInternal[];
    readonly edges: readonly SceneEdge[];
}

export const nodeItemId = (graphNode: string): SceneId => `n:${graphNode}`;
export const edgeItemId = (edge: string): SceneId => `e:${edge}`;
export const internalItemId = (transition: string): SceneId => `i:${transition}`;
export const ghostItemId = (id: string): SceneId => `ghost:${id}`;

const NODE_PREFIX = 'n:';

/** The graph node an item draws, when it is a node or a group (not a ghost). */
export const graphNodeOf = (id: SceneId): string | undefined => (id.startsWith(NODE_PREFIX) ? id.slice(NODE_PREFIX.length) : undefined);

/** Every item of a scene, back to front (the order the canvas stacks them in). */
export function sceneItems(scene: Scene): SceneItem[] {
    const boundaries = scene.groups.filter((g) => g.props.kind === 'aggregateBoundary');
    const contexts = scene.groups.filter((g) => g.props.kind !== 'aggregateBoundary');
    return [...contexts, ...boundaries, ...scene.nodes, ...scene.ghosts, ...scene.internal, ...scene.edges];
}

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

/** A rectangle on the page (or on the screen, as said where it is used). */
export interface Rect {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

export const rectCenter = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Whether `inner` lies strictly inside `outer` (touching an edge is not inside). */
export const rectContains = (outer: Rect, inner: Rect): boolean =>
    outer.x < inner.x && outer.y < inner.y && outer.x + outer.w > inner.x + inner.w && outer.y + outer.h > inner.y + inner.h;

/** The smallest rectangle around all of `rects`; undefined for none. */
export function unionRects(rects: readonly Rect[]): Rect | undefined {
    if (!rects.length) return undefined;
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.w));
    const maxY = Math.max(...rects.map((r) => r.y + r.h));
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
