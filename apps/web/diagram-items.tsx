// What the canvas draws for each kind of scene item (`scene.ts`), independent of the canvas library: the classes and
// size of an item's box, what goes in it, and the outline drawn around it while it is hovered or selected. A canvas
// wraps each in its own container (React Flow's custom nodes and edges in `view/flow-canvas.tsx`), at the item's place
// on the page.
import { Fragment, useLayoutEffect, useReducer, useRef, useSyncExternalStore, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import { TRANSITION_LINE_HEIGHT, TRANSITION_SUB_LINE_HEIGHT, TRANSITION_SUB_SIZE } from '@domaintrail/visualization';
import type { DiagMark, EdgeProps, GroupProps, InternalProps, NodeProps, Point } from './scene';
import { fitKey, fitLabel, fontLoadCount, NOTE_KINDS, rememberedFit, rememberFit, subscribeFonts, type LabelFit } from './note-fit';
import { TOOLTIP_ATTR } from './tooltip';

/** A box's size and text scale (`--s`), as its CSS expects them. */
const boxStyle = (p: { w: number; h: number; scale: number }): CSSProperties => ({ width: p.w, height: p.h, ['--s' as string]: p.scale });

/**
 * The classes of a node's box. `selected` draws the local selection as a ring outside it (`.dn-selected`): an outline
 * on the node's edge would be lost against an edge of the same hue (an aggregate root's indigo, a command's blue).
 */
export const nodeClassName = (p: NodeProps, selected: boolean): string =>
    `dn dn-${p.kind} dn-change-${p.change} dn-diag-${p.diag}${selected ? ' dn-selected' : ''}`;
export const nodeStyle = boxStyle;

/** The change badge and the diagnostic mark on a node's edge, drawn by `EdgeMarks` (or a canvas's wrapper of it). */
export type MarksComponent = ComponentType<{ badge: string; diag: DiagMark }>;

/** A model element (aggregate root, entity, value object, state): its heading, rows, compartment and marks. */
export function NodeContent({ p, Marks }: { p: NodeProps; Marks: MarksComponent }): ReactNode {
    if (p.kind === 'initial') return <div className="dn-initial">{p.label}</div>;
    return (
        <>
            <div className="dn-head">
                {p.stereotype && <div className="dn-stereo">{p.stereotype}</div>}
                {NOTE_KINDS.has(p.kind) ? <NoteLabel p={p} /> : <div className="dn-label">{p.label}</div>}
            </div>
            {p.rows.length > 0 && (
                <div className="dn-body">
                    {p.rows.map((r, i) =>
                        r.v ? (
                            <Fragment key={i}>
                                <span className={`dn-key${r.c ? ` dn-row-${r.c}` : ''}`}>{r.k}</span>
                                <span className={`dn-value${r.c ? ` dn-row-${r.c}` : ''}`}>
                                    {r.v}
                                    {r.o && <span className="dn-origin">{r.o}</span>}
                                </span>
                            </Fragment>
                        ) : (
                            <span key={i} className={`dn-key dn-full${r.c ? ` dn-row-${r.c}` : ''}`}>
                                {r.k}
                            </span>
                        ),
                    )}
                </div>
            )}
            {p.compartment > 0 && <div className="dn-compartment" style={{ height: p.compartment }} />}
            {(p.badge || p.diag !== 'none') && <Marks badge={p.badge} diag={p.diag} />}
        </>
    );
}

/**
 * A sticky note's label, fitted to the note (`note-fit.ts`): measured once per label, note size and fonts loaded, as
 * the browser wraps it, and not again on pan or zoom. Clamped, it shows the whole label on hover.
 */
function NoteLabel({ p }: { p: NodeProps }): ReactNode {
    const ref = useRef<HTMLDivElement>(null);
    const fonts = useSyncExternalStore(subscribeFonts, fontLoadCount, fontLoadCount);
    const [, measured] = useReducer((n: number) => n + 1, 0);
    const key = fitKey(p.label, p.w, p.h, p.scale, fonts);
    useLayoutEffect(() => {
        if (!ref.current || rememberedFit(key)) return;
        const fit = measureLabel(ref.current, p.scale);
        if (!fit) return;
        rememberFit(key, fit);
        measured();
    }, [key, p.scale]);
    const fit = rememberedFit(key);
    const style: CSSProperties | undefined = fit && {
        fontSize: fit.fontSize,
        lineHeight: `${fit.lineHeight}px`,
        ...(fit.clamp ? { WebkitLineClamp: fit.clamp } : {}),
    };
    return (
        <div ref={ref} className={fit?.clamp ? 'dn-label dn-label-clamped' : 'dn-label'} style={style} {...(fit?.clamp ? { [TOOLTIP_ATTR]: p.label } : {})}>
            {p.label}
        </div>
    );
}

/**
 * The fit of a note's label (`label`, in its `.dn-head`), measured on a hidden copy of it as wide as it is: its room is
 * the head's height less its padding and the stereotype. None while the note is not laid out (a hidden view).
 */
function measureLabel(label: HTMLElement, scale: number): LabelFit | undefined {
    const head = label.parentElement;
    if (!head || head.clientHeight === 0 || label.clientWidth === 0) return undefined;
    const padding = getComputedStyle(head);
    const stereotype = label.previousElementSibling instanceof HTMLElement ? label.previousElementSibling.offsetHeight : 0;
    const room = head.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom) - stereotype;
    const probe = document.createElement('div');
    probe.className = 'dn-label';
    probe.textContent = label.textContent;
    Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', left: '0', top: '0', width: `${label.clientWidth}px` });
    head.appendChild(probe);
    try {
        return fitLabel(
            (fontSize, lineHeight) => {
                probe.style.fontSize = `${fontSize}px`;
                probe.style.lineHeight = `${lineHeight}px`;
                return probe.scrollHeight;
            },
            room,
            scale,
        );
    } finally {
        probe.remove();
    }
}

