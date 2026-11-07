// A diagram as a portable SVG: plain shapes and text, no `foreignObject`, no classes and no external resources, so that
// it opens alike in browsers, design tools (Figma's import) and editors (Inkscape), and rasterizes to a PNG without
// tainting a canvas. It draws the scene as the Live View's canvas does (styles.css's `.dn` / `.dg` / `.di` / `.de`
// rules, mirrored here as attributes, in the colours of a palette resolved from styles.css's custom properties): a box's
// text is laid out line by line in the given font stacks and wrapped, shrunk and cut short with «…» as the canvas does
// (`note-fit.ts`), measured by the caller (a canvas's `measureText` in the page; a table of the fonts' widths in
// `dt export svg`, `text-measure.ts`; a fixed measure in tests).
import { isUndirectedEdge, TRANSITION_LINE_HEIGHT, TRANSITION_SUB_LINE_HEIGHT, TRANSITION_SUB_SIZE } from '../graph/ir.js';
import type { LegendContent } from './legend.js';
import { BADGE, badgeWidth, checkPath, DIAG_RADIUS, RESOLVED_MARK } from './marks.js';
import { fitLabel, NOTE_KINDS, type LabelFit } from './note-fit.js';
import { sceneItems, type EdgeProps, type GroupProps, type InternalProps, type NodeProps, type Rect, type Scene } from './scene.js';

/** The CSS custom properties (styles.css) the drawing takes its colours from. */
export const PALETTE_VARS = [
    '--text',
    '--text-secondary',
    '--muted',
    '--grey',
    '--border',
    '--legend-bg',
    '--node-bg',
    '--node-divider',
    '--stub-bg',
    '--context-bg',
    '--model-ink',
    '--model-context',
    '--model-aggregate',
    '--model-aggregate-tint',
    '--model-entity',
    '--model-value',
    '--model-state',
    '--model-command',
    '--model-edge',
    '--model-edge-quiet',
    '--model-edge-label',
    '--es-event',
    '--es-event-border',
    '--es-event-text',
    '--es-command',
    '--es-command-border',
    '--es-command-text',
    '--es-policy',
    '--es-policy-border',
    '--es-policy-text',
    '--es-aggregate',
    '--es-aggregate-border',
    '--es-aggregate-text',
    '--es-readmodel',
    '--es-readmodel-border',
    '--es-readmodel-text',
    '--es-hotspot',
    '--es-hotspot-border',
    '--es-hotspot-text',
    '--es-hotspot-resolved',
    '--es-hotspot-resolved-border',
    '--es-hotspot-resolved-text',
    '--es-hotspot-resolved-edge',
    '--es-resolved-mark',
    '--es-resolved-mark-ink',
    '--es-actor',
    '--es-actor-border',
    '--es-actor-text',
    '--es-external',
    '--es-external-border',
    '--es-external-text',
    '--es-group-bg',
    '--es-group-border',
    '--es-group-text',
    '--es-sequence',
    '--es-sequence-text',
    '--es-exception',
    '--es-exception-text',
    '--added',
    '--changed',
    '--removed',
    '--accent',
    '--error',
    '--warning',
    '--on-status',
] as const;

export type PaletteVar = (typeof PALETTE_VARS)[number];

/** A colour as SVG 1.1 takes it: `#rrggbb` and an opacity. */
export interface Rgba {
    hex: string;
    alpha: number;
}

export type Palette = Record<PaletteVar, Rgba>;

/** A font, as a CSS `font` shorthand is made of. */
export interface Font {
    family: string;
    size: number;
    weight?: number;
}

/** How wide a text is in a font, and how high the font's lines are (its ascent and descent from the baseline). */
export interface TextMeasure {
    width: (text: string, font: Font) => number;
    metrics: (font: Font) => { ascent: number; descent: number };
}

/** The page's font stacks (`--sans`, `--mono`), each ending with a generic family. */
export interface Fonts {
    sans: string;
    mono: string;
}

/** What to draw: the scene, the part of the page it covers, and the optional heading line and legend. */
export interface PortableSvgInput {
    scene: Scene;
    /** The diagram's bounds on the page (the items' coordinates). */
    bounds: Rect;
    heading?: string | undefined;
    legend?: { title: string; content: LegendContent; kindNames: Record<string, string> } | undefined;
    palette: Palette;
    fonts: Fonts;
    measure: TextMeasure;
    /** The background, under the diagram and around its edges' labels (default white, `PAPER`). */
    paper?: Rgba | undefined;
}

/** A drawn SVG and its size in px. */
export interface PortableSvg {
    svg: string;
    width: number;
    height: number;
}

/** The diameter of the check in a resolved hotspot's legend chip (`.dn-resolved-mark-chip`). */
const CHIP_CHECK = 2 * (RESOLVED_MARK.radius - 2);

/** Room around everything (px). */
const MARGIN = 24;
/** Between the heading and the diagram, and between the diagram and the legend. */
const GAP = 16;
const HEADING_SIZE = 14;
/** The background (the paper), unless another is given: white, whatever the theme of the page exporting it. */
export const PAPER: Rgba = { hex: '#ffffff', alpha: 1 };

// ---------- text ----------

/** CJK characters and full-width forms: each one a place where a line may break. */
const WIDE = '\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF';
/** A text's pieces: a run of spaces, a wide character, or a run of anything else (a word). */
const PIECES = new RegExp(`\\s+|[${WIDE}]|[^\\s${WIDE}]+`, 'gu');
/** What never starts a line (kinsoku): closing brackets, Japanese punctuation, small kana, the long vowel mark. */
const NO_START = /^[、。，．・：；？！ー）」』】〕〉》｝”’ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々…‥〜]/u;
/** What never ends a line: opening brackets. */
const NO_END = /[（「『【〔〈《｛“‘]$/u;

const segmenter = new Intl.Segmenter();

