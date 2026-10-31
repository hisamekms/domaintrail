import { Fragment } from 'react';
import { TRANSITION_LINE_HEIGHT, TRANSITION_SUB_LINE_HEIGHT, TRANSITION_SUB_SIZE } from '../src/graph/ir';
import {
    BaseBoxShapeUtil,
    HTMLContainer,
    Polyline2d,
    SVGContainer,
    ShapeUtil,
    T,
    Vec,
    useEditor,
    useValue,
    type Editor,
    type RecordProps,
    type TLShape,
} from 'tldraw';

export type ChangeMark = 'none' | 'added' | 'changed' | 'removed';
export type DiagMark = 'none' | 'warning' | 'error';

declare module '@tldraw/tlschema' {
    interface TLGlobalShapePropsMap {
        'domain-node': {
            w: number;
            h: number;
            kind: string;
            label: string;
            stereotype: string;
            /** Text size factor (1 = normal; the Structure overview uses larger text). */
            scale: number;
            /** Body rows; `v` is empty for rows without a value column; `c`: the row's change from the baseline. */
            rows: { k: string; v: string; o?: string; c?: string }[];
            /** Height of the internal transitions' compartment at the bottom (0 = none); its rows are shapes of their own. */
            compartment: number;
            change: ChangeMark;
            /** The change badge's text (in the Live View's language), empty without one. */
            badge: string;
            diag: DiagMark;
        };
        'domain-internal': {
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
        };
        'domain-edge': {
            /** Route relative to the shape origin, as computed by the layout engine. */
            points: { x: number; y: number }[];
            kind: string;
            label: string;
            /** A smaller second line of the label (a transition's events), and whether the label is faded (a transition's command in place of missing events). */
            sub: string;
            faded: boolean;
            scale: number;
            /** Label box relative to the shape origin; w = 0 when there is no label. */
            lx: number;
            ly: number;
            lw: number;
            lh: number;
            tone: EdgeTone;
        };
        'domain-group': {
            w: number;
            h: number;
            kind: string;
            label: string;
            /** Description rows under the label (contexts at the aggregates level). */
            lines: string[];
            scale: number;
            change: ChangeMark;
            diag: DiagMark;
        };
    }
}

export type DomainNodeShape = TLShape<'domain-node'>;
export type DomainGroupShape = TLShape<'domain-group'>;
export type DomainEdgeShape = TLShape<'domain-edge'>;
export type DomainInternalShape = TLShape<'domain-internal'>;
export type EdgeTone = 'normal' | 'added' | 'changed' | 'error';

const changeMark = T.literalEnum('none', 'added', 'changed', 'removed');
const diagMark = T.literalEnum('none', 'warning', 'error');

/** A model element (aggregate root, entity, value object, state). Read-only in the MVP. */
export class DomainNodeUtil extends BaseBoxShapeUtil<DomainNodeShape> {
    static override type = 'domain-node' as const;
    static override props: RecordProps<DomainNodeShape> = {
        w: T.number,
        h: T.number,
        kind: T.string,
        scale: T.number,
        label: T.string,
        stereotype: T.string,
        /** `o`: the field set a field comes from, shown faded after its type. */
        rows: T.arrayOf(T.object({ k: T.string, v: T.string, o: T.string.optional(), c: T.string.optional() })),
        compartment: T.number,
        change: changeMark,
        badge: T.string,
        diag: diagMark,
    };

    getDefaultProps(): DomainNodeShape['props'] {
        return { w: 160, h: 60, kind: 'entity', label: '', stereotype: '', scale: 1, rows: [], compartment: 0, change: 'none', badge: '', diag: 'none' };
    }

    override canResize = () => false;
    override hideRotateHandle = () => true;
    override hideResizeHandles = () => true;
    override canEdit = () => false;
    // the selection is shown by the outline alone (see getIndicatorPath): the bounds box would cross the badges
    override hideSelectionBoundsFg = () => true;

