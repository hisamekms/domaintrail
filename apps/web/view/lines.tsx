// What the Event Storming canvas says around a selection (docs/live-view.md, "Selection and lines"): a line's two ends
// and what it means, in two lines — 「■ A → ■ B」 then the relation in plain words (`Messages.lines`) — as the hovered
// line's tooltip and the pressed line's popover, whose ends go to their stickies; the pointers at the canvas's edge to
// the stickies a selection points at out of view; and the steps through the copies of a selected sticky's element.
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, CircleCheck } from 'lucide-react';
import type { Messages } from '../i18n';
import { useT } from '../i18n';
import { readingOrder, rectCenter, type Point, type SceneId } from '../scene';
import { motionMs } from '../shared/motion';
import { TOOLTIP_ATTR } from '../tooltip';
import { useCanvasValue, type CanvasLine, type DiagramCanvas } from './diagram';
import { offscreenPointers, SIDE_ARROWS, type Side } from './offscreen';

/** The kind of sticky a node kind draws (`esReadModel`: `readmodel`), its colour box's class; empty for anything else. */
export function stickyKind(kind: string): string {
    return kind.startsWith('es') ? kind.slice(2).toLowerCase() : '';
}

/** The name of a sticky's kind (コマンド), for the screen reader's name of an end; 未決定 for an empty slot. */
export function kindName(t: Messages, kind: string): string {
    const k = stickyKind(kind);
    if (k === 'gap') return t.lines.undecided;
    const kinds: Readonly<Record<string, string>> = t.esKinds;
    return kinds[k] ?? '';
}

/** What a line means in plain words, from the labels of its source (`a`) and target (`b`). */
export function lineWords(t: Messages, relation: CanvasLine['relation'], a: string, b: string): string {
    return t.lines.relations[relation.kind](a, b, relation.names);
}

/** An end of a line as the canvas shows it: its item, its kind and its label. */
export interface LineEnd {
    readonly id: SceneId;
    readonly kind: string;
    readonly label: string;
}

/** The two ends of a line, from the canvas. */
function endsOf(canvas: DiagramCanvas, line: CanvasLine): [LineEnd, LineEnd] {
    const end = (id: SceneId): LineEnd => {
        const item = canvas.item(id);
        return { id, kind: item?.kind ?? '', label: item?.label ?? '' };
    };
    return [end(line.source), end(line.target)];
}

/** A sticky's colour box (its paper's colour; an actor's rounded, an external system's dashed) and its label. */
function EndText({ end }: { end: Pick<LineEnd, 'kind' | 'label'> }): ReactNode {
    return (
        <>
            <span className={`line-swatch line-swatch-${stickyKind(end.kind) || 'other'}`} aria-hidden />
            <span className="line-end-label">{end.label}</span>
        </>
    );
}

/** The second line: the relation in plain words, after a check for a resolved hotspot's question. */
function Relation({ words, resolved }: { words: string; resolved: boolean }): ReactNode {
    const t = useT();
    return (
        <span className="line-relation">
            {resolved && <CircleCheck className="line-resolved" size={13} role="img" aria-label={t.lines.resolved} />}
            {words}
        </span>
    );
}

/** The hovered line's tooltip: 「■ A → ■ B」, then what it means. */
export function LineTip({ canvas, line }: { canvas: DiagramCanvas; line: CanvasLine }): ReactNode {
    const t = useT();
    const [a, b] = endsOf(canvas, line);
    return (
        <>
            <span className="line-ends">
                <span className="line-end">
                    <EndText end={a} />
                </span>
                <span aria-hidden>→</span>
                <span className="line-end">
                    <EndText end={b} />
                </span>
            </span>
            <Relation words={lineWords(t, line.relation, a.label, b.label)} resolved={line.resolved === true} />
        </>
    );
}

/** A camera move the page's motion allows (none with reduce motion). */
const moveAnimated = (): { animate: boolean } => ({ animate: motionMs('--motion-medium') > 0 });

/** Selects an item and brings it to the canvas's middle. */
export function goToItem(canvas: DiagramCanvas, id: SceneId): void {
    canvas.select([id]);
    const b = canvas.itemBounds(id);
    if (b) canvas.centerOn(rectCenter(b), moveAnimated());
}

