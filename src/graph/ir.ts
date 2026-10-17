/**
 * Graph IR: a view-independent graph derived from the Typed Model.
 * Node and edge IDs are stable (derived from qualified names) so that layout and camera survive updates.
 */

export type NodeKind =
    | 'context'
    | 'sharedContext'
    | 'aggregateBoundary'
    | 'aggregate'
    | 'entity'
    | 'valueObject'
    | 'union'
    /** An element of another context, shown by name only (focused Structure View). */
    | 'stub'
    /** A bounded context as one node (Context Map). */
    | 'boundedContext'
    | 'state'
    | 'initial';

/** `dependsOn`: a context dependency that borrows types, not only IDs (Context Map). */
export type EdgeKind = 'owns' | 'value' | 'references' | 'transition' | 'dependsOn';

/** How names are shown in the Live View. */
export type DisplayMode = 'ja' | 'en' | 'both';
export const DISPLAY_MODES: DisplayMode[] = ['ja', 'en', 'both'];

/** A text in every display mode; layout reserves room for the widest one. */
export type Texts = Record<DisplayMode, string>;

export const sameText = (s: string): Texts => ({ ja: s, en: s, both: s });

export interface GraphNode {
    id: string;
    kind: NodeKind;
    label: Texts;
    /** Small caption shown above the label, e.g. «aggregate». */
    stereotype?: string;
    /** Body rows (fields, etc.), drawn as aligned key / value columns. */
    lines: GraphLine[];
    /** Containing node, if nested. */
    parent?: string;
    /** Model element shown in the Detail Panel when the node is selected. */
    elementId: string;
    width: number;
    height: number;
}

/** A body row: `key` (e.g. a field name) and an optional `value` (e.g. its type), aligned in columns. */
export interface GraphLine {
    key: Texts;
    value?: Texts;
}

export interface GraphEdge {
    id: string;
    kind: EdgeKind;
    source: string;
    target: string;
    label?: Texts;
}

export interface Graph {
    id: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
    /** Text size relative to the normal views (the Structure overview uses larger text). */
    textScale?: number;
}

/** Text scale of the Structure overview (names only, no field rows). */
export const OVERVIEW_TEXT_SCALE = 1.5;

export interface Point {
    x: number;
    y: number;
}

export interface NodeLayout {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface EdgeLayout {
    points: Point[];
    /** Top-left corner and size of the edge label, when the edge has one. */
    label?: NodeLayout;
}

/** A graph together with absolute coordinates for every node and edge. */
export interface LaidOutGraph extends Graph {
    nodeLayout: Record<string, NodeLayout>;
    edgeLayout: Record<string, EdgeLayout>;
    /** Changes whenever nodes, sizes, nesting or edges change; used to reuse cached layouts. */
    signature: string;
}

export const CHAR_WIDTH = 8.6;
/** CJK and other full-width characters are about this many times wider than ASCII. */
export const WIDE_FACTOR = 1.7;

/** Width of `s` in units of one ASCII character. */
export function textUnits(s: string): number {
    let units = 0;
    for (const ch of s) units += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? WIDE_FACTOR : 1;
    return units;
}

/** Widest variant of a text, in ASCII character units. */
export const maxUnits = (t: Texts): number => Math.max(...DISPLAY_MODES.map((m) => textUnits(t[m])));
export const LINE_HEIGHT = 21;
export const HEADER_HEIGHT = 54;
export const CONTAINER_PADDING = { top: 46, left: 20, bottom: 20, right: 20 };

export function graphSignature(g: Graph): string {
    const nodes = g.nodes.map((n) => `${n.id}|${n.parent ?? ''}|${n.width}x${n.height}|${maxUnits(n.label)}`).sort();
    const edges = g.edges.map((e) => `${e.id}|${e.source}|${e.target}|${e.label ? maxUnits(e.label) : ''}`).sort();
    return `${nodes.join(';')}#${edges.join(';')}`;
}
