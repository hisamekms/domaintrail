import type { BottomTab } from '../bottom';
import type { InspectorTab } from '../inspector';
import { usePersistentState } from '../shared/layout';

/** Which panes are open, their sizes and tabs, and whether the legend is open (remembered per browser). */
export interface Panes {
    explorerOpen: boolean;
    setExplorerOpen: (open: boolean) => void;
    inspectorOpen: boolean;
    setInspectorOpen: (open: boolean) => void;
    bottomOpen: boolean;
    setBottomOpen: (open: boolean) => void;
    explorerWidth: number;
    setExplorerWidth: (width: number) => void;
    inspectorWidth: number;
    setInspectorWidth: (width: number) => void;
    bottomHeight: number;
    setBottomHeight: (height: number) => void;
    bottomTab: BottomTab;
    setBottomTab: (tab: BottomTab) => void;
    legendOpen: boolean;
    setLegendOpen: (open: boolean) => void;
    inspectorTab: InspectorTab;
    setInspectorTab: (tab: InspectorTab) => void;
    /** Opens the inspector on `tab`. */
    openInspector: (tab: InspectorTab) => void;
}

export function usePanes(): Panes {
    const [explorerOpen, setExplorerOpen] = usePersistentState('domaintrail.layout.explorer', true);
    const [inspectorOpen, setInspectorOpen] = usePersistentState('domaintrail.layout.inspector', true);
    const [bottomOpen, setBottomOpen] = usePersistentState('domaintrail.layout.bottom', false);
    const [explorerWidth, setExplorerWidth] = usePersistentState('domaintrail.layout.explorerWidth', 260);
    const [inspectorWidth, setInspectorWidth] = usePersistentState('domaintrail.layout.inspectorWidth', 420);
    const [bottomHeight, setBottomHeight] = usePersistentState('domaintrail.layout.bottomHeight', 220);
    const [bottomTab, setBottomTab] = usePersistentState<BottomTab>('domaintrail.layout.bottomTab', 'problems');
    const [legendOpen, setLegendOpen] = usePersistentState('domaintrail.layout.legend', true);
    const [inspectorTab, setInspectorTab] = usePersistentState<InspectorTab>('domaintrail.inspector.tab', 'structure');
    const openInspector = (tab: InspectorTab): void => {
        setInspectorTab(tab);
        setInspectorOpen(true);
    };
    return {
        explorerOpen,
        setExplorerOpen,
        inspectorOpen,
        setInspectorOpen,
        bottomOpen,
        setBottomOpen,
        explorerWidth,
        setExplorerWidth,
        inspectorWidth,
        setInspectorWidth,
        bottomHeight,
        setBottomHeight,
        bottomTab,
        setBottomTab,
        legendOpen,
        setLegendOpen,
        inspectorTab,
        setInspectorTab,
        openInspector,
    };
}
