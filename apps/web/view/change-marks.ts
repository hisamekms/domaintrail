// The marks of a span of revisions on the Event Storming canvas (docs/live-view.md, "What a turn changed"): the stickies
// a turn (an AI run, or any other span of revisions) added, changed or removed, drawn with the model canvas's marks — a
// green or amber ring with a badge, a removed sticky as a dashed ghost where it was — and where the camera goes when
// they appear. Pure: the page decides which span is marked (`session/turn-marks.tsx`), the canvas draws the scene.
import type { ElementChange } from '@domaintrail/collaboration/protocol';
import { LEVEL_KINDS, type DisplayMode, type LaidOutGraph } from '@domaintrail/visualization';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { nameIn } from '../model-utils';
import { buildScene, type ChangedElements, type RenderOptions } from '../render';
import { rectCenter, rectContains, unionRects, type Point, type Rect, type Scene, type SceneItem, type SceneNode } from '../scene';
import { stormingGraph, type StormingChoice } from '../storming';

export type MarkKind = 'added' | 'changed' | 'removed';

/** The stickies a span changed, by element ID (`es/<storming>/<local>`), as the canvas marks them. */
export interface ChangeMarks extends ChangedElements {
    /** A changed sticky's text before the change, where it read differently (in the display mode). */
    readonly was: Readonly<Record<string, string>>;
}

/** What the canvas marks, and how they came: a new `key` is marks appearing anew (the camera may move for them). */
export interface CanvasMarks {
    readonly key: string;
    /**
     * `stay`: the marks of a turn that just ended, for a reader who does not follow the AI; the camera stays (the bar
     * tells them). `always`: asked for (図で見る, ほかに n 件の変更) or followed (the AI's turn while the reader follows
     * it): the camera brings them into view unless they all are.
     */
    readonly reveal: 'stay' | 'always';
    readonly marks: ChangeMarks;
}

export const NO_MARKS: ChangeMarks = { added: [], changed: [], removed: [], was: {} };

/** A storming element's ID on the canvas. */
export const stormingElementId = (storming: string, local: string): string => `es/${storming}/${local}`;

/** The storming of an element ID (`es/<storming>/<local>`). */
const stormingOf = (id: string): string => id.split('/')[1] ?? '';

/** The kinds of `.dtes` elements drawn as sticky notes (a timeline, a group or a stage is not one). */
const NOTE_KINDS: ReadonlySet<string> = new Set(LEVEL_KINDS['design-level']);

/**
 * The marks of a span's changes: its stickies only — the `.dtes` elements drawn as notes (a `.dt` element is marked
 * against the model canvas's own baseline; a timeline or a group changes when its steps do). A changed element tells its text before when it reads differently now in `mode` (a label rewritten; in
 * 名前 a label never shows, so nothing).
 */
export function stormingChangeMarks(changes: readonly ElementChange[], mode: DisplayMode): ChangeMarks {
    const added: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];
    const was: Record<string, string> = {};
    for (const c of changes) {
        if (c.language !== 'Dtes' || !NOTE_KINDS.has(c.kind)) continue;
        const id = stormingElementId(c.storming, c.local);
        if (c.change === 'added') added.push(id);
        else if (c.change === 'removed') removed.push(id);
        else {
            changed.push(id);
            const before = c.was && nameIn(mode, c.was.name, c.was.label);
            if (before !== undefined && before !== nameIn(mode, c.name, c.label)) was[id] = before;
        }
    }
    return { added, changed, removed, was };
}

/** How many stickies a span added, changed and removed. */
export const marksCount = (m: ChangedElements): Record<MarkKind, number> => ({ added: m.added.length, changed: m.changed.length, removed: m.removed.length });

export const hasMarks = (m: ChangedElements): boolean => m.added.length + m.changed.length + m.removed.length > 0;

/** A model's diff with a span's marks added (their IDs never meet: `es/…` against model IDs). */
export const withMarks = (diff: ChangedElements, m: ChangedElements): ChangedElements => ({
    added: [...diff.added, ...m.added],
    changed: [...diff.changed, ...m.changed],
    removed: [...diff.removed, ...m.removed],
});

/** Kinds of nodes that are frames, never ghosts. */
const FRAMES = new Set(['esGroup', 'esStage']);

