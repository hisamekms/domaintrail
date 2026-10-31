import { useRef, useState, type ReactNode } from 'react';
import { Diff, Ellipsis, FolderTree, PanelBottomOpen, PanelRightOpen, TriangleAlert, Waypoints, type LucideIcon } from 'lucide-react';
import { useT } from '../i18n';
import { Resizer, useDismiss } from '../shared/layout';
import { Tooltips } from '../tooltip';
import type { LeftView, Panes } from './panes';

/** Width of the activity bar (the collapsed left pane), and of the rail a closed dock leaves (its height below the canvas); see styles.css. */
const BAR_WIDTH = 44;
const RAIL_SIZE = 28;
/** The dock can be widened until the canvas is this narrow, and raised until the canvas is this low. */
const MIN_CANVAS_WIDTH = 320;
const MIN_CANVAS_HEIGHT = 200;

/**
 * Another content of the dock, switchable with the inspector from the dock's menu: the facilitator's session panel in
 * a session (`dt session start`). `content` is given the dock's menu, to place in its head.
 */
export interface DockAlternative {
    /** The menu item and the rail's button switching to it. */
    readonly label: string;
    readonly icon: ReactNode;
    /** Next to its button on the rail (e.g. how many are online). */
    readonly badge?: ReactNode;
    readonly content: (menu: ReactNode) => ReactNode;
}

/**
 * The conversation: a pillar at the right end of the page, the whole height, opened and closed by the reader (a
 * session's chat). While it is closed, `launcher` floats at the bottom right of the canvas to open it.
 */
export interface Conversation {
    readonly content: ReactNode;
    readonly launcher: ReactNode;
}

/** A list of the left pane, with the badge of its button in the activity bar and the count its accessible name tells. */
export interface LeftList {
    readonly content: ReactNode;
    readonly badge?: ReactNode;
    readonly count: number;
}

const LIST_ICONS: Record<LeftView, LucideIcon> = { tree: FolderTree, problems: TriangleAlert, changes: Diff };
const LISTS: readonly LeftView[] = ['tree', 'problems', 'changes'];

/**
 * The page's layout, two pillars without a header: the workspace — the left pane (its activity bar and lists, the
 * brand and the workspace's name at its head, the health and the settings at its foot), the canvas with its banners,
 * and the dock (the inspector, right of or below the canvas) — and the conversation at the right end, when there is
 * one. What goes in each place is the caller's.
 */
