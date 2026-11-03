import { useEffect, useMemo, useState } from 'react';
import type { LaidOutGraph } from '@domaintrail/visualization';
import type { BaseView, StormingView, ViewPayload } from '@domaintrail/visualization/protocol';
import { shownStorming, stormingGraph } from '../storming';
import { useCompactGraph } from './compact';
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
    /**
     * The graph of the current view: null when it has none, undefined while a focused view loads. While compact
     * (`compact`), its compact layout once the page has it.
     */
    graph: LaidOutGraph | null | undefined;
    /** The graph of `v` in the payload `p` (the current one, or the baseline for the ghosts of removed elements). */
    graphFor: (p: BaseView | null, v: View) => LaidOutGraph | null | undefined;
    /** Camera key: each view (and each Structure mode and focus, each storming view) keeps its own camera. */
    cameraKey: (v: View) => string;
}

/** Focused Structure Views kept (each focus, normal and compact): the last few, for going back and forth. */
const FOCUS_KEPT = 6;

/**
 * The graphs the current view draws. `compact`: the compact layouts are wanted (「詰めて表示」, or printing); each is
 * asked for once and kept, and the normal layout is shown until it comes.
 */
export function useViewGraph(current: ViewPayload | null, view: View, settings: ViewSettings, stormings: readonly StormingView[], compact: boolean): ViewGraph {
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
    /**
     * The focused Structure Views laid out on request by the server, by focus key and spacing (`focusLayoutKey`), with
     * the model version each was fetched for: one of an older model is shown until it is fetched again.
     */
    const [focusGraphs, setFocusGraphs] = useState<ReadonlyMap<string, { graph: LaidOutGraph; modelVersion: number | undefined }>>(new Map());
    const modelVersion = current?.modelVersion;
    const focusGraphOf = (key: string): LaidOutGraph | undefined => focusGraphs.get(key)?.graph;
    const wantedFocus = focusKey ? focusLayoutKey(focusKey, compact) : '';
    const wantedFocusFresh = focusGraphs.get(wantedFocus)?.modelVersion === modelVersion;
    useEffect(() => {
        if (!focusKey || view.kind !== 'structure' || wantedFocusFresh) return;
        let cancelled = false;
        const params = new URLSearchParams({
            contexts: focused.join(','),
            level: structureLevel,
            hide: hidden.join(','),
            ...(compact && { spacing: 'compact' }),
        });
        fetch(`/api/focus?${params}`)
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the response of our own server's api/focus
            .then((r) => (r.ok ? (r.json() as Promise<LaidOutGraph>) : null))
            .then((graph) => {
                if (cancelled || !graph) return;
                setFocusGraphs((old) => {
                    const graphs = new Map(old);
                    graphs.delete(wantedFocus);
                    graphs.set(wantedFocus, { graph, modelVersion });
                    if (graphs.size > FOCUS_KEPT) graphs.delete(graphs.keys().next().value!);
                    return graphs;
                });
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
        // re-fetch when the model changes, not on every diagnostics update
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wantedFocus, modelVersion, view.kind, wantedFocusFresh]);

    const graphFor = (p: BaseView | null, v: View): LaidOutGraph | null | undefined => {
        if (!p || !isCanvas(v)) return null;
        if (v.kind === 'contextMap') return mapAll ? p.contextMapAll : p.contextMap;
        if (v.kind === 'structure') {
            if (noneChecked) return null;
            // the compact one while it loads: the normal one, if the page has it
            if (focusKey) return focusGraphOf(focusLayoutKey(focusKey, compact)) ?? (compact ? focusGraphOf(focusLayoutKey(focusKey, false)) : undefined);
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
    const pushed = view.kind === 'storming' ? stormingShown?.graph : graphFor(current, view);
    // a focused view is fetched in the spacing wanted; the others are pushed in the normal one
    const graph = useCompactGraph(pushed, compact && !(focusKey && view.kind === 'structure'));

    return { shown, stormingShown, checked, hidden, focusKey, noneChecked, graph, graphFor, cameraKey };
}

/** A focused Structure View's key among the fetched ones: its focus key and its spacing. */
export const focusLayoutKey = (focusKey: string, compact: boolean): string => (compact ? `${focusKey}|compact` : focusKey);