export const internalClassName = (p: InternalProps): string => `di di-change-${p.change} di-diag-${p.diag}`;
export const internalStyle = boxStyle;

/** A command that leaves a state as it is: a row in the state's compartment (a UML internal transition). */
export function InternalContent({ p }: { p: InternalProps }): ReactNode {
    return (
        <>
            <div className={`di-main${p.faded ? ' di-faded' : ''}`}>↻ {p.label}</div>
            {p.sub && <div className="di-sub">{p.sub}</div>}
            {p.diag !== 'none' && <div className="di-diag">{p.diag === 'error' ? '✕' : '!'}</div>}
        </>
    );
}

export const groupClassName = (p: GroupProps, selected: boolean): string =>
    `dg dg-${p.kind} dn-change-${p.change} dn-diag-${p.diag}${selected ? ' dn-selected' : ''}`;
export const groupStyle = boxStyle;

/** A container (bounded context, aggregate boundary): its label and description rows. Drawn behind nodes. */
export function GroupContent({ p }: { p: GroupProps }): ReactNode {
    return (
        <>
            <div className="dg-label">{p.label}</div>
            {p.lines.length > 0 && (
                <div className="dg-desc">
                    {p.lines.map((l, i) => (
                        <div key={i}>{l}</div>
                    ))}
                </div>
            )}
        </>
    );
}

/** The classes of an edge's `<svg>`. */
export const edgeClassName = (p: EdgeProps): string => `de de-${p.kind} de-tone-${p.tone}`;

/**
 * An edge drawn exactly along the route computed by the layout engine (including bends and label position), in the
 * coordinates of its `<svg>` (the item's origin): a wide transparent hit path, the line, its heads and its label.
 */
export function EdgeContent({ p }: { p: EdgeProps }): ReactNode {
    const { points, kind, label, sub, faded, lx, ly, lw, lh, scale } = p;
    if (points.length < 2) return null;
    const d = edgeOutlinePath(points);
    const [a, b] = [points[points.length - 2], points[points.length - 1]];
    const [s0, s1] = [points[0], points[1]];
    return (
        <>
            <path d={d} className="de-hit" />
            <path d={d} className="de-line" />
            {kind === 'owns' ? <path d={diamond(s0, s1)} className="de-head de-diamond" /> : null}
            {/* every edge points from the dependent to its dependency */}
            {kind === 'esHotspot' ? null : <path d={arrowHead(a, b)} className="de-head" />}
            {label && lw > 0 && <EdgeLabel {...{ label, sub, faded, lx, ly, lw, lh, scale }} />}
        </>
    );
}

/** An edge's label, centred in its box; a second, smaller line (a transition's events) goes under the first. */
function EdgeLabel({ label, sub, faded, lx, ly, lw, lh, scale }: Pick<EdgeProps, 'label' | 'sub' | 'faded' | 'lx' | 'ly' | 'lw' | 'lh' | 'scale'>): ReactNode {
    const x = lx + lw / 2;
    const top = ly + (lh - (TRANSITION_LINE_HEIGHT + (sub ? TRANSITION_SUB_LINE_HEIGHT : 0)) * scale) / 2;
    return (
        <>
            <text
                x={x}
                y={top + (TRANSITION_LINE_HEIGHT / 2) * scale}
                className={`de-label${faded ? ' de-faded' : ''}`}
                style={{ fontSize: 13 * scale }}
                textAnchor="middle"
                dominantBaseline="central"
            >
                {label}
            </text>
            {sub && (
                <text
                    x={x}
                    y={top + (TRANSITION_LINE_HEIGHT + TRANSITION_SUB_LINE_HEIGHT / 2) * scale}
                    className="de-label de-sub"
                    style={{ fontSize: 13 * TRANSITION_SUB_SIZE * scale }}
                    textAnchor="middle"
                    dominantBaseline="central"
                >
                    {sub}
                </text>
            )}
        </>
    );
}