    component(shape: DomainNodeShape) {
        const p = shape.props;
        return (
            <HTMLContainer
                className={`dn dn-${p.kind} dn-change-${p.change} dn-diag-${p.diag}`}
                style={{ width: p.w, height: p.h, ['--s' as string]: p.scale }}
            >
                {p.kind === 'initial' ? (
                    <div className="dn-initial">{p.label}</div>
                ) : (
                    <>
                        <div className="dn-head">
                            {p.stereotype && <div className="dn-stereo">{p.stereotype}</div>}
                            <div className="dn-label">{p.label}</div>
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
                        {(p.badge || p.diag !== 'none') && <EdgeMarks badge={p.badge} diag={p.diag} />}
                    </>
                )}
            </HTMLContainer>
        );
    }

    /** The outline, going around the change badge and the diagnostic mark on the edge instead of crossing them. */
    getIndicatorPath(shape: DomainNodeShape) {
        const p = shape.props;
        if (p.kind === 'initial' || (!p.badge && p.diag === 'none')) return roundRect(p.w, p.h, 8);
        return outlineAround(p.w, p.h, 8, p.badge ? badgeWidth(p.badge) : 0, p.diag !== 'none', markScale(this.editor));
    }
}

/** A command that leaves a state as it is: a row in the state's compartment (a UML internal transition). */
export class DomainInternalUtil extends BaseBoxShapeUtil<DomainInternalShape> {
    static override type = 'domain-internal' as const;
    static override props: RecordProps<DomainInternalShape> = {
        w: T.number,
        h: T.number,
        label: T.string,
        sub: T.string,
        faded: T.boolean,
        scale: T.number,
        change: changeMark,
        diag: diagMark,
    };

    getDefaultProps(): DomainInternalShape['props'] {
        return { w: 160, h: 21, label: '', sub: '', faded: false, scale: 1, change: 'none', diag: 'none' };
    }

    override canResize = () => false;
    override hideRotateHandle = () => true;
    override hideResizeHandles = () => true;
    override canEdit = () => false;

    component(shape: DomainInternalShape) {
        const p = shape.props;
        return (
            <HTMLContainer className={`di di-change-${p.change} di-diag-${p.diag}`} style={{ width: p.w, height: p.h, ['--s' as string]: p.scale }}>
                <div className={`di-main${p.faded ? ' di-faded' : ''}`}>↻ {p.label}</div>
                {p.sub && <div className="di-sub">{p.sub}</div>}
                {p.diag !== 'none' && <div className="di-diag">{p.diag === 'error' ? '✕' : '!'}</div>}
            </HTMLContainer>
        );
    }

    getIndicatorPath(shape: DomainInternalShape) {
        return roundRect(shape.props.w, shape.props.h, 4);
    }
}

/** A container: bounded context or aggregate boundary. Drawn behind nodes; not a tldraw frame (no clipping). */
export class DomainGroupUtil extends BaseBoxShapeUtil<DomainGroupShape> {
    static override type = 'domain-group' as const;
    static override props: RecordProps<DomainGroupShape> = {
        w: T.number,
        h: T.number,
        kind: T.string,
        scale: T.number,
        label: T.string,
        lines: T.arrayOf(T.string),
        change: changeMark,
        diag: diagMark,
    };

    getDefaultProps(): DomainGroupShape['props'] {
        return { w: 200, h: 100, kind: 'context', label: '', lines: [], scale: 1, change: 'none', diag: 'none' };
    }

    override canResize = () => false;
    override hideRotateHandle = () => true;
    override hideResizeHandles = () => true;
    override canEdit = () => false;

    component(shape: DomainGroupShape) {
        const p = shape.props;
        return (
            <HTMLContainer
                className={`dg dg-${p.kind} dn-change-${p.change} dn-diag-${p.diag}`}
                style={{ width: p.w, height: p.h, ['--s' as string]: p.scale }}
            >
                <div className="dg-label">{p.label}</div>
                {p.lines.length > 0 && (
                    <div className="dg-desc">
                        {p.lines.map((l, i) => (
                            <div key={i}>{l}</div>
                        ))}
                    </div>
                )}
            </HTMLContainer>
        );
    }

