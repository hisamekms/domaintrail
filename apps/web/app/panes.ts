import { useEffect, useState } from 'react';
import type { InspectorTab } from '../inspector';
import { useLegends, type Legends } from './legends';
import { clampSize, removeStored, usePersistentState } from '../shared/layout';
import { effectiveLayout, keptOverrides, NO_OVERRIDES, type Overrides } from './responsive';
import { scaledSize } from './text-size';

/** The lists of the navigator (the top of the left column), chosen in its activity bar. */
export type LeftView = 'tree' | 'problems' | 'changes';

/**
 * Which panes are open, their sizes and contents, and whether each view's legend is open (remembered per browser). The left
 * column is as shown: on a narrow window with the conversation open the page may override the reader's saved choice
 * (`responsive.ts`); setting it then changes what is shown only, not what is saved.
 */
export interface Panes {
    /** The left column shows the navigator (and, under the tree, the detail; else its activity bar only). */
    explorerOpen: boolean;
    setExplorerOpen: (open: boolean) => void;
    explorerWidth: number;
    /** The left column's width; null goes back to the default. */
    setExplorerWidth: (width: number | null) => void;
    leftView: LeftView;
    /** Opens the left column on `view`. */
    showLeft: (view: LeftView) => void;
    /**
     * Shows the detail (the inspector): it is under the tree only (the other lists take the whole column), so this opens
     * the left column on the tree.
     */
    showInspector: () => void;
    /** The tree's height over the detail as the reader dragged it (px), or null for its default share of the column. */
    treeHeight: number | null;
    setTreeHeight: (height: number | null) => void;
    /** The tree is folded to its head line (by the reader only), the detail taking the rest of the column. */
    treeFolded: boolean;
    setTreeFolded: (folded: boolean) => void;
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
    /** Opens the detail on `tab` (and the left column on the tree with it). */
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

/**
 * The tree's split over the detail: the tree takes this share of the column by default, and each part keeps at least its
 * minimum (px); a tree dragged under half its minimum folds to its head line.
 */
export const TREE_SHARE = 0.45;
export const TREE_MIN = 96;
export const DETAIL_MIN = 140;

/** The most the tree can take of a column `column` px high: all but the detail's minimum. */
export function treeMax(column: number): number {
    return Math.max(TREE_MIN, column - DETAIL_MIN);
}

/**
 * The tree's height in a column `column` px high: the dragged one (`saved`), else its default share, kept within its
 * minimum and the room the detail leaves (a dragged height is kept, and shown again once the column is tall enough).
 */
export function treeSize(saved: number | null, column: number): number {
    return clampSize(saved ?? column * TREE_SHARE, TREE_MIN, treeMax(column));
}

/**
 * The unfolded tree's height as drawn: its size in its column (`treeSize`) once the column is measured, and none before
 * (`column` 0), so that the first frame is drawn at the measured split: a height that is not set is not one a transition
 * starts from.
 */
export function drawnTreeHeight(saved: number | null, column: number): number | undefined {
    return column > 0 ? treeSize(saved, column) : undefined;
}

/** What the split was kept under when the detail closed to a rail under every list (no longer read). */
const FORMER_SPLIT_KEYS = ['domaintrail.layout.inspector', 'domaintrail.layout.detailHeight'] as const;

/**
 * `uiScale`: how much larger the UI is than at a 16px root (the text size), which the default sizes follow;
 * `conversationOpenAtStart`: the conversation is open from the start (a session's page: the server said so, `boot.ts`).
 */
export function usePanes(uiScale = 1, conversationOpenAtStart = false): Panes {
    const [leftSaved, setLeftSaved] = usePersistentState('domaintrail.layout.explorer', true);
    // the sizes are null until the reader drags the pane: then they follow the text size
    const [explorerWidthSaved, setExplorerWidth] = usePersistentState<number | null>('domaintrail.layout.explorerWidth', null);
    const [leftView, setLeftView] = usePersistentState<LeftView>('domaintrail.layout.leftView', 'tree');
    const [treeHeight, setTreeHeight] = usePersistentState<number | null>('domaintrail.layout.treeHeight', null);
    const [treeFolded, setTreeFolded] = usePersistentState('domaintrail.layout.treeFolded', false);
    useEffect(() => {
        for (const key of FORMER_SPLIT_KEYS) removeStored(key);
    }, []);
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
    const showLeft = (view: LeftView): void => {
        setLeftView(view);
        setExplorerOpen(true);
    };
    const showInspector = (): void => showLeft('tree');
    const openInspector = (tab: InspectorTab): void => {
        setInspectorTab(tab);
        showInspector();
    };
    return {
        explorerOpen: layout.left,
        setExplorerOpen,
        explorerWidth,
        setExplorerWidth,
        leftView,
        showLeft,
        showInspector,
        treeHeight,
        setTreeHeight,
        treeFolded,
        setTreeFolded,
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