/** The characters of a text as a reader sees them (an emoji with its modifiers is one). */
const graphemes = (s: string): string[] => Array.from(segmenter.segment(s), (g) => g.segment);

/** The pieces of a text a line may break between: words, single wide characters (with their kinsoku), and spaces. */
export function breakUnits(text: string): string[] {
    const raw = text.match(PIECES) ?? [];
    const units: string[] = [];
    let carry = '';
    for (const piece of raw) {
        if (/^\s/.test(piece)) {
            if (carry) units.push(carry);
            carry = '';
            units.push(' ');
            continue;
        }
        const unit = carry + piece;
        carry = '';
        const last = units[units.length - 1];
        if (NO_START.test(unit) && last !== undefined && last !== ' ') units[units.length - 1] = last + unit;
        else if (NO_END.test(unit)) carry = unit;
        else units.push(unit);
    }
    if (carry) units.push(carry);
    return units;
}

/**
 * The lines `text` wraps to in `width`, as the canvas's notes wrap (`overflow-wrap: anywhere`): a wide character may
 * break anywhere (but not before closing punctuation), words break at spaces, a space at a line's end hangs, and a word
 * longer than a line is broken where the line is full.
 */
export function wrapLines(text: string, width: number, widthOf: (s: string) => number): string[] {
    const lines: string[] = [];
    let line = '';
    for (const unit of breakUnits(text.trim())) {
        if (unit === ' ') {
            if (line) line += ' ';
            continue;
        }
        if (widthOf((line + unit).trimEnd()) <= width) {
            line += unit;
            continue;
        }
        if (line.trim()) lines.push(line.trimEnd());
        line = '';
        if (widthOf(unit) <= width) {
            line = unit;
            continue;
        }
        for (const ch of graphemes(unit)) {
            if (line && widthOf(line + ch) > width) {
                lines.push(line);
                line = ch;
            } else line += ch;
        }
    }
    if (line.trim() || !lines.length) lines.push(line.trimEnd());
    return lines;
}

/** `line` cut short to end with «…» within `width` (the last line of a clamped label). */
export function ellipsize(line: string, width: number, widthOf: (s: string) => number): string {
    const chars = graphemes(line);
    while (chars.length && widthOf(`${chars.join('').trimEnd()}…`) > width) chars.pop();
    return `${chars.join('').trimEnd()}…`;
}

/** The fitted label of a sticky note: its fit (`fitLabel`) and its lines, the last ending with «…» when clamped. */
export interface NoteText {
    fit: LabelFit;
    lines: string[];
}

/**
 * A sticky note's label laid out as the canvas does it (`NoteLabel`): the largest size at which its wrapped lines fit
 * the room under the stereotype, else the floor size clamped to the lines that fit.
 */
export function noteText(p: Pick<NodeProps, 'label' | 'w' | 'h' | 'scale' | 'stereotype'>, sans: string, measure: TextMeasure): NoteText {
    const box = noteBox(p);
    const widthAt = (size: number) => (s: string) => measure.width(s, { family: sans, size, weight: 700 });
    const fit = fitLabel((fontSize, lineHeight) => wrapLines(p.label, box.width, widthAt(fontSize)).length * lineHeight, box.room, p.scale);
    const lines = wrapLines(p.label, box.width, widthAt(fit.fontSize));
    if (fit.clamp === undefined || lines.length <= fit.clamp) return { fit, lines };
    const shown = lines.slice(0, fit.clamp);
    shown[shown.length - 1] = ellipsize(`${shown[shown.length - 1]}${lines[fit.clamp]}`, box.width, widthAt(fit.fontSize));
    return { fit, lines: shown };
}

/** A note's border, its head's padding (`.dn-head`: 6px 10px 4px) and the stereotype's line (`.dn-stereo`). */
const NOTE_BORDER = 1.5;
const HEAD_PAD = { top: 6, side: 10, bottom: 4 };
const stereoLine = (scale: number): number => 14 * scale;

/** The room of a note's label: its width, and its height under the stereotype (as `measureLabel` takes it). */
function noteBox(p: Pick<NodeProps, 'w' | 'h' | 'scale' | 'stereotype'>): { width: number; height: number; room: number } {
    const width = p.w - 2 * NOTE_BORDER - 2 * HEAD_PAD.side;
    const height = p.h - 2 * NOTE_BORDER - HEAD_PAD.top - HEAD_PAD.bottom;
    return { width, height, room: height - (p.stereotype ? stereoLine(p.scale) : 0) };
}

// ---------- SVG text ----------

