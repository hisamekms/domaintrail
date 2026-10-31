import { useState, type ReactNode } from 'react';
import { PanelLeftOpen, PanelRightOpen } from 'lucide-react';
import { useT } from '../i18n';
import { Resizer } from '../shared/layout';
import { Tooltips } from '../tooltip';
import type { Panes } from './panes';

/** Width of the rail a closed side pane leaves, and height of the bottom pane's tab bar (with its border); see styles.css. */
const RAIL_WIDTH = 28;
const BOTTOM_BAR_HEIGHT = 33;
/** The inspector can be widened until the canvas is this narrow. */
const MIN_CANVAS_WIDTH = 320;

/**
 * Another content for the left pane, next to the explorer: the session's chat in a session (`dt session start`). With
 * one, the pane gets a switch at its top and shows this content first; without one (`dt view`) it shows the explorer
 * only, as always.
 */
export interface LeftPaneAlternative {
    /** The switch's label for it. */
    readonly label: string;
    readonly content: ReactNode;
}

/**
 * The page's layout: the top bar and its banners, the explorer and the inspector as resizable side panes around the
 * workspace, and the bottom pane. What goes in each place is the caller's.
 */
export function AppShell(props: {
    panes: Panes;
    topBar: ReactNode;
    banners: ReactNode;
    explorer: ReactNode;
    /** Composition point for another content of the left pane, switchable with the explorer; nothing under `dt view`. */
    leftAlternative?: LeftPaneAlternative;
    workspace: ReactNode;
    inspector: ReactNode;
    /**
     * Composition point for another side panel, placed after the inspector in the workspace row: the session pane in a
     * session (`dt session start`), nothing under `dt view`. Such a panel brings its own pane state and resizer.
     */
    sidePanel?: ReactNode;
    bottom: ReactNode;
    /** Popups placed over the page (e.g. the baseline menu). */
    overlays: ReactNode;
}) {
    const { panes } = props;
    const { explorerOpen, setExplorerOpen, explorerWidth, setExplorerWidth, inspectorOpen, setInspectorOpen, inspectorWidth, setInspectorWidth } = panes;
    const { bottomOpen, setBottomOpen, bottomHeight, setBottomHeight } = panes;
    const t = useT();
    // the alternative comes first whenever there is one; the choice is the page's (a reload starts on it again)
    const [leftShows, setLeftShows] = useState<'alternative' | 'explorer'>('alternative');
    const alternative = props.leftAlternative;
    const showsAlternative = alternative !== undefined && leftShows === 'alternative';

    return (
        <div className="app">
            {props.topBar}
            {props.banners}
            <div className="workspace">
                {/* side panes stay mounted so that opening and closing can be animated; a closed one shows its rail */}
                <div className={`side side-left${explorerOpen ? ' open' : ''}`} style={{ width: explorerOpen ? explorerWidth : RAIL_WIDTH }}>
                    <div className="rail" inert={explorerOpen}>
                        <button className="icon-button" onClick={() => setExplorerOpen(true)} data-tooltip={t.openExplorer} aria-label={t.openExplorer}>
                            <PanelLeftOpen size={16} aria-hidden />
                        </button>
                    </div>
                    <aside className="pane" style={{ width: explorerWidth }} inert={!explorerOpen}>
                        {alternative ? (
                            <>
                                <div className="left-switch" role="tablist">
                                    <button
                                        role="tab"
                                        aria-selected={!showsAlternative}
                                        className={showsAlternative ? '' : 'active'}
                                        onClick={() => setLeftShows('explorer')}
                                    >
                                        {t.explorerTab}
                                    </button>
                                    <button
                                        role="tab"
                                        aria-selected={showsAlternative}
                                        className={showsAlternative ? 'active' : ''}
                                        onClick={() => setLeftShows('alternative')}
                                    >
                                        {alternative.label}
                                    </button>
                                </div>
                                {/* both stay mounted, so that switching keeps the explorer's filter and the chat's scroll and text */}
                                <div className="left-content" hidden={showsAlternative}>
                                    {props.explorer}
                                </div>
                                <div className="left-content" hidden={!showsAlternative}>
                                    {alternative.content}
                                </div>
                            </>
                        ) : (
                            props.explorer
                        )}
                    </aside>
                </div>
                <Resizer
                    direction="x"
                    size={explorerWidth}
                    min={180}
                    max={480}
                    open={explorerOpen}
                    collapsed={RAIL_WIDTH}
                    onResize={setExplorerWidth}
                    onOpenChange={setExplorerOpen}
                />
                {props.workspace}
                <Resizer
                    direction="x"
                    size={inspectorWidth}
                    min={300}
                    max={() => window.innerWidth - (explorerOpen ? explorerWidth : RAIL_WIDTH) - MIN_CANVAS_WIDTH}
                    invert
                    open={inspectorOpen}
                    collapsed={RAIL_WIDTH}
                    onResize={setInspectorWidth}
                    onOpenChange={setInspectorOpen}
                />
                <div className={`side side-right${inspectorOpen ? ' open' : ''}`} style={{ width: inspectorOpen ? inspectorWidth : RAIL_WIDTH }}>
                    <div className="rail" inert={inspectorOpen}>
                        <button className="icon-button" onClick={() => setInspectorOpen(true)} data-tooltip={t.openInspector} aria-label={t.openInspector}>
                            <PanelRightOpen size={16} aria-hidden />
                        </button>
                    </div>
                    <aside className="pane" style={{ width: inspectorWidth }} inert={!inspectorOpen}>
                        {props.inspector}
                    </aside>
                </div>
                {props.sidePanel}
            </div>
            <Resizer
                direction="y"
                size={bottomHeight}
                min={120}
                max={600}
                invert
                open={bottomOpen}
                collapsed={BOTTOM_BAR_HEIGHT}
                onResize={setBottomHeight}
                onOpenChange={setBottomOpen}
            />
            <div className="bottom-wrap" style={{ height: bottomOpen ? bottomHeight : BOTTOM_BAR_HEIGHT }}>
                {props.bottom}
            </div>
            {props.overlays}
            <Tooltips />
        </div>
    );
}
