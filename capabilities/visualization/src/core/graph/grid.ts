/**
 * The layout of a graph placed on a grid (`Graph.grid`): an Event Storming's view of stages, where the order of the
 * columns is time, the main flows run straight along row 0 and each exception hangs on a lane below. ELK's layered
 * layout keeps the order along edges but neither a straight row through every stage nor lanes inside frames, so the
 * cells are placed here, and the edges routed through the gutters between them: a route never crosses a note.
 *
 * - Columns are of one width (a note, or a group's frame around its notes); a gutter separates them, and a wider one the
 *   stages. Rows are as tall as their tallest box; a gutter separates them, room for a lane's caption included.
 * - A frame spans its columns, from the top row to the last row of its own cells. A group's frame is its cell, its
 *   notes stacked in it.
 * - Edges: the next step on the same row, a straight line; into a lower lane, down from the step it branches off from,
 *   along the gutter under its row, then into the lane from the left (the lane's caption above its first note); a
 *   `then` (`esRejoin`) down from its step, along the gutter under its lane, back to the column of its target, up to
 *   the gutter under the target's row and into the target from below; anything else from side to side through the
 *   gutters.
 *
 * Canonical: the same graph, the same layout.
 */
import {
    graphSignature,
    maxUnits,
    TRANSITION_LINE_HEIGHT,
    type EdgeLayout,
    type Graph,
    type GraphNode,
    type LaidOutGraph,
    type LayoutSpacing,
    type NodeLayout,
    type Point,
} from './ir.js';

/**
 * The gaps of a grid, by spacing (`LayoutSpacing`):
 *
 * - `col`: the gutter between two columns; `stage`: the extra one between two stages.
 * - `row`: the gutter between two rows (a lane's caption, and the routes along it); `loose`: the extra one before the
 *   notes outside the frames.
 * - `pad`: a frame's padding beside its cells (the routes along the gutters of its first and last columns inside it);
 *   `head`: its heading (its label, as a container's: CONTAINER_PADDING.top). Below its cells it leaves `frameFoot`.
 *
 * The compact gutters still hold the routes on either side of a gutter's middle (`LANE_OFFSET`) and, under a row, the
 * branch's route, the `then`'s route and a lane's caption one above the other.
 */
export const GRID_SPACING: Record<LayoutSpacing, { col: number; stage: number; row: number; loose: number; pad: number; head: number }> = {
    normal: { col: 72, stage: 64, row: 72, loose: 72, pad: 40, head: 46 },
    compact: { col: 32, stage: 24, row: 52, loose: 24, pad: 12, head: 40 },
};
/** Below a frame's cells: the routes under its last row inside it. */
const frameFoot = (row: number): number => row / 2 + 16;
/** A group's frame: its padding, its heading and the space between its notes. */
const GROUP_PAD = 10;
const GROUP_HEAD = 30;
const GROUP_GAP = 12;
/** Space around everything. */
const MARGIN = 20;
/** A route's offset from a gutter's middle: branches on its left, `then`s on its right, so that the two never overlap. */
const LANE_OFFSET = 9;
/** A `then`'s way out of the bottom of its step: beside the middle, where a branch goes down. */
const REJOIN_OFFSET = 14;
/** Of an edge label (13px sans-serif, as the layout engine sizes them). */
const LABEL_CHAR_WIDTH = 7.6;

interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
    col: number;
    row: number;
}