    getIndicatorPath(shape: DomainGroupShape) {
        return roundRect(shape.props.w, shape.props.h, 12);
    }
}

/**
 * An edge drawn exactly along the route computed by the layout engine (including bends and label position).
 * tldraw's bound arrows re-route themselves and cannot follow multi-bend routes, so they are not used here.
 */
export class DomainEdgeUtil extends ShapeUtil<DomainEdgeShape> {
    static override type = 'domain-edge' as const;
    static override props: RecordProps<DomainEdgeShape> = {
        points: T.arrayOf(T.object({ x: T.number, y: T.number })),
        kind: T.string,
        scale: T.number,
        label: T.string,
        sub: T.string,
        faded: T.boolean,
        lx: T.number,
        ly: T.number,
        lw: T.number,
        lh: T.number,
        tone: T.literalEnum('normal', 'added', 'changed', 'error'),
    };

    getDefaultProps(): DomainEdgeShape['props'] {
        return { points: [], kind: 'owns', label: '', sub: '', faded: false, scale: 1, lx: 0, ly: 0, lw: 0, lh: 0, tone: 'normal' };
    }

    override canResize = () => false;
    override hideRotateHandle = () => true;
    override hideResizeHandles = () => true;
    override canEdit = () => false;
    override canBind = () => false;

    getGeometry(shape: DomainEdgeShape) {
        const pts =
            shape.props.points.length >= 2
                ? shape.props.points
                : [
                      { x: 0, y: 0 },
                      { x: 1, y: 1 },
                  ];
        return new Polyline2d({ points: pts.map((p) => new Vec(p.x, p.y)) });
    }

    component(shape: DomainEdgeShape) {
        const { points, kind, label, sub, faded, lx, ly, lw, lh, tone, scale } = shape.props;
        if (points.length < 2) return null;
        const d = points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
        const [a, b] = [points[points.length - 2], points[points.length - 1]];
        const [s0, s1] = [points[0], points[1]];
        return (
            <SVGContainer className={`de de-${kind} de-tone-${tone}`}>
                <path d={d} className="de-hit" />
                <path d={d} className="de-line" />
                {kind === 'owns' ? <path d={diamond(s0, s1)} className="de-head de-diamond" /> : null}
                {/* every edge points from the dependent to its dependency */}
                {kind === 'esHotspot' ? null : <path d={arrowHead(a, b)} className="de-head" />}
                {label && lw > 0 && <EdgeLabel {...{ label, sub, faded, lx, ly, lw, lh, scale }} />}
            </SVGContainer>
        );
    }

    getIndicatorPath(shape: DomainEdgeShape) {
        const p = new Path2D();
        shape.props.points.forEach((pt, i) => (i ? p.lineTo(pt.x, pt.y) : p.moveTo(pt.x, pt.y)));
        return p;
    }
}

