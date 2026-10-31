import { useEffect, useMemo, useState } from 'react';
import type { LaidOutGraph } from '../../src/graph/ir';
import type { BaseView, StormingView, ViewPayload } from '../../src/server/protocol';
import { shownStorming, stormingGraph } from '../storming';
import { isCanvas, type View } from './navigation';
import type { ViewSettings } from './settings';

/** The pushed graph of each Structure View level (focused views are fetched instead). */
const LEVEL_GRAPHS = { detail: 'structure', overview: 'overview', aggregates: 'aggregates' } as const;

/** What the current view draws: its graph, and the focus and storming it is drawn for. */
export interface ViewGraph {
    /** The storming the Event Storming view shows (whichever view is current). */
    shown: ReturnType<typeof shownStorming>;
    /** The drawing of the shown storming while the Event Storming view is current. */
    stormingShown: ReturnType<typeof stormingGraph>;
    /** The checked contexts that can still be drawn, in model order. */
    checked: string[];
    /** The hidden contexts that apply: only ones drawn as stubs, so none without a focus. */
    hidden: string[];
    /** Some but not all contexts checked: identifies the focused Structure View ('' when not focused). */
    focusKey: string;
    noneChecked: boolean;
    focusGraph: { key: string; graph: LaidOutGraph } | null;
    /** The graph of the current view: null when it has none, undefined while a focused view loads. */
    graph: LaidOutGraph | null | undefined;
    /** The graph of `v` in the payload `p` (the current one, or the baseline for the ghosts of removed elements). */
    graphFor: (p: BaseView | null, v: View) => LaidOutGraph | null | undefined;
    /** Camera key: each view (and each Structure mode and focus, each storming view) keeps its own camera. */
    cameraKey: (v: View) => string;
}

export function useViewGraph(current: ViewPayload | null, view: View, settings: ViewSettings, stormings: readonly StormingView[]): ViewGraph {
    const { structureLevel, structureContexts, hiddenContexts, mapAll, stormingChoice } = settings;
    const shown = shownStorming(stormings, stormingChoice);
    const stormingShown = view.kind === 'storming' ? stormingGraph(stormings, stormingChoice) : undefined;

    const checked = useMemo(
        () => (current?.focusContexts ?? []).filter((c) => structureContexts === null || structureContexts.includes(c)),
        [current?.focusContexts, structureContexts],
    );
    const allChecked = checked.length === (current?.focusContexts ?? []).length;
    /** Some but not all contexts: drawn only them, with their dependencies as stubs. */
    const focused = useMemo(() => (allChecked ? [] : checked), [allChecked, checked]);
    const noneChecked = !allChecked && checked.length === 0;
    const hidden = useMemo(
        () => (focused.length ? (current?.focusContexts ?? []).filter((c) => hiddenContexts.includes(c) && !focused.includes(c)) : []),
        [current?.focusContexts, hiddenContexts, focused],
    );
    const focusKey = focused.length ? `${focused.join('+')}|${hidden.join('+')}|${structureLevel}` : '';
    /** The focused Structure View is laid out on request by the server. */
    const [focusGraph, setFocusGraph] = useState<{ key: string; graph: LaidOutGraph } | null>(null);
    useEffect(() => {
        if (!focusKey || view.kind !== 'structure') return;
        let cancelled = false;
        const params = new URLSearchParams({ contexts: focused.join(','), level: structureLevel, hide: hidden.join(',') });
        fetch(`/api/focus?${params}`)
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the response of our own server's api/focus
            .then((r) => (r.ok ? (r.json() as Promise<LaidOutGraph>) : null))
            .then((graph) => {
                if (!cancelled && graph) setFocusGraph({ key: focusKey, graph });
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
        // re-fetch when the model changes, not on every diagnostics update
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusKey, current?.modelVersion, view.kind]);

    const graphFor = (p: BaseView | null, v: View): LaidOutGraph | null | undefined => {
        if (!p || !isCanvas(v)) return null;
        if (v.kind === 'contextMap') return mapAll ? p.contextMapAll : p.contextMap;
        if (v.kind === 'structure') {
            if (noneChecked) return null;
            if (focusKey) return focusGraph?.key === focusKey ? focusGraph.graph : undefined;
            return p[LEVEL_GRAPHS[structureLevel]];
        }
        return null;
    };
    const cameraKey = (v: View): string =>
        v.kind === 'structure'
            ? focusKey
                ? `structure:focus:${focusKey}`
                : `structure:${structureLevel}`
            : v.kind === 'storming'
              ? (stormingShown?.graph.id ?? 'storming')
              : `${v.kind}:${mapAll}`;
    const graph = view.kind === 'storming' ? stormingShown?.graph : graphFor(current, view);

    return { shown, stormingShown, checked, hidden, focusKey, noneChecked, focusGraph, graph, graphFor, cameraKey };
}