/** Escapes text for XML (and drops the control characters XML forbids). */
export const xml = (s: string): string =>
    s
        // oxlint-disable-next-line no-control-regex -- the characters XML 1.0 forbids
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }[c]};`);

/** A number as an attribute: at most two decimals. */
const num = (n: number): string => String(Math.round(n * 100) / 100);

type Attrs = Record<string, string | number | undefined | false>;

const attrs = (a: Attrs): string =>
    Object.entries(a)
        .filter(([, v]) => v !== undefined && v !== false && v !== '')
        .map(([k, v]) => ` ${k}="${typeof v === 'number' ? num(v) : xml(String(v))}"`)
        .join('');

const tag = (name: string, a: Attrs, children?: string): string =>
    children === undefined ? `<${name}${attrs(a)}/>` : `<${name}${attrs(a)}>${children}</${name}>`;

/** A paint attribute (`fill` or `stroke`) and its opacity, when not opaque. */
const paint = (kind: 'fill' | 'stroke', c: Rgba | undefined, alpha = 1): Attrs =>
    c ? { [kind]: c.hex, [`${kind}-opacity`]: c.alpha * alpha < 1 ? c.alpha * alpha : undefined } : { [kind]: 'none' };

/** Where the baseline of a line of `font` goes in a line box from `top`, `height` high (CSS's half-leading). */
function baseline(measure: TextMeasure, font: Font, top: number, height: number): number {
    const { ascent, descent } = measure.metrics(font);
    return top + (height - (ascent + descent)) / 2 + ascent;
}

const fontAttrs = (font: Font): Attrs => ({
    'font-family': font.family,
    'font-size': font.size,
    'font-weight': font.weight !== undefined && font.weight !== 400 ? font.weight : undefined,
});

/** Lines of text, one `<tspan>` each, from `top` with `lineHeight`, anchored at `x` (`start` or `middle`). */
function textLines(
    lines: readonly string[],
    o: { x: number; top: number; lineHeight: number; font: Font; fill: Rgba; anchor?: 'middle'; extra?: Attrs; measure: TextMeasure },
): string {
    const spans = lines.map((line, i) => tag('tspan', { x: o.x, y: baseline(o.measure, o.font, o.top + i * o.lineHeight, o.lineHeight) }, xml(line))).join('');
    return tag('text', { ...fontAttrs(o.font), ...paint('fill', o.fill), 'text-anchor': o.anchor, ...o.extra }, spans);
}

// ---------- shapes ----------

/** A rectangle whose border (`width` wide, inside the box as CSS draws it) is the stroke. */
function borderRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    o: { fill?: Rgba | undefined; fillAlpha?: number; stroke?: Rgba | undefined; width: number; dash?: string | undefined; extra?: Attrs },
): string {
    const inset = o.stroke ? o.width / 2 : 0;
    return tag('rect', {
        x: x + inset,
        y: y + inset,
        width: Math.max(0, w - 2 * inset),
        height: Math.max(0, h - 2 * inset),
        rx: r > 0 ? Math.max(0, r - inset) : undefined,
        ...paint('fill', o.fill, o.fillAlpha),
        ...(o.stroke ? { ...paint('stroke', o.stroke), 'stroke-width': o.width, 'stroke-dasharray': o.dash } : {}),
        ...o.extra,
    });
}

/** A dashed border of `width`, and a dotted one (as the browser draws `dashed` / `dotted`, about). */
const dashed = (width: number): string => `${num(width * 4)} ${num(width * 2.5)}`;
const dotted = (width: number): string => `${num(width)} ${num(width * 1.5)}`;

/** A rectangle with only its top corners rounded (an aggregate's tinted head). */
function roundTop(x: number, y: number, w: number, h: number, r: number): string {
    return `M${num(x)},${num(y + h)} V${num(y + r)} A${num(r)},${num(r)} 0 0 1 ${num(x + r)},${num(y)} H${num(x + w - r)} A${num(r)},${num(r)} 0 0 1 ${num(x + w)},${num(y + r)} V${num(y + h)} Z`;
}

// ---------- the drawing ----------

/** How a kind of model box is drawn (`.dn-<kind>`): its border's colour, width, style and radius, and its paper. */
interface BoxLook {
    border: PaletteVar;
    width: number;
    radius: number;
    style?: 'dashed' | 'dotted';
    paper: PaletteVar;
    opacity?: number;
}

const BOX_LOOKS: Record<string, BoxLook> = {
    aggregate: { border: '--model-aggregate', width: 2, radius: 8, paper: '--node-bg' },
    entity: { border: '--model-entity', width: 1.5, radius: 8, paper: '--node-bg' },
    valueObject: { border: '--model-value', width: 1.5, radius: 16, paper: '--node-bg' },
    union: { border: '--model-value', width: 1.5, radius: 16, style: 'dashed', paper: '--node-bg' },
    boundedContext: { border: '--model-context', width: 2, radius: 10, paper: '--node-bg' },
    stub: { border: '--grey', width: 1.5, radius: 8, style: 'dotted', paper: '--stub-bg', opacity: 0.85 },
    state: { border: '--model-state', width: 1.5, radius: 14, paper: '--node-bg' },
};
const DEFAULT_BOX: BoxLook = { border: '--grey', width: 1.5, radius: 8, paper: '--node-bg' };

/** A sticky note's paper, edge and text (`.dn-es*`). */
const noteVars = (kind: string): { paper: PaletteVar; border: PaletteVar; text: PaletteVar } => {
    // a gap's empty slot (ADR 0032): the canvas's paper, a muted dashed edge and text
    if (kind === 'esGap') return { paper: '--node-bg', border: '--muted', text: '--muted' };
    const k = kind.slice(2).toLowerCase();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the note kinds' variables are in PALETTE_VARS
    return { paper: `--es-${k}` as PaletteVar, border: `--es-${k}-border` as PaletteVar, text: `--es-${k}-text` as PaletteVar };
};

/** A resolved hotspot's paper, edge and text (`.dn-esHotspot.dn-resolved`): the hotspot's, toned down. */
const RESOLVED_NOTE = { paper: '--es-hotspot-resolved', border: '--es-hotspot-resolved-border', text: '--es-hotspot-resolved-text' } as const;

/** How a kind of container is drawn (`.dg-<kind>`): its border, paper and caption. */
const GROUP_LOOKS: Record<string, { border: PaletteVar; paper: PaletteVar; paperAlpha?: number; dashed?: boolean; caption: PaletteVar; small?: boolean }> = {
    context: { border: '--model-context', paper: '--context-bg', caption: '--text-secondary' },
    sharedContext: { border: '--model-context', paper: '--context-bg', dashed: true, caption: '--text-secondary' },
    aggregateBoundary: {
        border: '--model-aggregate',
        paper: '--model-aggregate-tint',
        paperAlpha: 0.5,
        dashed: true,
        caption: '--model-aggregate',
        small: true,
    },
    esGroup: { border: '--es-group-border', paper: '--es-group-bg', dashed: true, caption: '--es-group-text', small: true },
    esStage: { border: '--model-context', paper: '--context-bg', caption: '--text-secondary' },
};

/** How a kind of edge is drawn (`.de-<kind>`): its line, its head and its label. */
interface EdgeLook {
    stroke: PaletteVar;
    width: number;
    dash?: string;
    head: PaletteVar;
    label: PaletteVar;
    bold?: boolean;
}

const EDGE_LOOKS: Record<string, EdgeLook> = {
    value: { stroke: '--model-edge-quiet', width: 1.4, dash: '2 3', head: '--model-edge', label: '--model-edge-label' },
    references: { stroke: '--model-aggregate', width: 1.4, dash: '6 4', head: '--model-aggregate', label: '--model-aggregate' },
    dependsOn: { stroke: '--model-ink', width: 2, head: '--model-ink', label: '--model-ink', bold: true },
    transition: { stroke: '--model-command', width: 1.6, head: '--model-command', label: '--model-edge-label' },
    esCausal: { stroke: '--model-edge', width: 1.4, head: '--model-edge', label: '--model-edge-label' },
    esSequence: { stroke: '--model-edge', width: 1.4, dash: '6 5', head: '--model-edge', label: '--model-edge-label', bold: true },
    esException: { stroke: '--model-edge', width: 1.4, dash: '6 5', head: '--model-edge', label: '--model-edge-label', bold: true },
    esRejoin: { stroke: '--model-edge', width: 1.4, dash: '6 5', head: '--model-edge', label: '--model-edge-label' },
    esRelated: { stroke: '--model-edge', width: 1.4, head: '--model-edge', label: '--model-edge-label' },
    esFeeds: { stroke: '--model-edge', width: 1.4, head: '--model-edge', label: '--model-edge-label' },
    esHotspot: { stroke: '--model-edge-quiet', width: 1.2, head: '--model-edge-quiet', label: '--model-edge-label' },
};
const DEFAULT_EDGE: EdgeLook = { stroke: '--model-edge', width: 1.4, head: '--model-edge', label: '--model-edge-label' };

/**
 * The look of an edge with its tone (an added or changed edge takes the change's colour); a resolved hotspot's `on` is
 * quieter (`.de-resolved`).
 */
function edgeLook(kind: string, tone: EdgeProps['tone'], resolved?: true): EdgeLook {
    const kept = EDGE_LOOKS[kind] ?? DEFAULT_EDGE;
    const look = resolved ? { ...kept, stroke: '--es-hotspot-resolved-edge' as const } : kept;
    if (tone === 'normal') return look;
    const colour: PaletteVar = tone === 'added' ? '--added' : '--changed';
    return { ...look, stroke: colour, width: 2.4, head: colour };
}

/** The arrowheads and the composition diamond, as markers: one of each colour used. */
class Markers {
    private readonly defs = new Map<string, string>();
    constructor(private readonly palette: Palette) {}

    /** The marker of an arrowhead in `colour` (13px long and wide, its tip at the line's end, as `arrowHead` draws it). */
    arrow(colour: PaletteVar): string {
        const id = `dt-arrow${colour.slice(1)}`;
        if (!this.defs.has(id))
            this.defs.set(
                id,
                tag(
                    'marker',
                    { id, viewBox: '0 0 13 13', markerUnits: 'userSpaceOnUse', markerWidth: 13, markerHeight: 13, refX: 13, refY: 6.5, orient: 'auto' },
                    tag('path', { d: 'M0,0 L13,6.5 L0,13 Z', ...paint('fill', this.palette[colour]) }),
                ),
            );
        return `url(#${id})`;
    }

    /** The marker of the composition diamond at an owner's end (`diamond`). */
    diamond(): string {
        const id = 'dt-diamond';
        if (!this.defs.has(id))
            this.defs.set(
                id,
                tag(
                    'marker',
                    { id, viewBox: '0 0 14 9', markerUnits: 'userSpaceOnUse', markerWidth: 14, markerHeight: 9, refX: 0, refY: 4.5, orient: 'auto' },
                    tag('path', { d: 'M0,4.5 L7,0 L14,4.5 L7,9 Z', ...paint('fill', this.palette['--model-ink']) }),
                ),
            );
        return `url(#${id})`;
    }

    toString(): string {
        return [...this.defs.values()].join('');
    }
}

