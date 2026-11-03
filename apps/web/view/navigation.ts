import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StormingView, ViewPayload } from '@domaintrail/visualization/protocol';
import type { RevealTarget } from '../inspector';
import { resolve, selectedFile } from '../model-utils';
import { usePersistentState } from '../shared/layout';
import { locationOf, type SourceFocus } from '../source';
import { isStormingSelection, stormingExists, stormingLocation } from '../storming';
import { highlightElement } from './canvas';
import { useCanvasValue, type DiagramCanvas } from './diagram';
import { backIndex, popHistory, pushHistory, type History } from './history';
import { rememberedView, VIEW_KEY } from './worlds';

export type View = { kind: 'contextMap' } | { kind: 'structure' } | { kind: 'catalog' } | { kind: 'storming' };

export const isCanvas = (v: View): boolean => v.kind === 'contextMap' || v.kind === 'structure' || v.kind === 'storming';

/** The shown view, the selection with its back history, and the source location the inspector shows. */
export interface Navigation {
    view: View;
    setView: (v: View) => void;
    /** The selected item (the top of the history), if any. */
    selected: string | undefined;
    sourceFocus: SourceFocus | undefined;
    setSourceFocus: (focus: SourceFocus | undefined) => void;
    /** Selects an item: updates the inspector, the history and the highlight in the current view. */
    select: (id: string, opts?: { highlight?: boolean }) => void;
    /** The entry "back" returns to, if any. */
    backTo: string | undefined;
    goBack: () => void;
    /** Shows `id` in a specific view (explicit user action). */
    reveal: (target: RevealTarget, id: string) => void;
}

export function useNavigation(canvas: DiagramCanvas | null, current: ViewPayload | null, stormings: readonly StormingView[]): Navigation {
    const model = current?.model ?? null;
    const base = current?.base ?? null;
    // the view (and with it the world) is remembered per browser: a reload comes back to it, whatever the first payload
    // holds (a storming not there yet is drawn once it arrives; the storming view says so meanwhile)
    const [storedView, storeView] = usePersistentState<View['kind']>(VIEW_KEY, 'structure');
    const view = useMemo(() => rememberedView(storedView), [storedView]);
    const setView = useCallback((v: View) => storeView(v.kind), [storeView]);

    // Selection with a back history
    const [history, setHistory] = useState<History>([]);
    const selected = history[history.length - 1];
    const [sourceFocus, setSourceFocus] = useState<SourceFocus | undefined>();

    /** Highlights `id` in the current view if it is shown there; never switches views. */
    const highlight = useCallback(
        (id: string, v: View = view) => {
            if (canvas && isCanvas(v)) highlightElement(canvas, id);
        },
        [canvas, view],
    );

    const focusSource = useCallback(
        (id: string) => setSourceFocus(isStormingSelection(id) ? stormingLocation(stormings, id) : locationOf(model, id)),
        [model, stormings],
    );

    const select = useCallback(
        (id: string, opts: { highlight?: boolean } = {}) => {
            setHistory((h) => pushHistory(h, id));
            focusSource(id);
            if (opts.highlight !== false) highlight(id);
        },
        [focusSource, highlight],
    );

    /** Whether a history entry can still be shown; without a model, elements are kept (they may come back). */
    const exists = (id: string): boolean => {
        const file = selectedFile(id);
        if (file) return (current?.sources ?? []).some((s) => s.path === file);
        if (isStormingSelection(id)) return stormingExists(stormings, id);
        // a removed item can still be shown from the baseline
        return !model || !!resolve(model, id) || (!!base?.model && !!resolve(base.model, id));
    };
    const backTo = history[backIndex(history, exists)];
    const goBack = (): void => {
        if (!backTo) return;
        setHistory(popHistory(history, exists));
        focusSource(backTo);
        highlight(backTo);
    };

    const reveal = useCallback(
        (target: RevealTarget, id: string) => {
            const next: View = { kind: target };
            setView(next);
            if (isCanvas(next)) requestAnimationFrame(() => requestAnimationFrame(() => highlight(id, next)));
        },
        [highlight],
    );

    return { view, setView, selected, sourceFocus, setSourceFocus, select, backTo, goBack, reveal };
}

/**
 * Whether a payload is of a workspace of .dtes files only, which opens on its stormings. Decided from its files, not
 * from what its model holds: a `.dt` that does not parse yet (a payload with no contexts) must not take the page away
 * from the domain model a reader chose.
 */
export const opensOnStormings = (current: Pick<ViewPayload, 'status' | 'files' | 'stormings'>): boolean =>
    current.status !== 'empty' && current.stormings.length > 0 && !current.files.some((f) => f.endsWith('.dt'));

/** A workspace of .dtes files only opens on its stormings (decided once, on the first payload with files). */
export function useOpenOnStormings(current: ViewPayload | null, setView: (v: View) => void): void {
    const openedOnStormings = useRef(false);
    useEffect(() => {
        if (openedOnStormings.current || !current || current.status === 'empty') return;
        openedOnStormings.current = true;
        if (opensOnStormings(current)) setView({ kind: 'storming' });
        // setView is a state setter: only a new payload runs this
    }, [current, setView]);
}

/** Clicking an item on the canvas selects its element (without moving the camera). */
export function useSelectOnCanvas(canvas: DiagramCanvas | null, select: Navigation['select']): void {
    const selectedOnCanvas = useCanvasValue(canvas, selectedElement, []);
    useEffect(() => {
        if (selectedOnCanvas) select(selectedOnCanvas, { highlight: false });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedOnCanvas]);
}

/** The element of the only item selected on the canvas, if any. */
export function selectedElement(canvas: DiagramCanvas | null): string | undefined {
    const only = canvas?.onlySelectedId();
    return only && canvas ? canvas.item(only)?.elementId : undefined;
}