/**
 * Where the removed stickies were in the view shown (`viewKey` of `storming`): their notes in the latest earlier
 * version of that view the page saw (`snapshots`, oldest first), as a graph with the shown graph's ID, for
 * `buildScene` to draw them as ghosts. None when the page never saw them (it was opened after they were removed).
 */
export function ghostGraph(
    graph: LaidOutGraph,
    removed: readonly string[],
    storming: string,
    viewKey: string,
    snapshots: readonly (readonly StormingView[])[],
): LaidOutGraph | undefined {
    const present = new Set(graph.nodes.map((n) => n.elementId));
    const wanted = new Set(removed.filter((id) => stormingOf(id) === storming && !present.has(id)));
    const nodes: LaidOutGraph['nodes'] = [];
    const nodeLayout: LaidOutGraph['nodeLayout'] = {};
    for (let i = snapshots.length - 1; i >= 0 && wanted.size > 0; i--) {
        const old = snapshots[i].find((s) => s.id === storming)?.views[viewKey]?.graph;
        if (!old) continue;
        const found = new Set<string>();
        for (const n of old.nodes) {
            const at = old.nodeLayout[n.id];
            if (!at || FRAMES.has(n.kind) || !wanted.has(n.elementId) || nodeLayout[n.id]) continue;
            nodes.push(n);
            nodeLayout[n.id] = at;
            found.add(n.elementId);
        }
        for (const id of found) wanted.delete(id);
    }
    return nodes.length > 0 ? { ...graph, nodes, nodeLayout: clearOf(graph, nodeLayout), edges: [], edgeLayout: {} } : undefined;
}

/** The room kept between a ghost moved aside and the note it would have covered. */
const GHOST_GAP = 24;

/**
 * The ghosts' places, each moved off the notes it would cover, to the nearest free place found by sliding it down, up,
 * right or left past them: a sticky added where one was removed (the incremental layout puts it there) would
 * otherwise hide under the ghost, drawn over the notes. A ghost that finds no free place nearby stays where it was.
 */
function clearOf(graph: LaidOutGraph, ghosts: LaidOutGraph['nodeLayout']): LaidOutGraph['nodeLayout'] {
    const rect = (l: { x: number; y: number; width: number; height: number }): Rect => ({ x: l.x, y: l.y, w: l.width, h: l.height });
    const taken: Rect[] = graph.nodes.flatMap((n) => {
        const l = graph.nodeLayout[n.id];
        return l && !FRAMES.has(n.kind) ? [rect(l)] : [];
    });
    /** `at` slid one way past what it covers, until it covers nothing (at most a few notes away). */
    const slide = (at: Rect, way: 'down' | 'up' | 'right' | 'left'): Rect | undefined => {
        let c = at;
        for (let i = 0; i < 6; i++) {
            const hit = taken.filter((r) => overlaps(r, c));
            if (hit.length === 0) return c;
            if (way === 'down') c = { ...c, y: Math.max(...hit.map((r) => r.y + r.h)) + GHOST_GAP };
            else if (way === 'up') c = { ...c, y: Math.min(...hit.map((r) => r.y)) - GHOST_GAP - c.h };
            else if (way === 'right') c = { ...c, x: Math.max(...hit.map((r) => r.x + r.w)) + GHOST_GAP };
            else c = { ...c, x: Math.min(...hit.map((r) => r.x)) - GHOST_GAP - c.w };
        }
        return undefined;
    };
    const out: LaidOutGraph['nodeLayout'] = {};
    for (const [id, l] of Object.entries(ghosts)) {
        const at = rect(l);
        const away = (c: Rect): number => Math.hypot(c.x - at.x, c.y - at.y);
        const free = (['down', 'up', 'right', 'left'] as const).flatMap((way) => slide(at, way) ?? []);
        const placed = free.reduce<Rect | undefined>((best, c) => (!best || away(c) < away(best) ? c : best), undefined) ?? at;
        taken.push(placed);
        out[id] = { ...l, x: placed.x, y: placed.y };
    }
    return out;
}

/**
 * The scene with a span's badges (`badges`: 新 / 変 / 削除, shorter than the model's 追加 / 変更) on the notes and
 * ghosts it marks, and a changed note's text before (`was`). `buildScene` already drew their rings and ghosts from
 * `withMarks`.
 */