/** Draws the scene's items, the heading and the legend. */
class Drawing {
    readonly markers: Markers;
    private readonly sans: string;
    private readonly mono: string;

    constructor(
        private readonly palette: Palette,
        fonts: Fonts,
        private readonly measure: TextMeasure,
        private readonly paper: Rgba,
    ) {
        this.markers = new Markers(palette);
        this.sans = fonts.sans;
        this.mono = fonts.mono;
    }

    private c(v: PaletteVar): Rgba {
        return this.palette[v];
    }

    private lineHeight(font: Font): number {
        const { ascent, descent } = this.measure.metrics(font);
        return ascent + descent;
    }

    group(x: number, y: number, p: GroupProps): string {
        const look = GROUP_LOOKS[p.kind];
        const out: string[] = [];
        if (look)
            out.push(
                borderRect(x, y, p.w, p.h, 12, {
                    fill: this.c(look.paper),
                    fillAlpha: look.paperAlpha,
                    stroke: this.c(look.border),
                    width: 1.5,
                    dash: look.dashed || p.unused ? dashed(1.5) : undefined,
                }),
            );
        const font: Font = { family: this.sans, size: (look?.small ? 13 : 16) * p.scale, weight: 700 };
        const caption = this.lineHeight(font);
        out.push(textLines([p.label], { x: x + 12, top: y + 8, lineHeight: caption, font, fill: this.c(look?.caption ?? '--text'), measure: this.measure }));
        if (p.lines.length)
            out.push(
                textLines(p.lines, {
                    x: x + 12,
                    top: y + 8 + caption + 8 - 4 * p.scale,
                    lineHeight: 21,
                    font: { family: this.mono, size: 14 },
                    fill: this.c('--muted'),
                    measure: this.measure,
                }),
            );
        return tag('g', {}, out.join(''));
    }