/** An edge's label, centred in its box; a second, smaller line (a transition's events) goes under the first. */
function EdgeLabel({
    label,
    sub,
    faded,
    lx,
    ly,
    lw,
    lh,
    scale,
}: Pick<DomainEdgeShape['props'], 'label' | 'sub' | 'faded' | 'lx' | 'ly' | 'lw' | 'lh' | 'scale'>) {
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

type P = { x: number; y: number };

function unit(from: P, to: P): P {
    const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    return { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
}

const ARROW_LENGTH = 13;

/** Filled triangle ending at `tip`, pointing along from -> tip. */
function arrowHead(from: P, tip: P): string {
    const u = unit(from, tip);
    const n = { x: -u.y, y: u.x };
    const base = { x: tip.x - u.x * ARROW_LENGTH, y: tip.y - u.y * ARROW_LENGTH };
    const w = ARROW_LENGTH / 2;
    return `M${tip.x},${tip.y} L${base.x + n.x * w},${base.y + n.y * w} L${base.x - n.x * w},${base.y - n.y * w} Z`;
}

/** UML composition diamond at `start`, pointing away from the owner. */
function diamond(start: P, next: P): string {
    const u = unit(start, next);
    const n = { x: -u.y, y: u.x };
    const mid = { x: start.x + u.x * 7, y: start.y + u.y * 7 };
    const end = { x: start.x + u.x * 14, y: start.y + u.y * 14 };
    return `M${start.x},${start.y} L${mid.x + n.x * 4.5},${mid.y + n.y * 4.5} L${end.x},${end.y} L${mid.x - n.x * 4.5},${mid.y - n.y * 4.5} Z`;
}

function roundRect(w: number, h: number, r: number): Path2D {
    const p = new Path2D();
    p.roundRect(0, 0, w, h, r);
    return p;
}

/** Where the change badge and the diagnostic mark sit on a node's edge (see .dn-badge and .dn-diag), and the gap the outline leaves around them. */
const BADGE = { left: 8, bottom: 7, height: 17, padding: 6, cjk: 12, latin: 7.2 };
const DIAG_RADIUS = 9;
const OUTLINE_GAP = 2;
/** The marks grow when zoomed out, to stay about their size on the screen, up to this factor. */
const MAX_MARK_SCALE = 3;

/** How much the change badge and the diagnostic mark are enlarged at the editor's zoom (1 from 100% up). */
const markScale = (editor: Editor): number => Math.min(MAX_MARK_SCALE, Math.max(1, 1 / editor.getZoomLevel()));

/**
 * The change badge and the diagnostic mark on a node's edge, enlarged when zoomed out (a component of its own, so that
 * only nodes with marks follow the zoom). The badge grows from its bottom-left corner, the mark from its centre.
 */
function EdgeMarks({ badge, diag }: { badge: string; diag: DiagMark }) {
    const editor = useEditor();
    const k = useValue('mark scale', () => markScale(editor), [editor]);
    const grow = k === 1 ? undefined : `scale(${k})`;
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

/** The badge's width, from its text (12px: full-width characters 12px, others about 7px) and padding. */
const badgeWidth = (text: string): number =>
    2 * BADGE.padding + text.split('').reduce((w, ch) => w + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? BADGE.cjk : BADGE.latin), 0);

/**
 * A rounded rectangle whose top edge steps out around the badge (`badge` wide, when there is one) and whose top-right
 * corner steps out around the diagnostic mark (`diag`), both enlarged `k` times.
 */
function outlineAround(w: number, h: number, r: number, badge: number, diag: boolean, k: number): Path2D {
    const g = OUTLINE_GAP;
    const p = new Path2D();
    p.moveTo(r, 0);
    if (badge) {
        const [x0, x1, y] = [BADGE.left - g, BADGE.left + badge * k + g, BADGE.bottom - BADGE.height * k - g];
        p.lineTo(x0, 0);
        p.lineTo(x0, y);
        p.lineTo(x1, y);
        p.lineTo(x1, 0);
    }
    if (diag) {
        const d = DIAG_RADIUS * k + g;
        p.lineTo(w - d, 0);
        p.lineTo(w - d, -d);
        p.lineTo(w + d, -d);
        p.lineTo(w + d, d);
        p.lineTo(w, d);
    } else {
        p.lineTo(w - r, 0);
        p.arcTo(w, 0, w, r, r);
    }
    p.lineTo(w, h - r);
    p.arcTo(w, h, w - r, h, r);
    p.lineTo(r, h);
    p.arcTo(0, h, 0, h - r, r);
    p.lineTo(0, r);
    p.arcTo(0, 0, r, 0, r);
    p.closePath();
    return p;
}

export const shapeUtils = [DomainNodeUtil, DomainGroupUtil, DomainInternalUtil, DomainEdgeUtil];