/** How far the popover stays from the canvas's edges, and how wide it is at most. */
const POPOVER_MARGIN = 8;
const POPOVER_WIDTH = 380;

/**
 * The pressed line's popover, by where it was pressed: the same two lines as its tooltip, its ends buttons that move
 * the camera to their sticky and select it. Escape closes it (the line is unselected).
 */
export function LinePopover({ canvas }: { canvas: DiagramCanvas | null }): ReactNode {
    const t = useT();
    /** Where on the page the line was pressed (the popover stays by it as the camera moves). */
    const anchor = useRef<{ id: SceneId; at: Point } | null>(null);
    const shown = useCanvasValue(
        canvas,
        (c) => {
            const id = c?.onlySelectedId();
            const line = id !== undefined ? c?.item(id)?.line : undefined;
            if (!c || id === undefined || !line) {
                anchor.current = null;
                return null;
            }
            if (anchor.current?.id !== id) {
                const box = c.viewportScreenBounds();
                const p = c.pointer();
                const bounds = c.itemBounds(id);
                const pressed = c.screenToPage({ x: box.x + p.x, y: box.y + p.y });
                const near =
                    bounds &&
                    pressed.x >= bounds.x - 24 &&
                    pressed.x <= bounds.x + bounds.w + 24 &&
                    pressed.y >= bounds.y - 24 &&
                    pressed.y <= bounds.y + bounds.h + 24;
                anchor.current = { id, at: near || !bounds ? pressed : rectCenter(bounds) };
            }
            const box = c.viewportScreenBounds();
            const at = c.pageToViewport(anchor.current.at);
            const [a, b] = endsOf(c, line);
            return {
                id,
                left: box.x + Math.max(POPOVER_MARGIN, Math.min(at.x - 40, box.w - POPOVER_WIDTH - POPOVER_MARGIN)),
                top: box.y + Math.max(POPOVER_MARGIN, Math.min(at.y + 14, box.h - 96)),
                aId: a.id,
                aKind: a.kind,
                aLabel: a.label,
                bId: b.id,
                bKind: b.kind,
                bLabel: b.label,
                words: lineWords(t, line.relation, a.label, b.label),
                resolved: line.resolved === true,
            };
        },
        [t],
    );
    if (!canvas || !shown) return null;
    const end = (id: SceneId, kind: string, label: string): ReactNode => (
        <button type="button" className="line-end-button" aria-label={t.lines.goTo(kindName(t, kind), label)} onClick={() => goToItem(canvas, id)}>
            <EndText end={{ kind, label }} />
        </button>
    );
    const onKeyDown = (e: KeyboardEvent): void => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        canvas.selectNone();
        canvas.container().focus({ preventScroll: true });
    };
    return (
        <div className="line-popover" role="group" aria-label={shown.words} style={{ left: shown.left, top: shown.top }} onKeyDown={onKeyDown}>
            <span className="line-ends">
                {end(shown.aId, shown.aKind, shown.aLabel)}
                <span aria-hidden>→</span>
                {end(shown.bId, shown.bKind, shown.bLabel)}
            </span>
            <Relation words={shown.words} resolved={shown.resolved} />
        </div>
    );
}

/** The stickies the selection points at: the other copies of a selected sticky's element, a pressed line's two ends. */
function pointedAt(canvas: DiagramCanvas): SceneId[] {
    const id = canvas.onlySelectedId();
    const item = id !== undefined ? canvas.item(id) : undefined;
    if (!id || !item) return [];
    if (item.line) return [item.line.source, item.line.target];
    if (item.type !== 'node' || item.ghost) return [];
    return canvas.elementNodes(item.elementId).filter((n) => n !== id);
}

/**
 * The pointers at the canvas's edge to the stickies the selection points at that it does not show: on each side that
 * has some, 「→ n」 (the arrow of the side, then how many), named in its tooltip; a press moves the camera to the
 * nearest of them. One component for the copies of an element and the ends of a line.
 */
