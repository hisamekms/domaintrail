import { Fragment } from 'react';
import { useT } from './i18n';
import { BaseBoxShapeUtil, HTMLContainer, Polyline2d, SVGContainer, ShapeUtil, T, Vec, type RecordProps, type TLShape } from 'tldraw';

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
            /** Body rows; `v` is empty for rows without a value column. */
            rows: { k: string; v: string }[];
            change: ChangeMark;
            diag: DiagMark;
        };
        'domain-edge': {
            /** Route relative to the shape origin, as computed by the layout engine. */
            points: { x: number; y: number }[];
            kind: string;
            label: string;
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
            scale: number;
            change: ChangeMark;
            diag: DiagMark;
        };
    }
}

export type DomainNodeShape = TLShape<'domain-node'>;
export type DomainGroupShape = TLShape<'domain-group'>;
export type DomainEdgeShape = TLShape<'domain-edge'>;
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
        rows: T.arrayOf(T.object({ k: T.string, v: T.string })),
        change: changeMark,
        diag: diagMark,
    };

    getDefaultProps(): DomainNodeShape['props'] {
        return { w: 160, h: 60, kind: 'entity', label: '', stereotype: '', scale: 1, rows: [], change: 'none', diag: 'none' };
    }

    override canResize = () => false;
    override hideRotateHandle = () => true;
    override hideResizeHandles = () => true;
    override canEdit = () => false;

    component(shape: DomainNodeShape) {
        const p = shape.props;
        return (
            <HTMLContainer className={`dn dn-${p.kind} dn-change-${p.change} dn-diag-${p.diag}`} style={{ width: p.w, height: p.h, ['--s' as string]: p.scale }}>
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
                                            <span className="dn-key">{r.k}</span>
                                            <span className="dn-value">{r.v}</span>
                                        </Fragment>
                                    ) : (
                                        <span key={i} className="dn-key dn-full">
                                            {r.k}
                                        </span>
                                    ),
                                )}
                            </div>
                        )}
                        {p.change !== 'none' && <ChangeBadge change={p.change} />}
                        {p.diag !== 'none' && <div className="dn-diag">{p.diag === 'error' ? '✕' : '!'}</div>}
                    </>
                )}
            </HTMLContainer>
        );
    }

    getIndicatorPath(shape: DomainNodeShape) {
        return roundRect(shape.props.w, shape.props.h, 8);
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
        change: changeMark,
        diag: diagMark,
    };

    getDefaultProps(): DomainGroupShape['props'] {
        return { w: 200, h: 100, kind: 'context', label: '', scale: 1, change: 'none', diag: 'none' };
    }

    override canResize = () => false;
    override hideRotateHandle = () => true;
    override hideResizeHandles = () => true;
    override canEdit = () => false;

    component(shape: DomainGroupShape) {
        const p = shape.props;
        return (
            <HTMLContainer className={`dg dg-${p.kind} dn-change-${p.change} dn-diag-${p.diag}`} style={{ width: p.w, height: p.h, ['--s' as string]: p.scale }}>
                <div className="dg-label">{p.label}</div>
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
        lx: T.number,
        ly: T.number,
        lw: T.number,
        lh: T.number,
        tone: T.literalEnum('normal', 'added', 'changed', 'error'),
    };

    getDefaultProps(): DomainEdgeShape['props'] {
        return { points: [], kind: 'owns', label: '', scale: 1, lx: 0, ly: 0, lw: 0, lh: 0, tone: 'normal' };
    }

    override canResize = () => false;
    override hideRotateHandle = () => true;
    override hideResizeHandles = () => true;
    override canEdit = () => false;
    override canBind = () => false;

    getGeometry(shape: DomainEdgeShape) {
        const pts = shape.props.points.length >= 2 ? shape.props.points : [{ x: 0, y: 0 }, { x: 1, y: 1 }];
        return new Polyline2d({ points: pts.map((p) => new Vec(p.x, p.y)) });
    }

    component(shape: DomainEdgeShape) {
        const { points, kind, label, lx, ly, lw, lh, tone, scale } = shape.props;
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
                <path d={arrowHead(a, b)} className="de-head" />
                {label && lw > 0 && (
                    <text x={lx + lw / 2} y={ly + lh / 2} className="de-label" style={{ fontSize: 13 * scale }} textAnchor="middle" dominantBaseline="central">
                        {label}
                    </text>
                )}
            </SVGContainer>
        );
    }

    getIndicatorPath(shape: DomainEdgeShape) {
        const p = new Path2D();
        shape.props.points.forEach((pt, i) => (i ? p.lineTo(pt.x, pt.y) : p.moveTo(pt.x, pt.y)));
        return p;
    }
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

function ChangeBadge({ change }: { change: Exclude<ChangeMark, 'none'> }) {
    const t = useT();
    return <div className="dn-badge">{t[change]}</div>;
}

export const shapeUtils = [DomainNodeUtil, DomainGroupUtil, DomainEdgeUtil];