export function layoutGrid(graph: Graph, spacing: LayoutSpacing = 'normal'): LaidOutGraph {
    const grid = graph.grid!;
    const { col: COL_GAP, stage: STAGE_GAP, row: ROW_GAP, loose: LOOSE_GAP, pad: FRAME_PAD, head: FRAME_HEAD } = GRID_SPACING[spacing];
    const FRAME_FOOT = frameFoot(ROW_GAP);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const members = new Map<string, GraphNode[]>();
    for (const n of graph.nodes) if (n.parent !== undefined && byId.has(n.parent)) members.set(n.parent, [...(members.get(n.parent) ?? []), n]);
    const noteSide = Math.max(1, ...graph.nodes.filter((n) => n.width > 0).map((n) => n.width));
    const colWidth = noteSide + 2 * GROUP_PAD;

    // ---- columns: a stage's columns, then the gap to the next stage ----
    const frames = Object.entries(grid.frames).sort(([, a], [, b]) => a.from - b.from);
    const stageIndex = (col: number): number => {
        const i = frames.findIndex(([, f]) => col <= f.to);
        return i < 0 ? frames.length : i;
    };
    const loose = (row: number): boolean => grid.looseRow !== undefined && row >= grid.looseRow;
    const left = MARGIN + FRAME_PAD + COL_GAP / 2;
    const colX = (col: number, row: number): number => left + col * (colWidth + COL_GAP) + (loose(row) ? 0 : stageIndex(col) * STAGE_GAP);

    // ---- rows: as tall as their tallest box ----
    const boxHeight = (n: GraphNode): number => {
        const inside = members.get(n.id);
        if (!inside?.length) return n.height;
        return GROUP_HEAD + inside.reduce((h, m) => h + m.height, 0) + (inside.length - 1) * GROUP_GAP + GROUP_PAD;
    };
    const heights = new Map<number, number>();
    for (const [id, cell] of Object.entries(grid.cells)) {
        const n = byId.get(id);
        if (n) heights.set(cell.row, Math.max(heights.get(cell.row) ?? 0, boxHeight(n)));
    }
    const rows = [...heights.keys()].sort((a, b) => a - b);
    const rowY = new Map<number, number>();
    let y = MARGIN + (frames.length ? FRAME_HEAD : 0);
    for (const [i, row] of rows.entries()) {
        if (i > 0) y += ROW_GAP + (loose(row) && !loose(rows[i - 1]!) ? LOOSE_GAP + FRAME_FOOT : 0);
        rowY.set(row, y);
        y += heights.get(row)!;
    }
    const top = (row: number): number => rowY.get(row) ?? 0;
    const bottom = (row: number): number => top(row) + (heights.get(row) ?? 0);

    // ---- boxes: a cell's box (a note centred in its column, a group's frame filling it), a group's notes inside it ----
    const nodeLayout: Record<string, NodeLayout> = {};
    const boxes = new Map<string, Box>();
    for (const [id, cell] of Object.entries(grid.cells)) {
        const n = byId.get(id);
        if (!n) continue;
        const x = colX(cell.col, cell.row);
        const inside = members.get(id);
        if (inside?.length) {
            const box = { x, y: top(cell.row), width: colWidth, height: boxHeight(n), ...cell };
            boxes.set(id, box);
            nodeLayout[id] = { x: box.x, y: box.y, width: box.width, height: box.height };
            let my = box.y + GROUP_HEAD;
            for (const m of inside) {
                const mb = { x: x + GROUP_PAD, y: my, width: m.width, height: m.height, ...cell };
                boxes.set(m.id, mb);
                nodeLayout[m.id] = { x: mb.x, y: mb.y, width: mb.width, height: mb.height };
                my += m.height + GROUP_GAP;
            }
            continue;
        }
        const box = { x: x + (colWidth - n.width) / 2, y: top(cell.row), width: n.width, height: n.height, ...cell };
        boxes.set(id, box);
        nodeLayout[id] = { x: box.x, y: box.y, width: box.width, height: box.height };
    }

    // ---- frames: around their columns, from the top row to their last row ----
    const firstRow = rows.find((r) => !loose(r)) ?? 0;
    for (const [id, f] of frames) {
        const own = Object.values(grid.cells).filter((c) => c.col >= f.from && c.col <= f.to && !loose(c.row));
        const last = own.length ? Math.max(...own.map((c) => c.row)) : firstRow;
        const x0 = colX(f.from, firstRow) - FRAME_PAD;
        const x1 = colX(f.to, firstRow) + colWidth + FRAME_PAD;
        const y0 = top(firstRow) - FRAME_HEAD;
        const y1 = (heights.has(last) ? bottom(last) : top(firstRow) + noteSide) + FRAME_FOOT;
        nodeLayout[id] = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }

    // ---- edges, through the gutters ----
    const cellLeft = (b: Box): number => colX(b.col, b.row);
    const gutterBefore = (b: Box): number => cellLeft(b) - COL_GAP / 2;
    const gutterAfter = (b: Box): number => cellLeft(b) + colWidth + COL_GAP / 2;
    const middle = (b: Box): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    /** The height a lane's straight line runs at: the middle of a note of the row. */
    const lineY = (b: Box): number => top(b.row) + noteSide / 2;
    const edgeLayout: Record<string, EdgeLayout> = {};
    for (const e of graph.edges) {
        const a = boxes.get(e.source);
        const b = boxes.get(e.target);
        if (!a || !b) continue;
        let points: Point[];
        let label: NodeLayout | undefined;
        /** A time order (of main flows or of exceptions only), not a `then` or a semantic edge. */
        const order = e.kind === 'esSequence' || e.kind === 'esException';
        if (e.kind === 'esRejoin') {
            // into a group's note from below would cross its other notes: into the group's frame
            const parent = byId.get(e.target)?.parent;
            const t = (parent !== undefined && boxes.get(parent)) || b;
            const out = middle(a).x + REJOIN_OFFSET;
            const back = gutterBefore(t) + LANE_OFFSET;
            const under = bottom(a.row) + ROW_GAP / 2;
            const below = bottom(t.row) + ROW_GAP / 2;
            const tx = middle(t).x;
            points = [
                { x: out, y: a.y + a.height },
                { x: out, y: under },
                { x: back, y: under },
                { x: back, y: below },
                { x: tx, y: below },
                { x: tx, y: t.y + t.height },
            ];
        } else if (order && b.row > a.row) {
            // into a lane below: down from the step, along the gutter under its row, into the lane's first step
            const into = gutterBefore(b) - LANE_OFFSET;
            const under = bottom(a.row) + ROW_GAP / 4;
            const ty = lineY(b);
            points = [
                { x: middle(a).x, y: a.y + a.height },
                { x: middle(a).x, y: under },
                { x: into, y: under },
                { x: into, y: ty },
                { x: b.x, y: ty },
            ];
            if (e.label) {
                const width = Math.ceil(maxUnits(e.label) * LABEL_CHAR_WIDTH) + 8;
                label = { x: b.x, y: b.y - TRANSITION_LINE_HEIGHT - 4, width, height: TRANSITION_LINE_HEIGHT };
            }
        } else if (order && a.row === b.row && b.col === a.col + 1) {
            points = [
                { x: a.x + a.width, y: lineY(a) },
                { x: b.x, y: lineY(b) },
            ];
        } else {
            points = route(a, b);
        }
        edgeLayout[e.id] = label ? { points, label } : { points };
    }

    /** From side to side through the gutters: out towards the target, along the gutter on its side, into it. */
    function route(a: Box, b: Box): Point[] {
        const [ma, mb] = [middle(a), middle(b)];
        if (a.col === b.col) {
            if (Math.abs(a.row - b.row) === 1) {
                const down = b.row > a.row;
                return [
                    { x: ma.x, y: down ? a.y + a.height : a.y },
                    { x: mb.x, y: down ? b.y : b.y + b.height },
                ];
            }
            const g = gutterAfter(a);
            return [
                { x: a.x + a.width, y: ma.y },
                { x: g, y: ma.y },
                { x: g, y: mb.y },
                { x: b.x + b.width, y: mb.y },
            ];
        }
        const right = b.col > a.col;
        const ga = right ? gutterAfter(a) : gutterBefore(a);
        const gb = right ? gutterBefore(b) : gutterAfter(b);
        const sa = { x: right ? a.x + a.width : a.x, y: ma.y };
        const sb = { x: right ? b.x : b.x + b.width, y: mb.y };
        if (a.row === b.row && Math.abs(b.col - a.col) === 1) return [sa, sb];
        if (Math.abs(ga - gb) < 1) return [sa, { x: ga, y: sa.y }, { x: ga, y: sb.y }, sb];
        const channel = b.row > a.row ? top(b.row) - ROW_GAP / 2 : b.row < a.row ? bottom(b.row) + ROW_GAP / 2 : top(b.row) - ROW_GAP / 2;
        return [sa, { x: ga, y: sa.y }, { x: ga, y: channel }, { x: gb, y: channel }, { x: gb, y: sb.y }, sb];
    }

    return { ...graph, nodeLayout, edgeLayout, signature: graphSignature(graph), ...(spacing === 'compact' && { spacing }) };
}