function unit(from: Point, to: Point): Point {
    const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    return { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
}

const ARROW_LENGTH = 13;

/** Filled triangle ending at `tip`, pointing along from -> tip. */
function arrowHead(from: Point, tip: Point): string {
    const u = unit(from, tip);
    const n = { x: -u.y, y: u.x };
    const base = { x: tip.x - u.x * ARROW_LENGTH, y: tip.y - u.y * ARROW_LENGTH };
    const w = ARROW_LENGTH / 2;
    return `M${tip.x},${tip.y} L${base.x + n.x * w},${base.y + n.y * w} L${base.x - n.x * w},${base.y - n.y * w} Z`;
}

/** UML composition diamond at `start`, pointing away from the owner. */
function diamond(start: Point, next: Point): string {
    const u = unit(start, next);
    const n = { x: -u.y, y: u.x };
    const mid = { x: start.x + u.x * 7, y: start.y + u.y * 7 };
    const end = { x: start.x + u.x * 14, y: start.y + u.y * 14 };
    return `M${start.x},${start.y} L${mid.x + n.x * 4.5},${mid.y + n.y * 4.5} L${end.x},${end.y} L${mid.x - n.x * 4.5},${mid.y - n.y * 4.5} Z`;
}

/** Where the change badge and the diagnostic mark sit on a node's edge (see .dn-badge and .dn-diag). */
export const BADGE = { left: 8, bottom: 7, height: 17, padding: 6, cjk: 12, latin: 7.2 };
export const DIAG_RADIUS = 9;
/** The marks grow when zoomed out, to stay about their size on the screen, up to this factor. */
const MAX_MARK_SCALE = 3;

/** How much the change badge and the diagnostic mark are enlarged at `zoom` (1 from 100% up). */
export const markScale = (zoom: number): number => Math.min(MAX_MARK_SCALE, Math.max(1, 1 / zoom));

/** The badge's width, from its text (12px: full-width characters 12px, others about 7px) and padding. */
export const badgeWidth = (text: string): number =>
    2 * BADGE.padding + text.split('').reduce((w, ch) => w + (/[　-鿿＀-￯]/.test(ch) ? BADGE.cjk : BADGE.latin), 0);

/**
 * The change badge and the diagnostic mark on a node's edge, enlarged `scale` times (`markScale` of the zoom). The
 * badge grows from its bottom-left corner, the mark from its centre.
 */
export function EdgeMarks({ badge, diag, scale }: { badge: string; diag: DiagMark; scale: number }): ReactNode {
    const grow = scale === 1 ? undefined : `scale(${scale})`;
    return (
        <>
            {badge && (
                // sized as the outline expects it
                <div className="dn-badge" style={{ width: badgeWidth(badge), transform: grow }}>
                    {badge}
                </div>
            )}
            {diag !== 'none' && (
                <div className="dn-diag" style={{ transform: grow }}>
                    {diag === 'error' ? '✕' : '!'}
                </div>
            )}
        </>
    );
}

/** An SVG path of a rounded rectangle `w` × `h` with corners of radius `r`, from the origin. */
export function roundRectPath(w: number, h: number, r: number): string {
    return `M${r},0 H${w - r} A${r},${r} 0 0 1 ${w},${r} V${h - r} A${r},${r} 0 0 1 ${w - r},${h} H${r} A${r},${r} 0 0 1 0,${h - r} V${r} A${r},${r} 0 0 1 ${r},0 Z`;
}

/** The gap the outline leaves around the change badge and the diagnostic mark. */
const OUTLINE_GAP = 2;

/**
 * The outline of a node while it is hovered or selected (an SVG path, from the node's top-left corner): a rounded
 * rectangle whose top edge steps out around the change badge and whose top-right corner steps out around the
 * diagnostic mark, both enlarged `k` times (`markScale` of the zoom), instead of crossing them.
 */
export function nodeOutlinePath(p: Pick<NodeProps, 'w' | 'h' | 'kind' | 'badge' | 'diag'>, k: number): string {
    const { w, h } = p;
    const r = 8;
    if (p.kind === 'initial' || (!p.badge && p.diag === 'none')) return roundRectPath(w, h, r);
    const g = OUTLINE_GAP;
    const d: string[] = [`M${r},0`];
    if (p.badge) {
        const [x0, x1, y] = [BADGE.left - g, BADGE.left + badgeWidth(p.badge) * k + g, BADGE.bottom - BADGE.height * k - g];
        d.push(`L${x0},0 L${x0},${y} L${x1},${y} L${x1},0`);
    }
    if (p.diag !== 'none') {
        const m = DIAG_RADIUS * k + g;
        d.push(`L${w - m},0 L${w - m},${-m} L${w + m},${-m} L${w + m},${m} L${w},${m}`);
    } else {
        d.push(`L${w - r},0 A${r},${r} 0 0 1 ${w},${r}`);
    }
    d.push(`L${w},${h - r} A${r},${r} 0 0 1 ${w - r},${h} L${r},${h} A${r},${r} 0 0 1 0,${h - r} L0,${r} A${r},${r} 0 0 1 ${r},0 Z`);
    return d.join(' ');
}

/** The outline of an edge while it is hovered or selected: its route. */
export const edgeOutlinePath = (points: readonly Point[]): string => points.map((pt, i) => `${i ? 'L' : 'M'}${pt.x},${pt.y}`).join(' ');