    node(x: number, y: number, p: NodeProps): string {
        if (p.kind === 'initial') return this.initial(x, y, p);
        const note = NOTE_KINDS.has(p.kind);
        const removed = p.change === 'removed';
        const out: string[] = [];
        let border: number;
        let radius: number;
        if (note) {
            const v = p.resolution !== undefined ? RESOLVED_NOTE : noteVars(p.kind);
            border = NOTE_BORDER;
            radius = p.kind === 'esActor' ? 18 : 3;
            const style = p.kind === 'esExternal' || p.kind === 'esGap' || removed ? dashed(border) : undefined;
            out.push(this.ring(x, y, p, radius));
            out.push(borderRect(x, y, p.w, p.h, radius, { fill: this.c(v.paper), stroke: this.c(v.border), width: border, dash: style }));
            out.push(this.noteHead(x, y, p, this.c(v.text)));
            // a resolved hotspot's check; a sticky's, for the resolved hotspots on it that are hidden
            if (p.resolution !== undefined || p.settled) {
                const r = RESOLVED_MARK.radius;
                out.push(this.check(x + p.w - RESOLVED_MARK.inset - r, y + RESOLVED_MARK.inset + r, r, 2));
            }
        } else {
            const look = BOX_LOOKS[p.kind] ?? DEFAULT_BOX;
            border = look.width;
            radius = look.radius;
            const style = removed || look.style === 'dashed' ? dashed(border) : look.style === 'dotted' ? dotted(border) : undefined;
            out.push(this.ring(x, y, p, radius));
            out.push(borderRect(x, y, p.w, p.h, radius, { fill: this.c(look.paper), stroke: this.c(look.border), width: border, dash: style }));
            out.push(this.card(x, y, p, border));
        }
        out.push(this.marks(x, y, p, border));
        const opacity = removed ? 0.7 : p.kind === 'stub' ? 0.85 : undefined;
        return tag('g', { opacity }, out.join(''));
    }

    /** A change's ring outside the box (`box-shadow: 0 0 0 3px`). */
    private ring(x: number, y: number, p: NodeProps, radius: number): string {
        if (p.change !== 'added' && p.change !== 'changed') return '';
        return tag('rect', {
            x: x - 1.5,
            y: y - 1.5,
            width: p.w + 3,
            height: p.h + 3,
            rx: radius + 1.5,
            fill: 'none',
            ...paint('stroke', this.c(p.change === 'added' ? '--added' : '--changed')),
            'stroke-width': 3,
        });
    }

    /** A sticky note's head: the stereotype and the fitted label, in the middle of the note. */
    private noteHead(x: number, y: number, p: NodeProps, ink: Rgba): string {
        const box = noteBox(p);
        const { fit, lines } = noteText(p, this.sans, this.measure);
        const stereo = p.stereotype ? stereoLine(p.scale) : 0;
        const top = y + NOTE_BORDER + HEAD_PAD.top + (box.height - stereo - lines.length * fit.lineHeight) / 2;
        const cx = x + p.w / 2;
        const out: string[] = [];
        if (p.stereotype)
            out.push(
                textLines([p.stereotype], {
                    x: cx,
                    top,
                    lineHeight: stereo,
                    font: { family: this.sans, size: 12 * p.scale },
                    fill: ink,
                    anchor: 'middle',
                    measure: this.measure,
                }),
            );
        out.push(
            textLines(lines, {
                x: cx,
                top: top + stereo,
                lineHeight: fit.lineHeight,
                font: { family: this.sans, size: fit.fontSize, weight: 700 },
                fill: ink,
                anchor: 'middle',
                extra: { 'text-decoration': p.change === 'removed' ? 'line-through' : undefined },
                measure: this.measure,
            }),
        );
        return out.join('');
    }

    /** A model box's head (stereotype, name), its rows and its compartment's line. */
    private card(x: number, y: number, p: NodeProps, border: number): string {
        const s = p.scale;
        const out: string[] = [];
        const inner = { x: x + border, w: p.w - 2 * border };
        const stereo = p.stereotype ? 14 * s : 0;
        const headH = HEAD_PAD.top + stereo + 24 * s + HEAD_PAD.bottom;
        const headTop = y + border;
        if (p.kind === 'aggregate')
            out.push(
                tag('path', {
                    d: roundTop(inner.x, headTop, inner.w, Math.min(headH, p.h - 2 * border), 6),
                    ...paint('fill', this.c('--model-aggregate-tint')),
                }),
            );
        // the head's divider, where something is under it
        if (p.h - 2 * border > headH + 4)
            out.push(
                tag('path', {
                    d: `M${num(inner.x)},${num(headTop + headH + 0.5)} H${num(inner.x + inner.w)}`,
                    ...paint('stroke', this.c('--node-divider')),
                    'stroke-width': 1,
                }),
            );
        const cx = x + p.w / 2;
        if (p.stereotype)
            out.push(
                textLines([p.stereotype], {
                    x: cx,
                    top: headTop + HEAD_PAD.top,
                    lineHeight: stereo,
                    font: { family: this.sans, size: 12 * s },
                    fill: this.c('--muted'),
                    anchor: 'middle',
                    measure: this.measure,
                }),
            );
        out.push(
            textLines([p.label], {
                x: cx,
                top: headTop + HEAD_PAD.top + stereo,
                lineHeight: 24 * s,
                font: { family: this.sans, size: 17 * s, weight: 700 },
                fill: this.c('--text'),
                anchor: 'middle',
                extra: { 'text-decoration': p.change === 'removed' ? 'line-through' : undefined },
                measure: this.measure,
            }),
        );
        if (p.rows.length) out.push(this.rows(inner.x + 10, headTop + headH + 1 + 5, p.rows));
        if (p.compartment > 0)
            out.push(
                tag('path', {
                    d: `M${num(x)},${num(y + p.h - p.compartment - 0.5)} H${num(x + p.w)}`,
                    ...paint('stroke', this.c('--node-divider')),
                    'stroke-width': 1,
                }),
            );
        return out.join('');
    }