export function markScene(scene: Scene, marks: ChangeMarks, badges: Record<MarkKind, string>): Scene {
    const added = new Set(marks.added);
    const changed = new Set(marks.changed);
    const removed = new Set(marks.removed);
    const node = (n: SceneNode): SceneNode => {
        const kind: MarkKind | undefined = added.has(n.elementId) ? 'added' : changed.has(n.elementId) ? 'changed' : undefined;
        if (!kind) return n;
        const was = kind === 'changed' ? marks.was[n.elementId] : undefined;
        return { ...n, props: { ...n.props, badge: badges[kind], ...(was !== undefined && { was }) } };
    };
    return {
        ...scene,
        nodes: scene.nodes.map(node),
        ghosts: scene.ghosts.map((g) => (g.type === 'node' && removed.has(g.elementId) ? { ...g, props: { ...g.props, badge: badges.removed } } : g)),
    };
}

/**
 * A storming graph's scene with a span's marks (`buildScene` with them added to the model's diff, then their badges):
 * the removed stickies drawn as ghosts where `ghosts` has them (`ghostGraph`).
 */
export function sceneWithMarks(
    graph: LaidOutGraph,
    opts: Omit<RenderOptions, 'previous'>,
    marks: ChangeMarks,
    ghosts: LaidOutGraph | undefined,
    badges: Record<MarkKind, string>,
): Scene {
    return markScene(buildScene(graph, { ...opts, diff: withMarks(opts.diff, marks), previous: ghosts }), marks, badges);
}

/** An item's bounds on the page. */
export const itemRect = (item: SceneItem): Rect =>
    item.type === 'edge' ? { x: item.x, y: item.y, w: 0, h: 0 } : { x: item.x, y: item.y, w: item.props.w, h: item.props.h };

/** The marked notes and ghosts of a scene, by element ID (an element drawn once per use has several notes). */
export function markedRects(scene: Scene, marks: ChangedElements): Map<string, Rect[]> {
    const shown = new Set([...marks.added, ...marks.changed]);
    const removed = new Set(marks.removed);
    const out = new Map<string, Rect[]>();
    const add = (item: SceneItem): void => {
        out.set(item.elementId, [...(out.get(item.elementId) ?? []), itemRect(item)]);
    };
    for (const n of scene.nodes) if (shown.has(n.elementId)) add(n);
    for (const g of scene.ghosts) if (g.type === 'node' && removed.has(g.elementId)) add(g);
    return out;
}

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The fit leaves this much room around the marks, in screen pixels. */
const INSET = 48;
/** Below this zoom a sticky's text cannot be read: rather than fit marks that far apart, the camera goes to one. */
export const MIN_READABLE_ZOOM = 0.45;

/** Where the camera goes for the marks: nowhere, fitted around them, or centered on one (its zoom kept). */
export type MarksMove =
    | { readonly kind: 'stay' }
    | { readonly kind: 'fit'; readonly bounds: Rect; readonly maxZoom: number }
    | { readonly kind: 'center'; readonly point: Point };

/**
 * Where the camera goes for marks to be brought into view (`viewport`: the page the canvas shows, at `zoom`): nowhere
 * when they all are in view already. It fits them all, zoomed in no further than now (nor past 100%); when that would
 * make them too small to read, it centers on the one nearest the middle of the view instead, at the zoom it has.
 */
export function marksMove(rects: readonly Rect[], viewport: Rect, zoom: number): MarksMove {
    // none, or all of them in view: nothing to bring
    if (rects.every((r) => rectContains(viewport, r))) return { kind: 'stay' };
    const bounds = unionRects(rects);
    if (!bounds) return { kind: 'stay' };
    const screen = { w: viewport.w * zoom, h: viewport.h * zoom };
    const fitZoom = Math.min((screen.w - 2 * INSET) / Math.max(bounds.w, 1), (screen.h - 2 * INSET) / Math.max(bounds.h, 1));
    const maxZoom = Math.min(zoom, 1);
    // fitted, they are never smaller than readable, nor than the reader already looks at them
    if (Math.min(fitZoom, maxZoom) >= Math.min(MIN_READABLE_ZOOM, zoom)) return { kind: 'fit', bounds, maxZoom };
    return { kind: 'center', point: rectCenter(nearest(rects, rectCenter(viewport))) };
}

