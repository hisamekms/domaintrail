import { useEffect, useState } from 'react';
import type { InspectorTab } from '../inspector';
import { useLegends, type Legends } from './legends';
import { clampSize, usePersistentState } from '../shared/layout';
import { effectiveLayout, keptOverrides, NO_OVERRIDES, type Overrides } from './responsive';
import { scaledSize } from './text-size';

/** The lists of the navigator (the top of the left column), chosen in its activity bar; `knowledge` in a session with a knowledge store. */
export type LeftView = 'tree' | 'problems' | 'changes' | 'knowledge';

/**
 * Which panes are open, their sizes and contents, and whether each view's legend is open (remembered per browser). The left
 * column is as shown: on a narrow window with the conversation open the page may override the reader's saved choice
 * (`responsive.ts`); setting it then changes what is shown only, not what is saved.
 */
export interface Panes {
    /** The left column shows the navigator and the detail (else its activity bar only). */
    explorerOpen: boolean;
    setExplorerOpen: (open: boolean) => void;
    explorerWidth: number;
    /** The left column's width; null goes back to the default. */
    setExplorerWidth: (width: number | null) => void;
    leftView: LeftView;
    /** Opens the left column on `view`. */
    showLeft: (view: LeftView) => void;
    /** The detail (the inspector, under the navigator) is open; the left column must be open too for it to show. */
    inspectorOpen: boolean;
    /** Opening the detail opens the left column too. */
    setInspectorOpen: (open: boolean) => void;
    /** The detail's height as the reader dragged it (px), or null for its default share of the column. */
    detailHeight: number | null;
    setDetailHeight: (height: number | null) => void;
    /** The conversation pillar at the right end (a session's chat); never open without one. */
    conversationOpen: boolean;
    setConversationOpen: (open: boolean) => void;
    conversationWidth: number;
    /** The conversation's width; null goes back to the default. */
    setConversationWidth: (width: number | null) => void;
    /** Each view's legend, open or closed on its own (hidden by default). */
    legends: Legends;
    inspectorTab: InspectorTab;
    setInspectorTab: (tab: InspectorTab) => void;
    /** Opens the detail on `tab` (and the left column with it). */
    openInspector: (tab: InspectorTab) => void;
}

/** The window's inner width, followed as it is resized. */
export function useWindowWidth(): number {
    const [width, setWidth] = useState(() => (typeof window === 'undefined' ? Infinity : window.innerWidth));
    useEffect(() => {
        const onResize = (): void => setWidth(window.innerWidth);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);
    return width;
}

/** The panes' default sizes at a 16px root; until the reader drags a pane, its size is this times the UI scale. */
export const DEFAULT_PANE_SIZES = { explorerWidth: 280, conversationWidth: 380 } as const;

/** A pane's size: the reader's (once dragged), else its default at the UI scale. */
export function paneSize(saved: number | null, base: number, scale: number): number {
    return saved ?? scaledSize(base, scale);
}

/** The left column's split: the detail takes this share of it by default, and each part keeps at least its minimum (px). */
export const DETAIL_SHARE = 0.55;
export const DETAIL_MIN = 140;
export const NAVIGATOR_MIN = 96;

/** The most the detail can take of a column `column` px high: all but the navigator's minimum. */
export function detailMax(column: number): number {
    return Math.max(DETAIL_MIN, column - NAVIGATOR_MIN);
}

/**
 * The detail's height in a column `column` px high: the dragged one (`saved`), else its default share, kept within its
 * minimum and the room the navigator leaves (a dragged height is kept, and shown again once the column is tall enough).
 */
export function detailSize(saved: number | null, column: number): number {
    return clampSize(saved ?? column * DETAIL_SHARE, DETAIL_MIN, detailMax(column));
}

/**
 * The detail's height as drawn (its outer box): the rail's (`rail`) while it is closed; open, its size in its column
 * (`detailSize`) once the column is measured, and none before (`column` 0), so that the first frame is drawn at the
 * measured split: a height that is not set is not one a transition starts from.
 */
export function drawnDetailHeight(open: boolean, saved: number | null, column: number, rail: number): number | undefined {
    if (!open) return rail;
    return column > 0 ? detailSize(saved, column) : undefined;
}

/**
 * `uiScale`: how much larger the UI is than at a 16px root (the text size), which the default sizes follow;
 * `conversationOpenAtStart`: the conversation is open from the start (a session's page: the server said so, `boot.ts`).
 */
export function usePanes(uiScale = 1, conversationOpenAtStart = false): Panes {
    const [leftSaved, setLeftSaved] = usePersistentState('domaintrail.layout.explorer', true);
    const [inspectorOpen, setDetailOpen] = usePersistentState('domaintrail.layout.inspector', true);
    // the sizes are null until the reader drags the pane: then they follow the text size
    const [explorerWidthSaved, setExplorerWidth] = usePersistentState<number | null>('domaintrail.layout.explorerWidth', null);
    const [leftView, setLeftView] = usePersistentState<LeftView>('domaintrail.layout.leftView', 'tree');
    const [detailHeight, setDetailHeight] = usePersistentState<number | null>('domaintrail.layout.detailHeight', null);
    const [conversationOpen, setConversationOpen] = useState(conversationOpenAtStart);
    const [conversationWidthSaved, setConversationWidth] = usePersistentState<number | null>('domaintrail.layout.conversationWidth', null);
    const legends = useLegends();
    const [inspectorTab, setInspectorTab] = usePersistentState<InspectorTab>('domaintrail.inspector.tab', 'structure');

    const explorerWidth = paneSize(explorerWidthSaved, DEFAULT_PANE_SIZES.explorerWidth, uiScale);
    const conversationWidth = paneSize(conversationWidthSaved, DEFAULT_PANE_SIZES.conversationWidth, uiScale);

    const width = useWindowWidth();
    const [overrides, setOverrides] = useState<Overrides>(NO_OVERRIDES);
    const layout = effectiveLayout({ width, conversationOpen, left: leftSaved, overrides, scale: uiScale });
    const { forced } = layout;
    // an override ends with the narrow window (or with the conversation closed): the saved choice is shown again
    useEffect(() => {
        setOverrides((o) => keptOverrides(o, { left: forced.left }));
    }, [forced.left]);

    const setExplorerOpen = (open: boolean): void => {
        if (forced.left) setOverrides((o) => ({ ...o, left: open }));
        else setLeftSaved(open);
    };
    const setInspectorOpen = (open: boolean): void => {
        setDetailOpen(open);
        if (open && !layout.left) setExplorerOpen(true);
    };
    const openInspector = (tab: InspectorTab): void => {
        setInspectorTab(tab);
        setInspectorOpen(true);
    };
    const showLeft = (view: LeftView): void => {
        setLeftView(view);
        setExplorerOpen(true);
    };
    return {
        explorerOpen: layout.left,
        setExplorerOpen,
        explorerWidth,
        setExplorerWidth,
        leftView,
        showLeft,
        inspectorOpen,
        setInspectorOpen,
        detailHeight,
        setDetailHeight,
        conversationOpen,
        setConversationOpen,
        conversationWidth,
        setConversationWidth,
        legends,
        inspectorTab,
        setInspectorTab,
        openInspector,
    };
}
