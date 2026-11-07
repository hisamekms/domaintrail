// The exceptions' lanes over a storming's canvas (ADR 0032 §11): a band behind each exception's own steps, and its
// label (the caption of the line into its lane) as a button that emphasizes it — or ends the emphasis when it is the
// one emphasized. Hovering a label deepens its band, so that what a press emphasizes shows first; the lane emphasized
// has its label filled and its band outlined. Drawn over the canvas from page coordinates with this page's camera;
// never printed nor exported.
import { useState, type ReactNode } from 'react';
import { exceptionLanes, type FlowTimeline, type LaidOutGraph, type RenderGraph } from '@domaintrail/visualization';
import { useT } from '../i18n';
import { useCanvasValue, type DiagramCanvas } from './diagram';
import type { Rect } from '../scene';

/** A lane drawn: its band on the page, and the label boxes that name it. */
export interface DrawnLane {
    readonly exceptionId: string;
    readonly band: Rect;
    readonly labels: readonly Rect[];
}

/** Room around a lane's notes in its band. */
const PAD = 10;

/**
 * The lanes of the exceptions drawn in `graph` (the drawing shown: its notes left out are not in it): each band round
 * its own notes drawn, each label the box of a line's caption naming it. None for a view without lanes.
 */
export function drawnLanes(graph: LaidOutGraph, render: RenderGraph, timelines: readonly FlowTimeline[]): DrawnLane[] {
    const drawn = new Set(graph.nodes.map((n) => n.id));
    const edges = new Set(graph.edges.map((e) => e.id));
    const out: DrawnLane[] = [];
    for (const t of timelines) {
        const lane = exceptionLanes(render, timelines).get(t.id);
        if (!lane) continue;
        const boxes = lane.notes.filter((id) => drawn.has(id)).flatMap((id) => (graph.nodeLayout[id] ? [graph.nodeLayout[id]] : []));
        if (!boxes.length) continue;
        const x = Math.min(...boxes.map((b) => b.x)) - PAD;
        const y = Math.min(...boxes.map((b) => b.y)) - PAD;
        const band = { x, y, w: Math.max(...boxes.map((b) => b.x + b.width)) + PAD - x, h: Math.max(...boxes.map((b) => b.y + b.height)) + PAD - y };
        const labels = lane.captions.flatMap((e) => {
            const l = edges.has(e) ? graph.edgeLayout[e]?.label : undefined;
            return l ? [{ x: l.x, y: l.y, w: l.width, h: l.height }] : [];
        });
        out.push({ exceptionId: t.id, band, labels });
    }
    return out;
}

/**
 * The exception a press on a label emphasizes: of the exceptions its caption names, the first — or, when one of them is
 * emphasized, the next (none after the last: the press ends the emphasis).
 */
export function pressedLabel(names: readonly string[], focus: string | undefined): string | undefined {
    const at = focus === undefined ? -1 : names.indexOf(focus);
    return at < 0 ? names[0] : names[at + 1];
}

/**
 * What a press of Escape on the canvas ends, while an exception is emphasized: the stickies' selection first, then (a
 * second Escape) the emphasis. A press on the canvas's empty space ends both.
 */
export const escapeEnds = (selected: number): 'selection' | 'emphasis' => (selected > 0 ? 'selection' : 'emphasis');

export function ExceptionLanes(props: {
    canvas: DiagramCanvas | null;
    lanes: readonly DrawnLane[];
    focus: string | undefined;
    /** The name of an exception, as its label reads. */
    name: (exceptionId: string) => string;
    onPress: (exceptionId: string | undefined) => void;
}): ReactNode {
    const { canvas, lanes, focus } = props;
    const t = useT();
    const [hovered, setHovered] = useState<string | undefined>();
    // the placement follows this page's camera
    const camera = useCanvasValue(
        canvas,
        (c) => {
            if (!c) return undefined;
            const { x, y, z } = c.getCamera();
            return { x, y, z };
        },
        [],
    );
    if (!canvas || !camera || !lanes.length) return null;
    const place = (r: Rect): { left: number; top: number; width: number; height: number } => {
        const p = canvas.pageToViewport({ x: r.x, y: r.y });
        return { left: p.x, top: p.y, width: r.w * camera.z, height: r.h * camera.z };
    };
    // one button per caption: a caption may name several exceptions (a lane they share), pressed in turn
    const captions = new Map<string, { box: Rect; names: string[] }>();
    for (const lane of lanes) {
        for (const box of lane.labels) {
            const key = `${box.x},${box.y}`;
            const c = captions.get(key) ?? { box, names: [] };
            c.names.push(lane.exceptionId);
            captions.set(key, c);
        }
    }
    return (
        <div className="exception-lanes">
            {lanes.map((lane) => (
                <div
                    key={lane.exceptionId}
                    className={`exception-lane${hovered === lane.exceptionId ? ' hovered' : ''}${focus === lane.exceptionId ? ' focus' : ''}`}
                    style={place(lane.band)}
                    aria-hidden
                />
            ))}
            {[...captions.entries()].map(([key, { box, names }]) => {
                const on = focus !== undefined && names.includes(focus);
                const label = names.map((n) => t.exceptionLayer.focused(props.name(n))).join(' / ');
                return (
                    <button
                        key={key}
                        className={`exception-lane-label${on ? ' focus' : ''}`}
                        style={{ ...place(box), fontSize: `${13 * camera.z}px` }}
                        aria-label={label}
                        aria-pressed={on}
                        onPointerEnter={() => setHovered(on ? focus : names[0])}
                        onPointerLeave={() => setHovered(undefined)}
                        onClick={() => props.onPress(pressedLabel(names, focus))}
                    >
                        {on && props.name(focus)}
                    </button>
                );
            })}
        </div>
    );
}
