// The tldraw shapes that draw the scene's items (`scene.ts`): thin wrappers around the library-neutral components of
// `diagram-items.tsx`, with tldraw's geometry, selection outline and options. Only this file and `view/tldraw-canvas.tsx`
// know tldraw (see apps/web/canvas-boundary.test.ts).
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
    type TLShapeId,
} from 'tldraw';
import {
    BADGE,
    badgeWidth,
    DIAG_RADIUS,
    EdgeContent,
    edgeClassName,
    EdgeMarks,
    GroupContent,
    groupClassName,
    groupStyle,
    InternalContent,
    internalClassName,
    internalStyle,
    markScale,
    NodeContent,
    nodeClassName,
    nodeStyle,
} from './diagram-items';
import type { DiagMark, EdgeProps, GroupProps, InternalProps, NodeProps } from './scene';

declare module '@tldraw/tlschema' {
    interface TLGlobalShapePropsMap {
        'domain-node': NodeProps;
        'domain-internal': InternalProps;
        'domain-edge': EdgeProps;
        'domain-group': GroupProps;
    }
}

export type DomainNodeShape = TLShape<'domain-node'>;
export type DomainGroupShape = TLShape<'domain-group'>;
export type DomainEdgeShape = TLShape<'domain-edge'>;
export type DomainInternalShape = TLShape<'domain-internal'>;

const changeMark = T.literalEnum('none', 'added', 'changed', 'removed');
const diagMark = T.literalEnum('none', 'warning', 'error');

/** Whether a shape is selected, to draw the local selection as a ring outside it (see `nodeClassName`). */
const useSelected = (editor: Editor, id: TLShapeId): boolean => useValue('selected', () => editor.getSelectedShapeIds().includes(id), [editor, id]);

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
        const selected = useSelected(this.editor, shape.id);
        return (
            <HTMLContainer className={nodeClassName(p, selected)} style={nodeStyle(p)}>
                <NodeContent p={p} Marks={ZoomedMarks} />
            </HTMLContainer>
        );
    }

    /** The outline, going around the change badge and the diagnostic mark on the edge instead of crossing them. */
    getIndicatorPath(shape: DomainNodeShape) {
        const p = shape.props;
        if (p.kind === 'initial' || (!p.badge && p.diag === 'none')) return roundRect(p.w, p.h, 8);
        return outlineAround(p.w, p.h, 8, p.badge ? badgeWidth(p.badge) : 0, p.diag !== 'none', markScale(this.editor.getZoomLevel()));
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
            <HTMLContainer className={internalClassName(p)} style={internalStyle(p)}>
                <InternalContent p={p} />
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
        const selected = useSelected(this.editor, shape.id);
        return (
            <HTMLContainer className={groupClassName(p, selected)} style={groupStyle(p)}>
                <GroupContent p={p} />
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
        tone: T.literalEnum('normal', 'added', 'changed'),
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
        if (shape.props.points.length < 2) return null;
        return (
            <SVGContainer className={edgeClassName(shape.props)}>
                <EdgeContent p={shape.props} />
            </SVGContainer>
        );
    }

    getIndicatorPath(shape: DomainEdgeShape) {
        const p = new Path2D();
        shape.props.points.forEach((pt, i) => (i ? p.lineTo(pt.x, pt.y) : p.moveTo(pt.x, pt.y)));
        return p;
    }
}

function roundRect(w: number, h: number, r: number): Path2D {
    const p = new Path2D();
    p.roundRect(0, 0, w, h, r);
    return p;
}

/** The gap the outline leaves around the change badge and the diagnostic mark. */
const OUTLINE_GAP = 2;

/** The marks at the editor's zoom (a component of its own, so that only nodes with marks follow the zoom). */
function ZoomedMarks({ badge, diag }: { badge: string; diag: DiagMark }) {
    const editor = useEditor();
    const k = useValue('mark scale', () => markScale(editor.getZoomLevel()), [editor]);
    return <EdgeMarks badge={badge} diag={diag} scale={k} />;
}

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