export function OffscreenPointers({ canvas }: { canvas: DiagramCanvas | null }): ReactNode {
    const t = useT();
    // flat, so that an unchanged answer does not render again (`sameValue`)
    const key = useCanvasValue(
        canvas,
        (c) => {
            if (!c) return '';
            const targets = pointedAt(c).flatMap((id) => {
                const rect = c.itemBounds(id);
                return rect ? [{ id, rect }] : [];
            });
            if (!targets.length) return '';
            const box = c.viewportScreenBounds();
            return JSON.stringify({ box, pointers: offscreenPointers(targets, c.viewportPageBounds()) });
        },
        [],
    );
    if (!canvas || !key) return null;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written just above
    const { box, pointers } = JSON.parse(key) as { box: { x: number; y: number; w: number; h: number }; pointers: ReturnType<typeof offscreenPointers> };
    const place = (side: Side, at: number): { left: number; top: number } => {
        if (side === 'left') return { left: box.x + POPOVER_MARGIN, top: box.y + box.h * at };
        if (side === 'right') return { left: box.x + box.w - POPOVER_MARGIN, top: box.y + box.h * at };
        if (side === 'top') return { left: box.x + box.w * at, top: box.y + POPOVER_MARGIN };
        return { left: box.x + box.w * at, top: box.y + box.h - POPOVER_MARGIN };
    };
    return (
        <>
            {pointers.map((p) => {
                const names = [
                    ...new Set(
                        p.ids.map((id) => {
                            const item = canvas.item(id);
                            return `${kindName(t, item?.kind ?? '')} ${item?.label ?? ''}`.trim();
                        }),
                    ),
                ];
                const label = t.lines.offscreen(names.join(t.lines.and));
                const go = (): void => {
                    const b = canvas.itemBounds(p.ids[0]!);
                    if (b) canvas.centerOn(rectCenter(b), moveAnimated());
                };
                return (
                    <button
                        key={p.side}
                        type="button"
                        className={`offscreen-pointer offscreen-${p.side}`}
                        style={place(p.side, p.at)}
                        aria-label={label}
                        {...{ [TOOLTIP_ATTR]: label }}
                        onClick={go}
                    >
                        {SIDE_ARROWS[p.side]} {p.ids.length}
                    </button>
                );
            })}
        </>
    );
}

/**
 * In the detail of a sticky drawn more than once: 「同じ付箋 n 件 ◀ k/n ▶」, the steps through its copies in reading
 * order (the selection moves, the camera follows). Nothing for an element drawn once.
 */
export function CopySteps({ canvas, elementId }: { canvas: DiagramCanvas | null; elementId: string }): ReactNode {
    const t = useT();
    const copies = useCanvasValue(
        canvas,
        (c) => {
            if (!c) return '';
            const notes = c
                .elementNodes(elementId)
                .flatMap((id) => {
                    const b = c.itemBounds(id);
                    return b ? [{ id, x: b.x, y: b.y }] : [];
                })
                .sort(readingOrder)
                .map((n) => n.id);
            return notes.length > 1 ? JSON.stringify({ notes, k: notes.indexOf(c.onlySelectedId() ?? '') + 1 }) : '';
        },
        [elementId],
    );
    if (!canvas || !copies) return null;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written just above
    const { notes, k } = JSON.parse(copies) as { notes: SceneId[]; k: number };
    const n = notes.length;
    const step = (by: number): void => {
        const i = k === 0 ? (by > 0 ? 0 : n - 1) : (k - 1 + by + n) % n;
        goToItem(canvas, notes[i]!);
    };
    return (
        <div className="copy-steps">
            <span>{t.lines.copies(n)}</span>
            <button
                type="button"
                className="icon-button"
                aria-label={t.lines.previousCopy}
                {...{ [TOOLTIP_ATTR]: t.lines.previousCopy }}
                onClick={() => step(-1)}
            >
                <ChevronLeft size={14} aria-hidden />
            </button>
            <span className="copy-steps-at">
                {k === 0 ? '–' : k}/{n}
            </span>
            <button type="button" className="icon-button" aria-label={t.lines.nextCopy} {...{ [TOOLTIP_ATTR]: t.lines.nextCopy }} onClick={() => step(1)}>
                <ChevronRight size={14} aria-hidden />
            </button>
        </div>
    );
}