    /** A box's rows: a grid of keys and values (`.dn-body`), the values after the widest key and two `ch`. */
    private rows(x: number, top: number, rows: NodeProps['rows']): string {
        const mono: Font = { family: this.mono, size: 14 };
        const widthOf = (s: string, f: Font = mono): number => this.measure.width(s, f);
        const keyColumn = Math.max(0, ...rows.filter((r) => r.v).map((r) => widthOf(r.k)));
        const valueX = x + keyColumn + 2 * widthOf('0');
        const out: string[] = [];
        rows.forEach((r, i) => {
            const rowTop = top + i * 21;
            const change = r.c === 'added' ? '--added' : r.c === 'changed' ? '--changed' : r.c === 'removed' ? '--removed' : undefined;
            const font: Font = { ...mono, weight: r.c === 'added' || r.c === 'changed' ? 600 : undefined };
            const extra: Attrs = r.c === 'removed' ? { 'text-decoration': 'line-through', opacity: 0.7 } : {};
            out.push(textLines([r.k], { x, top: rowTop, lineHeight: 21, font, fill: this.c(change ?? '--model-ink'), extra, measure: this.measure }));
            if (!r.v) return;
            out.push(
                textLines([r.v], { x: valueX, top: rowTop, lineHeight: 21, font, fill: this.c(change ?? '--text-secondary'), extra, measure: this.measure }),
            );
            if (r.o) {
                const origin: Font = { family: this.sans, size: 14 * 0.85 };
                const ox = valueX + widthOf(r.v, font) + 1.5 * widthOf('0', origin);
                out.push(
                    textLines([r.o], {
                        x: ox,
                        top: rowTop,
                        lineHeight: 21,
                        font: origin,
                        fill: this.c('--muted'),
                        extra: { opacity: 0.8 },
                        measure: this.measure,
                    }),
                );
            }
        });
        return out.join('');
    }

    /** A state diagram's start: a filled disc with its label. */
    private initial(x: number, y: number, p: NodeProps): string {
        const font: Font = { family: this.sans, size: 14, weight: 700 };
        return tag(
            'g',
            {},
            tag('ellipse', { cx: x + p.w / 2, cy: y + p.h / 2, rx: p.w / 2, ry: p.h / 2, ...paint('fill', this.c('--model-ink')) }) +
                (p.label
                    ? textLines([p.label], {
                          x: x + p.w / 2,
                          top: y,
                          lineHeight: p.h,
                          font,
                          fill: this.c('--node-bg'),
                          anchor: 'middle',
                          measure: this.measure,
                      })
                    : ''),
        );
    }

    /** The change badge and the diagnostic mark on a box's edge (`EdgeMarks` at its normal size). */
    private marks(x: number, y: number, p: Pick<NodeProps, 'w' | 'badge' | 'diag' | 'change'>, border: number): string {
        const out: string[] = [];
        if (p.badge) {
            const bx = x + border + BADGE.left;
            const by = y + border - 10;
            const fill = p.change === 'added' ? '--added' : p.change === 'changed' ? '--changed' : p.change === 'removed' ? '--removed' : '--accent';
            const w = badgeWidth(p.badge);
            out.push(tag('rect', { x: bx, y: by, width: w, height: BADGE.height, rx: 4, ...paint('fill', this.c(fill)) }));
            out.push(
                textLines([p.badge], {
                    x: bx + w / 2,
                    top: by,
                    lineHeight: BADGE.height,
                    font: { family: this.sans, size: 12 },
                    fill: this.c('--on-status'),
                    anchor: 'middle',
                    measure: this.measure,
                }),
            );
        }
        if (p.diag !== 'none') out.push(this.diag(x + p.w, y, DIAG_RADIUS, 13, p.diag));
        return out.join('');
    }

    /** A resolved hotspot's check (`.dn-resolved-mark`): a green disc of radius `r` at (`cx`, `cy`) and its tick. */
    private check(cx: number, cy: number, r: number, width: number): string {
        return (
            tag('circle', { cx, cy, r, ...paint('fill', this.c('--es-resolved-mark')) }) +
            tag('path', {
                d: checkPath(cx, cy, r),
                fill: 'none',
                ...paint('stroke', this.c('--es-resolved-mark-ink')),
                'stroke-width': width,
                'stroke-linecap': 'round',
                'stroke-linejoin': 'round',
            })
        );
    }

    private diag(cx: number, cy: number, r: number, size: number, diag: 'warning' | 'error'): string {
        return (
            tag('circle', { cx, cy, r, ...paint('fill', this.c(diag === 'error' ? '--error' : '--warning')) }) +
            textLines([diag === 'error' ? '✕' : '!'], {
                x: cx,
                top: cy - r,
                lineHeight: 2 * r,
                font: { family: this.sans, size, weight: 700 },
                fill: this.c('--on-status'),
                anchor: 'middle',
                measure: this.measure,
            })
        );
    }

    /** An internal transition: a row of a state's compartment, its command (and its events under it). */
    internal(x: number, y: number, p: InternalProps): string {
        const out: string[] = [];
        if (p.change === 'added' || p.change === 'changed')
            out.push(
                tag('rect', {
                    x: x + 1,
                    y: y + 1,
                    width: p.w - 2,
                    height: p.h - 2,
                    rx: 3,
                    fill: 'none',
                    ...paint('stroke', this.c(p.change === 'added' ? '--added' : '--changed')),
                    'stroke-width': 2,
                }),
            );
        const extra: Attrs = { 'text-decoration': p.change === 'removed' ? 'line-through' : undefined };
        out.push(
            textLines([`↻ ${p.label}`], {
                x: x + 6,
                top: y,
                lineHeight: 21,
                font: { family: this.sans, size: 14 },
                fill: this.c(p.faded ? '--muted' : '--model-edge-label'),
                extra,
                measure: this.measure,
            }),
        );
        if (p.sub) {
            const font: Font = { family: this.sans, size: 14 * 0.85 };
            out.push(
                textLines([p.sub], { x: x + 6 + 1.2 * font.size, top: y + 21, lineHeight: 15, font, fill: this.c('--muted'), extra, measure: this.measure }),
            );
        }
        if (p.diag !== 'none') out.push(this.diag(x + p.w - 4 - 8, y + 2 + 8, 8, 11, p.diag));
        return tag('g', { opacity: p.change === 'removed' ? 0.55 : undefined }, out.join(''));
    }