export function AppShell(props: {
    panes: Panes;
    /** The workspace's name, after the brand. */
    workspaceName: string | undefined;
    lists: Record<LeftView, LeftList>;
    /** At the foot of the left pane (at the bottom of its activity bar when collapsed). */
    health: ReactNode;
    settings: ReactNode;
    /** Notices over the canvas (connection lost, a model that does not parse…). */
    banners: ReactNode;
    workspace: ReactNode;
    /** The inspector, given the dock's menu to place in its head. */
    inspector: (menu: ReactNode) => ReactNode;
    dockAlternative?: DockAlternative;
    /** Composition point for the conversation pillar; nothing under `dt view` (yet). */
    conversation?: Conversation;
    /** Popups placed over the page (e.g. the baseline menu). */
    overlays: ReactNode;
}) {
    const { panes, dockAlternative, conversation } = props;
    const { explorerOpen: leftOpen, setExplorerOpen, explorerWidth, setExplorerWidth, leftView, showLeft } = panes;
    const { inspectorOpen: dockOpen, setDockOpen, inspectorDock: dock, inspectorWidth, setInspectorWidth, inspectorHeight, setInspectorHeight } = panes;
    const { conversationOpen, setConversationOpen, conversationWidth, setConversationWidth } = panes;
    const t = useT();
    const showsAlternative = dockAlternative !== undefined && panes.dockContent === 'alternative';
    const conversationShown = conversation !== undefined && conversationOpen;
    const right = dock === 'right';
    const dockSize = right ? inspectorWidth : inspectorHeight;
    const menu = <DockMenu panes={panes} showsAlternative={showsAlternative} {...(dockAlternative && { alternative: dockAlternative.label })} />;
    const leftWidth = leftOpen ? BAR_WIDTH + explorerWidth : BAR_WIDTH;
    const conversationSpace = conversationShown ? conversationWidth : 0;

    return (
        <div className="app">
            <div className={`left${leftOpen ? ' open' : ''}`} style={{ width: leftWidth }}>
                <div className="left-head">
                    <span className="brand-mark" aria-hidden>
                        <Waypoints size={20} />
                    </span>
                    <span className="brand-text" inert={!leftOpen}>
                        <span className="brand">DomainTrail</span>
                        {props.workspaceName && (
                            <span className="workspace-name" data-tooltip={props.workspaceName}>
                                {props.workspaceName}
                            </span>
                        )}
                    </span>
                </div>
                <div className="left-main">
                    <div className="activity-bar" role="tablist" aria-orientation="vertical" aria-label={t.listsLabel}>
                        {LISTS.map((k) => {
                            const Icon = LIST_ICONS[k];
                            const active = leftOpen && leftView === k;
                            const list = props.lists[k];
                            return (
                                <button
                                    key={k}
                                    role="tab"
                                    aria-selected={active}
                                    className={`activity${active ? ' active' : ''}`}
                                    aria-label={t.listLabel(t.lists[k], list.count)}
                                    data-tooltip={t.listHints[k]}
                                    onClick={() => (active ? setExplorerOpen(false) : showLeft(k))}
                                >
                                    <Icon size={20} aria-hidden />
                                    {list.badge}
                                </button>
                            );
                        })}
                    </div>
                    <aside className="pane left-pane" style={{ width: explorerWidth }} inert={!leftOpen}>
                        {/* every list stays mounted, so that switching keeps the tree's filter and the lists' scroll */}
                        {LISTS.map((k) => (
                            <div key={k} className="left-content" hidden={leftView !== k}>
                                {props.lists[k].content}
                            </div>
                        ))}
                    </aside>
                </div>
                <div className="left-foot">
                    {props.health}
                    {props.settings}
                </div>
            </div>
            <Resizer
                direction="x"
                size={explorerWidth}
                min={180}
                max={480}
                open={leftOpen}
                collapsed={0}
                onResize={setExplorerWidth}
                onOpenChange={setExplorerOpen}
            />
            <div className={`main main-${dock}`}>
                <div className="canvas-pane">
                    <div className="banners">{props.banners}</div>
                    {props.workspace}
                    {conversation && !conversationOpen && <div className="launcher-slot">{conversation.launcher}</div>}
                </div>
                <Resizer
                    key={dock}
                    direction={right ? 'x' : 'y'}
                    size={dockSize}
                    min={right ? 300 : 160}
                    max={() => (right ? window.innerWidth - leftWidth - conversationSpace - MIN_CANVAS_WIDTH : window.innerHeight - MIN_CANVAS_HEIGHT)}
                    invert
                    open={dockOpen}
                    collapsed={RAIL_SIZE}
                    onResize={right ? setInspectorWidth : setInspectorHeight}
                    onOpenChange={setDockOpen}
                />
                <div
                    className={`dock dock-${dock}${dockOpen ? ' open' : ''}`}
                    style={right ? { width: dockOpen ? dockSize : RAIL_SIZE } : { height: dockOpen ? dockSize : RAIL_SIZE }}
                >
                    <div className="rail" inert={dockOpen}>
                        <button
                            className="icon-button"
                            onClick={() => panes.setInspectorOpen(true)}
                            data-tooltip={t.openInspector}
                            aria-label={t.openInspector}
                        >
                            {right ? <PanelRightOpen size={16} aria-hidden /> : <PanelBottomOpen size={16} aria-hidden />}
                        </button>
                        {dockAlternative && (
                            <>
                                <button
                                    className="icon-button"
                                    onClick={() => {
                                        panes.setDockContent('alternative');
                                        setDockOpen(true);
                                    }}
                                    data-tooltip={dockAlternative.label}
                                    aria-label={dockAlternative.label}
                                >
                                    {dockAlternative.icon}
                                </button>
                                {dockAlternative.badge}
                            </>
                        )}
                    </div>
                    <aside className="pane" style={right ? { width: dockSize } : { height: dockSize }} inert={!dockOpen}>
                        {/* both stay mounted, so that switching keeps what is typed in the session panel */}
                        <div className="dock-content" hidden={showsAlternative}>
                            {props.inspector(menu)}
                        </div>
                        {dockAlternative && (
                            <div className="dock-content" hidden={!showsAlternative}>
                                {dockAlternative.content(menu)}
                            </div>
                        )}
                    </aside>
                </div>
            </div>
            {conversation && (
                <>
                    {conversationOpen && (
                        <Resizer
                            direction="x"
                            size={conversationWidth}
                            min={300}
                            max={() => window.innerWidth - leftWidth - MIN_CANVAS_WIDTH}
                            invert
                            open={conversationOpen}
                            collapsed={0}
                            onResize={setConversationWidth}
                            onOpenChange={setConversationOpen}
                        />
                    )}
                    <div className={`conversation${conversationOpen ? ' open' : ''}`} style={{ width: conversationSpace }} inert={!conversationOpen}>
                        <div className="pane conversation-inner" style={{ width: conversationWidth }}>
                            {conversation.content}
                        </div>
                    </div>
                </>
            )}
            {props.overlays}
            <Tooltips />
        </div>
    );
}

/**
 * The dock's menu (⋯ in the head of the inspector and of its alternative): where the dock is (下に移動 / 右に移動), and
 * switching to the alternative, if there is one.
 */
function DockMenu({ panes, alternative, showsAlternative }: { panes: Panes; alternative?: string; showsAlternative: boolean }) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    useDismiss(open, root, () => setOpen(false));
    const pick = (f: () => void) => (): void => {
        f();
        setOpen(false);
    };
    const below = panes.inspectorDock === 'right';
    return (
        <div className="pane-menu" ref={root}>
            <button
                className="icon-button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t.paneMenu}
                data-tooltip={t.paneMenu}
                onClick={() => setOpen(!open)}
            >
                <Ellipsis size={16} aria-hidden />
            </button>
            {open && (
                <div className="pane-menu-list" role="menu">
                    <button role="menuitem" onClick={pick(() => panes.setInspectorDock(below ? 'bottom' : 'right'))}>
                        {below ? t.dockBelow : t.dockRight}
                    </button>
                    {alternative && (
                        <button role="menuitem" onClick={pick(() => panes.setDockContent(showsAlternative ? 'inspector' : 'alternative'))}>
                            {showsAlternative ? t.session.showInspector : alternative}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