/**
 * Where the camera goes as marks appear: nowhere unless they are to be revealed (`always`: asked for, or the AI's turn
 * while the reader follows it) — a turn's marks for a reader who does not follow it leave the camera where it is — nor
 * while the reader drags or pans (`moving`); else `marksMove`.
 */
export function marksAppearMove(reveal: CanvasMarks['reveal'], moving: boolean, rects: readonly Rect[], viewport: Rect, zoom: number): MarksMove {
    return reveal !== 'always' || moving ? { kind: 'stay' } : marksMove(rects, viewport, zoom);
}

const distance = (r: Rect, p: Point): number => Math.hypot(rectCenter(r).x - p.x, rectCenter(r).y - p.y);

const nearest = (rects: readonly Rect[], p: Point): Rect => rects.reduce((best, r) => (distance(r, p) < distance(best, p) ? r : best));

/**
 * The marked elements drawn but out of view (none of their notes in `viewport`), and the point to go to for the
 * nearest of them (「ほかに n 件の変更 →」 goes there, one at a time).
 */
export function outOfView(marked: ReadonlyMap<string, readonly Rect[]>, viewport: Rect): { readonly count: number; readonly next?: Point } {
    const out = [...marked.values()].filter((rects) => rects.length > 0 && !rects.some((r) => overlaps(r, viewport)));
    if (out.length === 0) return { count: 0 };
    return { count: out.length, next: rectCenter(nearest(out.flat(), rectCenter(viewport))) };
}

/** The marked elements a view of the stormings draws (the notes of added and changed ones; ghosts are not known there). */
function drawnIn(stormings: readonly StormingView[], choice: StormingChoice, marks: ChangedElements): number {
    const graph = stormingGraph(stormings, choice)?.graph;
    if (!graph) return 0;
    const ids = new Set(graph.nodes.map((n) => n.elementId));
    return [...marks.added, ...marks.changed].filter((id) => ids.has(id)).length;
}

/**
 * The marks of the stickies that exist now but are not drawn in the view `choice` shows (another storming, a timeline
 * or a level without them); removed ones are left out (they are drawn only where the page saw them).
 */
export function notDrawn(stormings: readonly StormingView[], choice: StormingChoice, marks: ChangedElements): ChangedElements {
    const graph = stormingGraph(stormings, choice)?.graph;
    const ids = new Set(graph?.nodes.map((n) => n.elementId) ?? []);
    const exists = (id: string): boolean =>
        stormings.some((s) => s.id === stormingOf(id) && Object.values(s.views).some((v) => v.graph.nodes.some((n) => n.elementId === id)));
    const away = (list: readonly string[]): string[] => list.filter((id) => !ids.has(id) && exists(id));
    return { added: away(marks.added), changed: away(marks.changed), removed: [] };
}

/**
 * The view to show a span's marks in: the one shown when it draws any of them; else the integrated canvas of the
 * first storming it changed that draws some, at the level chosen, else at the other level; for a span that only
 * removed stickies, the integrated canvas of their storming. None to stay where it is.
 */
export function marksView(stormings: readonly StormingView[], choice: StormingChoice, marks: ChangedElements): StormingChoice | undefined {
    if (drawnIn(stormings, choice, marks) > 0) return undefined;
    const order = [...new Set([...marks.added, ...marks.changed, ...marks.removed].map(stormingOf))].filter((id) => stormings.some((s) => s.id === id));
    const integrated = (storming: string, level: StormingChoice['level']): StormingChoice => {
        const { [storming]: _, ...others } = choice.timelines;
        return { ...choice, stormingId: storming, level, timelines: others };
    };
    for (const storming of order) {
        for (const level of [choice.level, choice.level === 'big-picture' ? 'design-level' : 'big-picture'] as const) {
            const c = integrated(storming, level);
            if (drawnIn(stormings, c, marks) > 0) return c;
        }
    }
    const first = order[0];
    return first !== undefined && first !== (choice.stormingId ?? stormings[0]?.id) ? integrated(first, choice.level) : undefined;
}
