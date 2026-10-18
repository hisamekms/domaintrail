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

/** How names are shown in the Live View: the label (the string after a declaration's name), the name, or both. */
export type DisplayMode = 'label' | 'name' | 'both';
export const DISPLAY_MODES: DisplayMode[] = ['label', 'name', 'both'];

/** Language of the Live View's own words (the model's names and labels are shown as written). */
export type Lang = 'ja' | 'en';
export const LANGS: Lang[] = ['ja', 'en'];

/** A text in every display mode. */
export type ModeTexts = Record<DisplayMode, string>;
/** A text in every language and display mode; layout reserves room for the widest one. */
export type Texts = Record<Lang, ModeTexts>;

/** Every (language, display mode) a text is shown in. */
export const TEXT_VARIANTS: [Lang, DisplayMode][] = LANGS.flatMap((l) => DISPLAY_MODES.map((m): [Lang, DisplayMode] => [l, m]));

/** A text with no words of the Live View's own: the same in every language. */
export const anyLang = (t: ModeTexts): Texts => ({ ja: t, en: t });
export const sameText = (s: string): Texts => anyLang({ label: s, name: s, both: s });
/** Builds a text from another, variant by variant. */
export const mapTexts = (t: Texts, f: (s: string, lang: Lang, mode: DisplayMode) => string): Texts =>
    Object.fromEntries(LANGS.map((l) => [l, Object.fromEntries(DISPLAY_MODES.map((m) => [m, f(t[l][m], l, m)]))])) as Texts;
/** One text per language, the same in every display mode. */
export const perLang = (words: Record<Lang, string>): Texts =>
    Object.fromEntries(LANGS.map((l) => [l, { label: words[l], name: words[l], both: words[l] }])) as Texts;

export interface GraphNode {
    id: string;
    kind: NodeKind;
    label: Texts;
    /** Small caption shown above the label, e.g. «aggregate». */
    stereotype?: Texts;
    /** Body rows (fields, etc.), drawn as aligned key / value columns; for a context, its description under the label. */
    lines: GraphLine[];
    /** Containing node, if nested. */
    parent?: string;
    /** Commands that leave a state as it is, listed in a compartment at the bottom of its box (UML internal transitions). */
    internal?: InternalTransition[];
    /** Model element shown in the Detail Panel when the node is selected. */
    elementId: string;
    width: number;
    height: number;
}

/** A body row: `key` (e.g. a field name) and an optional `value` (e.g. its type), aligned in columns. */
export interface GraphLine {
    key: Texts;
    value?: Texts;
    /** The field set a field comes from, shown faded after the value. */
    origin?: Texts;
}

export interface GraphEdge {
    id: string;
    kind: EdgeKind;
    source: string;
    target: string;
    label?: Texts;
    /** Events a transition raises, shown with or instead of its command (see `TransitionLabels`). */
    events?: Texts;
}

/** A command that leaves a state as it is, drawn as a row in the state's box instead of a loop. */
export interface InternalTransition {
    /** In the form of a transition edge's ID: `<command>|<state>-><state>`. */
    id: string;
    /** The command. */
    elementId: string;
    label: Texts;
    events?: Texts;
}

/** What the State View writes on a transition: the command, the events it raises, or both (the events under the command). */
export type TransitionLabels = 'command' | 'event' | 'both';
export const TRANSITION_LABELS: TransitionLabels[] = ['command', 'event', 'both'];

/**
 * A transition's text in `labels`: the main line, and a smaller second line (the events under the command). Without
 * events, the event labels fall back to the command, `faded`.
 */
export function transitionText(label: Texts, events: Texts | undefined, labels: TransitionLabels): { main: Texts; sub?: Texts; faded: boolean } {
    if (labels === 'command') return { main: label, faded: false };
    if (labels === 'event') return events ? { main: events, faded: false } : { main: label, faded: true };
    return { main: label, sub: events && mapTexts(events, (s) => `⇒ ${s}`), faded: false };
}

/** Line heights of a transition's text (at text scale 1); the second line is smaller. */
export const TRANSITION_LINE_HEIGHT = 19;
export const TRANSITION_SUB_LINE_HEIGHT = 15;
/** Size of the second line's text relative to the first. */
export const TRANSITION_SUB_SIZE = 0.85;

/** Height of an internal transition's row; rows are a little taller than edge labels, like the body rows. */
export const internalRowHeight = (t: InternalTransition, labels: TransitionLabels): number =>
    LINE_HEIGHT + (transitionText(t.label, t.events, labels).sub ? TRANSITION_SUB_LINE_HEIGHT : 0);
/** Vertical padding of the internal transitions' compartment. */
export const INTERNAL_PADDING = 5;
/** Height of a node's internal transitions' compartment (0 without any). */
export const compartmentHeight = (n: Pick<GraphNode, 'internal'>, labels: TransitionLabels): number =>
    n.internal?.length ? 2 * INTERNAL_PADDING + n.internal.reduce((h, t) => h + internalRowHeight(t, labels), 0) : 0;

export interface Graph {
    id: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
    /** Text size relative to the normal views (the Structure overview uses larger text). */
    textScale?: number;
    /** State View: the transition texts the nodes and edge labels are sized for (default `both`). */
    transitionLabels?: TransitionLabels;
}

/** Text scale of the Structure overview (names only, no field rows) and of the aggregates level. */
export const OVERVIEW_TEXT_SCALE = 1.5;

/**
 * How much the Structure View shows: every field (detail), the elements' names only (overview), or the aggregates
 * and the dependencies between them only (aggregates).
 */
export type StructureLevel = 'detail' | 'overview' | 'aggregates';
export const STRUCTURE_LEVELS: StructureLevel[] = ['detail', 'overview', 'aggregates'];

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
export const maxUnits = (t: Texts): number => Math.max(...TEXT_VARIANTS.map(([l, m]) => textUnits(t[l][m])));
export const LINE_HEIGHT = 21;
export const HEADER_HEIGHT = 54;
export const CONTAINER_PADDING = { top: 46, left: 20, bottom: 20, right: 20 };

export function graphSignature(g: Graph): string {
    const nodes = g.nodes.map((n) => `${n.id}|${n.parent ?? ''}|${n.width}x${n.height}|${maxUnits(n.label)}`).sort();
    const edges = g.edges.map((e) => `${e.id}|${e.source}|${e.target}|${e.label ? maxUnits(e.label) : ''}|${e.events ? maxUnits(e.events) : ''}`).sort();
    return `${nodes.join(';')}#${edges.join(';')}`;
}