    /** An edge along its route, its head and its label (with a halo of the paper, drawn under it). */
    edge(x: number, y: number, p: EdgeProps): string {
        if (p.points.length < 2) return '';
        const look = edgeLook(p.kind, p.tone, p.resolved);
        const d = p.points.map((pt, i) => `${i ? 'L' : 'M'}${num(x + pt.x)},${num(y + pt.y)}`).join(' ');
        const out = [
            tag('path', {
                d,
                fill: 'none',
                ...paint('stroke', this.c(look.stroke)),
                'stroke-width': look.width,
                'stroke-dasharray': look.dash,
                'marker-end': isUndirectedEdge(p.kind) ? undefined : this.markers.arrow(look.head),
                'marker-start': p.kind === 'owns' ? this.markers.diamond() : undefined,
            }),
        ];
        if (p.label && p.lw > 0) out.push(this.edgeLabel(x, y, p, look));
        return tag('g', {}, out.join(''));
    }

    private edgeLabel(x: number, y: number, p: EdgeProps, look: EdgeLook): string {
        const cx = x + p.lx + p.lw / 2;
        const top = y + p.ly + (p.lh - (TRANSITION_LINE_HEIGHT + (p.sub ? TRANSITION_SUB_LINE_HEIGHT : 0)) * p.scale) / 2;
        const lines: { text: string; centre: number; font: Font; fill: Rgba }[] = [
            {
                text: p.label,
                centre: top + (TRANSITION_LINE_HEIGHT / 2) * p.scale,
                font: { family: this.sans, size: 13 * p.scale, weight: look.bold ? 600 : undefined },
                fill: this.c(p.kind === 'transition' && p.faded ? '--muted' : look.label),
            },
        ];
        if (p.sub)
            lines.push({
                text: p.sub,
                centre: top + (TRANSITION_LINE_HEIGHT + TRANSITION_SUB_LINE_HEIGHT / 2) * p.scale,
                font: { family: this.sans, size: 13 * TRANSITION_SUB_SIZE * p.scale },
                fill: this.c(p.kind === 'transition' ? '--muted' : look.label),
            });
        return lines
            .map((l) => {
                const { ascent, descent } = this.measure.metrics(l.font);
                const at = { x: cx, y: l.centre + (ascent - descent) / 2, ...fontAttrs(l.font), 'text-anchor': 'middle' };
                // the halo: the same text stroked in the paper's colour, under it (paint-order is not read everywhere)
                return (
                    tag(
                        'text',
                        { ...at, ...paint('fill', this.paper), ...paint('stroke', this.paper), 'stroke-width': 4, 'stroke-linejoin': 'round' },
                        xml(l.text),
                    ) + tag('text', { ...at, ...paint('fill', l.fill) }, xml(l.text))
                );
            })
            .join('');
    }

    /** The heading line, its top-left at (`x`, `y`); its width and height. */
    heading(text: string, x: number, y: number): { svg: string; w: number; h: number } {
        const font: Font = { family: this.sans, size: HEADING_SIZE };
        const h = this.lineHeight(font);
        return {
            svg: textLines([text], { x, top: y, lineHeight: h, font, fill: this.c('--text-secondary'), measure: this.measure }),
            w: this.measure.width(text, font),
            h,
        };
    }

    /** The size the legend takes (`legend`). */
    legendSize(legend: NonNullable<PortableSvgInput['legend']>): { w: number; h: number } {
        return this.legendLayout(legend, 0, 0).box;
    }

    /** The legend (`.legend`), its top-left at (`x`, `y`): its title, its rows, its notes and its kinds of note. */
    legend(legend: NonNullable<PortableSvgInput['legend']>, x: number, y: number): string {
        return this.legendLayout(legend, x, y).svg;
    }

    private legendLayout(legend: NonNullable<PortableSvgInput['legend']>, x: number, y: number): { svg: string; box: { w: number; h: number } } {
        const { content } = legend;
        const pad = { x: 12, y: 8 };
        const font: Font = { family: this.sans, size: 12 };
        const bold: Font = { ...font, weight: 700 };
        const chip: Font = { ...font, weight: 600 };
        const noteH = this.lineHeight(font);
        const inner = { x: x + pad.x, y: y + pad.y };
        const out: string[] = [];
        let top = inner.y;
        let width = this.measure.width(legend.title, bold);
        out.push(textLines([legend.title], { x: inner.x, top, lineHeight: 20, font: bold, fill: this.c('--muted'), measure: this.measure }));
        top += 22;
        for (const r of content.rows) {
            out.push(this.legendSample(r.kind, inner.x, top + 3));
            out.push(textLines([r.text], { x: inner.x + 64, top, lineHeight: 20, font, fill: this.c('--text'), measure: this.measure }));
            width = Math.max(width, 64 + this.measure.width(r.text, font));
            top += 20;
        }
        const note = (text: string): void => {
            top += 2;
            out.push(textLines([text], { x: inner.x, top, lineHeight: noteH, font, fill: this.c('--muted'), measure: this.measure }));
            width = Math.max(width, this.measure.width(text, font));
            top += noteH;
        };
        content.notes.forEach(note);
        if (content.kinds.length) {
            // the chips wrap at 22rem, as `.legend-kinds` does
            const max = 352;
            top += 6;
            let cx = 0;
            let rowTop = top;
            for (const k of content.kinds) {
                const name = legend.kindNames[k] ?? k;
                const w = this.measure.width(name, chip) + 12 + 2 + (k === 'resolvedHotspot' ? CHIP_CHECK + 4 : 0);
                if (cx > 0 && cx + w > max) {
                    cx = 0;
                    rowTop += 20 + 4;
                }
                out.push(this.legendChip(k, name, inner.x + cx, rowTop, w, chip));
                width = Math.max(width, cx + w);
                cx += w + 4;
            }
            top = rowTop + 20 + 4;
        }
        note(content.arrows);
        const box = { w: width + 2 * pad.x, h: top - y + pad.y };
        const frame = borderRect(x, y, box.w, box.h, 8, { fill: this.c('--legend-bg'), stroke: this.c('--border'), width: 1 });
        return { svg: tag('g', {}, frame + out.join('')), box };
    }

