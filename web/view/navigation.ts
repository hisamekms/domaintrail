import { useCallback, useEffect, useRef, useState } from 'react';
import { useValue, type Editor } from 'tldraw';
import type { StormingView, ViewPayload } from '../../src/visualization/protocol';
import type { RevealTarget } from '../inspector';
import { resolve, selectedFile } from '../model-utils';
import { shapeElementId } from '../render';
import { locationOf, type SourceFocus } from '../source';
import { isStormingSelection, stormingExists, stormingLocation } from '../storming';
import { highlightElement } from './canvas';
import { backIndex, popHistory, pushHistory, type History } from './history';

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

export function useNavigation(editor: Editor | null, current: ViewPayload | null, stormings: readonly StormingView[]): Navigation {
    const model = current?.model ?? null;
    const base = current?.base ?? null;
    const [view, setView] = useState<View>({ kind: 'structure' });

    // Selection with a back history
    const [history, setHistory] = useState<History>([]);
    const selected = history[history.length - 1];
    const [sourceFocus, setSourceFocus] = useState<SourceFocus | undefined>();

    /** Highlights `id` in the current view if it is shown there; never switches views. */
    const highlight = useCallback(
        (id: string, v: View = view) => {
            if (editor && isCanvas(v)) highlightElement(editor, id);
        },
        [editor, view],
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

/** A workspace of .dtes files only opens on its stormings (decided once, on the first payload with files). */
export function useOpenOnStormings(current: ViewPayload | null, setView: (v: View) => void): void {
    const openedOnStormings = useRef(false);
    useEffect(() => {
        if (openedOnStormings.current || !current || current.status === 'empty') return;
        openedOnStormings.current = true;
        if (current.stormings.length && !current.focusContexts.length) setView({ kind: 'storming' });
        // setView is a state setter: only a new payload runs this
    }, [current, setView]);
}

/** Clicking a shape on the canvas selects it (without moving the camera). */
export function useSelectOnCanvas(editor: Editor | null, select: Navigation['select']): void {
    const selectedOnCanvas = useValue(
        'selected element',
        () => {
            const only = editor?.getOnlySelectedShape();
            return only && editor ? shapeElementId(editor, only.id) : undefined;
        },
        [editor],
    );
    useEffect(() => {
        if (selectedOnCanvas) select(selectedOnCanvas, { highlight: false });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedOnCanvas]);
}
