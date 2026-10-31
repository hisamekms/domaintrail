import { useEffect, useState } from 'react';
import type { InspectorTab } from '../inspector';
import { usePersistentState } from '../shared/layout';
import { autoInspectorWidth, effectiveLayout, keptOverrides, NO_OVERRIDES, type Dock, type Overrides } from './responsive';

/** The lists of the left pane, chosen in its activity bar. */
export type LeftView = 'tree' | 'problems' | 'changes';

/** What the dock (right of or below the canvas) shows: the inspector, or another content of the page (the facilitator's session panel). */
export type DockContent = 'inspector' | 'alternative';

/**
 * Which panes are open, their sizes and contents, and whether the legend is open (remembered per browser). The left
 * pane and the dock are as shown: on a narrow window with the conversation open the page may override the reader's
 * saved choices (`responsive.ts`); setting them then changes what is shown only, not what is saved.
 */
export interface Panes {
    /** The left pane shows its list (else its activity bar only). */
    explorerOpen: boolean;
    setExplorerOpen: (open: boolean) => void;
    explorerWidth: number;
    setExplorerWidth: (width: number) => void;
    leftView: LeftView;
    /** Opens the left pane on `view`. */
    showLeft: (view: LeftView) => void;
    /** The dock is open (on the inspector or on its alternative). */
    inspectorOpen: boolean;
    /** Opens the dock on the inspector (`true`), or closes it. */
    setInspectorOpen: (open: boolean) => void;
    /** Opens or closes the dock on what it shows. */
    setDockOpen: (open: boolean) => void;
    dockContent: DockContent;
    setDockContent: (content: DockContent) => void;
    inspectorDock: Dock;
    setInspectorDock: (dock: Dock) => void;
    /** The inspector's width on the right: the reader's (once dragged), else one that leaves the canvas its share. */
    inspectorWidth: number;
    setInspectorWidth: (width: number) => void;
    inspectorHeight: number;
    setInspectorHeight: (height: number) => void;
    /** The conversation pillar at the right end (a session's chat); never open without one. */
    conversationOpen: boolean;
    setConversationOpen: (open: boolean) => void;
    conversationWidth: number;
    setConversationWidth: (width: number) => void;
    legendOpen: boolean;
    setLegendOpen: (open: boolean) => void;
    inspectorTab: InspectorTab;
    setInspectorTab: (tab: InspectorTab) => void;
    /** Opens the inspector on `tab`. */
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

/** The width of the left pane's activity bar (BAR_WIDTH in shell.tsx). */
const LEFT_BAR = 44;

export function usePanes(): Panes {
    const [leftSaved, setLeftSaved] = usePersistentState('domaintrail.layout.explorer', true);
    const [dockOpen, setDockOpen] = usePersistentState('domaintrail.layout.inspector', true);
    const [explorerWidth, setExplorerWidth] = usePersistentState('domaintrail.layout.explorerWidth', 260);
    const [leftView, setLeftView] = usePersistentState<LeftView>('domaintrail.layout.leftView', 'tree');
    const [dockSaved, setDockSaved] = usePersistentState<Dock>('domaintrail.layout.inspectorDock', 'right');
    // the facilitator's session panel first, as before; without one the dock always shows the inspector
    const [dockContent, setDockContent] = usePersistentState<DockContent>('domaintrail.layout.dockContent', 'alternative');
    // null until the reader drags it: then the width follows the room the other panes leave
    const [inspectorWidthSaved, setInspectorWidth] = usePersistentState<number | null>('domaintrail.layout.inspectorWidth', null);
    const [inspectorHeight, setInspectorHeight] = usePersistentState('domaintrail.layout.inspectorHeight', 320);
    const [conversationOpen, setConversationOpen] = useState(false);
    const [conversationWidth, setConversationWidth] = usePersistentState('domaintrail.layout.conversationWidth', 380);
    const [legendOpen, setLegendOpen] = usePersistentState('domaintrail.layout.legend', true);
    const [inspectorTab, setInspectorTab] = usePersistentState<InspectorTab>('domaintrail.inspector.tab', 'structure');

    const width = useWindowWidth();
    const [overrides, setOverrides] = useState<Overrides>(NO_OVERRIDES);
    const layout = effectiveLayout({ width, conversationOpen, left: leftSaved, dock: dockSaved, overrides });
    const { forced } = layout;
    // an override ends with the narrow window (or with the conversation closed): the saved choices are shown again
    useEffect(() => {
        setOverrides((o) => keptOverrides(o, { left: forced.left, dock: forced.dock }));
    }, [forced.left, forced.dock]);

    const leftWidth = LEFT_BAR + (layout.left ? explorerWidth : 0);
    const inspectorWidth = inspectorWidthSaved ?? autoInspectorWidth(width - leftWidth - (conversationOpen ? conversationWidth : 0));

    const setExplorerOpen = (open: boolean): void => {
        if (forced.left) setOverrides((o) => ({ ...o, left: open }));
        else setLeftSaved(open);
    };
    const setInspectorDock = (dock: Dock): void => {
        if (forced.dock) setOverrides((o) => ({ ...o, dock }));
        else setDockSaved(dock);
    };
    const setInspectorOpen = (open: boolean): void => {
        if (open) setDockContent('inspector');
        setDockOpen(open);
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
        inspectorOpen: dockOpen,
        setInspectorOpen,
        setDockOpen,
        dockContent,
        setDockContent,
        inspectorDock: layout.dock,
        setInspectorDock,
        inspectorWidth,
        setInspectorWidth,
        inspectorHeight,
        setInspectorHeight,
        conversationOpen,
        setConversationOpen,
        conversationWidth,
        setConversationWidth,
        legendOpen,
        setLegendOpen,
        inspectorTab,
        setInspectorTab,
        openInspector,
    };
}