    /** A row's sample of its edge (56 × 14, as the legend draws it). */
    private legendSample(kind: string, x: number, y: number): string {
        const look = edgeLook(kind, 'normal');
        const out = [
            tag('path', {
                d: `M${num(x + 4)},${num(y + 7)} L${num(x + 42)},${num(y + 7)}`,
                fill: 'none',
                ...paint('stroke', this.c(look.stroke)),
                'stroke-width': look.width,
                'stroke-dasharray': look.dash,
            }),
        ];
        if (kind === 'owns')
            out.push(
                tag('path', {
                    d: `M${num(x + 2)},${num(y + 7)} L${num(x + 9)},${num(y + 3.5)} L${num(x + 16)},${num(y + 7)} L${num(x + 9)},${num(y + 10.5)} Z`,
                    ...paint('fill', this.c('--model-ink')),
                }),
            );
        if (!isUndirectedEdge(kind))
            out.push(
                tag('path', {
                    d: `M${num(x + 54)},${num(y + 7)} L${num(x + 41)},${num(y + 0.5)} L${num(x + 41)},${num(y + 13.5)} Z`,
                    ...paint('fill', this.c(look.head)),
                }),
            );
        return out.join('');
    }

    /** A kind of note in the legend (`.kind-es-<kind>`): its paper, edge and text; a resolved hotspot's check before its name. */
    private legendChip(kind: string, name: string, x: number, y: number, w: number, font: Font): string {
        const resolved = kind === 'resolvedHotspot';
        const look: { paper: PaletteVar; border: PaletteVar; text: PaletteVar; dashed?: boolean; round?: boolean } =
            kind === 'group'
                ? { paper: '--es-group-bg', border: '--es-group-border', text: '--es-group-text', dashed: true }
                : kind === 'stage'
                  ? { paper: '--context-bg', border: '--model-context', text: '--text-secondary' }
                  : resolved
                    ? RESOLVED_NOTE
                    : { ...noteVars(`es${kind}`), dashed: kind === 'external', round: kind === 'actor' };
        const mark = resolved ? CHIP_CHECK + 4 : 0;
        return (
            borderRect(x, y, w, 20, look.round ? 10 : 4, {
                fill: this.c(look.paper),
                stroke: this.c(look.border),
                width: 1,
                dash: look.dashed ? dashed(1) : undefined,
            }) +
            (resolved ? this.check(x + 7 + CHIP_CHECK / 2, y + 10, CHIP_CHECK / 2, 1.6) : '') +
            textLines([name], { x: x + (w + mark) / 2, top: y + 1, lineHeight: 18, font, fill: this.c(look.text), anchor: 'middle', measure: this.measure })
        );
    }
}

/**
 * The scene as a portable SVG on its paper (white unless given): the heading (if any) at the top, the diagram, and
 * the legend (if any) under it at the left, with a margin around all. Its size is in px of the page (1 px per layout
 * unit).
 */
/** How faint an item off the path of the exception emphasized is drawn (`.diagram-dimmed` in styles.css). */
export const DIMMED_OPACITY = 0.28;

/** An item's drawing, faint when it is off the path of the exception emphasized. */
const faint = (dimmed: true | undefined, svg: string): string => (dimmed && svg ? tag('g', { opacity: DIMMED_OPACITY }, svg) : svg);

export function portableSvg(input: PortableSvgInput): PortableSvg {
    const { scene, bounds, palette, fonts, measure } = input;
    const paper = input.paper ?? PAPER;
    const draw = new Drawing(palette, fonts, measure, paper);
    const parts: string[] = [];
    let top = MARGIN;
    let width = bounds.w;
    if (input.heading) {
        const heading = draw.heading(input.heading, MARGIN, top);
        parts.push(heading.svg);
        width = Math.max(width, heading.w);
        top += heading.h + GAP;
    }
    const items = sceneItems(scene).map((item) => {
        if (item.type === 'group') return faint(item.props.dimmed, draw.group(item.x, item.y, item.props));
        // a hidden resolved hotspot: not drawn (its sticky's check stands for it)
        if (item.type === 'node' && item.on !== undefined) return '';
        if (item.type === 'node') return faint(item.props.dimmed, draw.node(item.x, item.y, item.props));
        if (item.type === 'internal') return draw.internal(item.x, item.y, item.props);
        return faint(item.props.dimmed, draw.edge(item.x, item.y, item.props));
    });
    parts.push(tag('g', { transform: `translate(${num(MARGIN - bounds.x)},${num(top - bounds.y)})` }, items.join('')));
    top += bounds.h;
    if (input.legend) {
        top += GAP;
        const size = draw.legendSize(input.legend);
        parts.push(draw.legend(input.legend, MARGIN, top));
        width = Math.max(width, size.w);
        top += size.h;
    }
    const w = Math.ceil(width + 2 * MARGIN);
    const h = Math.ceil(top + MARGIN);
    const svg =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        tag(
            'svg',
            { xmlns: 'http://www.w3.org/2000/svg', width: w, height: h, viewBox: `0 0 ${w} ${h}` },
            tag('defs', {}, draw.markers.toString()) + tag('rect', { width: w, height: h, ...paint('fill', paper) }) + parts.join(''),
        );
    return { svg, width: w, height: h };
}
