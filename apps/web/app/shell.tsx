import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Diff, FolderTree, PanelBottomOpen, TriangleAlert, type LucideIcon } from 'lucide-react';
// the approved logo (assets/brand, never redrawn), bundled into dist/web with a hashed name: one per theme
import logoDark from '../../../assets/brand/logo-dark.svg';
import logoLight from '../../../assets/brand/logo-light.svg';
import { useT } from '../i18n';
import { readStored, Resizer, useElementHeight, writeStored } from '../shared/layout';
import { usePaneMotion } from '../shared/motion';
import { Tooltips } from '../tooltip';
import { DETAIL_MIN, detailMax, detailSize, drawnDetailHeight, type LeftView, type Panes } from './panes';

/** Width of the activity bar (the collapsed left column); see styles.css. */
const BAR_WIDTH = 44;
/** Height of the rail a closed detail leaves at the bottom of the left column, with the button that opens it. */
const RAIL_SIZE = 28;
/** The left column's width, between these (and never leaving the canvas less than MIN_CANVAS_WIDTH). */
const LEFT_MIN = 220;
const LEFT_MAX = 560;
const MIN_CANVAS_WIDTH = 320;

/**
 * The conversation: a pillar at the right end of the page, the whole height, opened and closed by the reader (a
 * session's chat). While it is closed, `launcher` floats at the bottom right of the canvas to open it.
 */
export interface Conversation {
    readonly content: ReactNode;
    readonly launcher: ReactNode;
}

/** A session serving the page (its mode, from the page's boot) and whether its controls of the whole page arrived. */
export interface SessionBarState {
    readonly mode: 'Solo' | 'Collab';
    readonly ready: boolean;
}

/** Where the width the session's controls last had in the app bar is kept, per mode. */
export const sessionBarKey = (mode: SessionBarState['mode']): string => `domaintrail.layout.sessionBar.${mode}`;

/**
 * The width to keep for the session's controls in the app bar while they have not arrived (`ready` false): the one they
 * had when the page was last shown in this mode (null: none known, nothing is kept). Once they are there their width is
 * followed and remembered, for the next time.
 */
function useSessionBarSpace(slot: RefObject<HTMLDivElement | null>, session: SessionBarState | undefined): number | null {
    const mode = session?.mode;
    const ready = session?.ready ?? false;
    const [kept] = useState(() => (mode ? readStored<number | null>(sessionBarKey(mode), null) : null));
    useLayoutEffect(() => {
        const el = slot.current;
        if (!mode || !ready || !el) return;
        const remember = (): void => {
            const width = Math.round(el.getBoundingClientRect().width);
            if (width > 0) writeStored(sessionBarKey(mode), width);
        };
        remember();
        const observer = new ResizeObserver(remember);
        observer.observe(el);
        return () => observer.disconnect();
    }, [slot, mode, ready]);
    return mode && !ready && kept !== null && kept > 0 ? kept : null;
}

/** A list of the left pane, with the badge of its button in the activity bar and the count its accessible name tells. */
export interface LeftList {
    readonly content: ReactNode;
    readonly badge?: ReactNode;
    readonly count: number;
}

const LIST_ICONS: Record<LeftView, LucideIcon> = { tree: FolderTree, problems: TriangleAlert, changes: Diff };
const LISTS: readonly LeftView[] = ['tree', 'problems', 'changes'];
/** The lists the activity bar picks; 問題 is opened from the app bar (it concerns the whole page). */
const RAIL_LISTS: readonly LeftView[] = ['tree', 'changes'];

/**
 * The page's layout: the app bar across the top — the brand and the workspace's name, the world switch, then what
 * concerns the whole page (問題, and a session's people, AI state and menu) — and under it three columns: the left
 * column — its activity bar, the navigator (the lists) over the detail (the inspector) with a splitter between them,
 * and the health and the settings at its foot — the canvas with its banners, and the conversation at the right end,
 * when there is one. What goes in each place is the caller's.
 */
export function AppShell(props: {
    panes: Panes;
    /** The workspace's name, after the brand. */
    workspaceName: string | undefined;
    /** The world switch, after the workspace's name in the app bar. */
    world: ReactNode;
    /** Where a session puts its controls of the whole page, at the right end of the app bar. */
    sessionSlot: (slot: HTMLDivElement | null) => void;
    /** The session serving the page, known from the start (the page's boot): its controls' place is kept until they arrive. */
    session?: SessionBarState | undefined;
    lists: Record<LeftView, LeftList>;
    /** At the foot of the left column (at the bottom of its activity bar when collapsed). */
    health: ReactNode;
    settings: ReactNode;
    /** Notices over the canvas (connection lost, a model that does not parse…). */
    banners: ReactNode;
    workspace: ReactNode;
    /** The detail of the selected item (the inspector), under the navigator. */
    inspector: ReactNode;
    /** Composition point for the conversation pillar; nothing under `dt view` (yet). */
    conversation?: Conversation;
    /** Popups placed over the page (e.g. the baseline menu). */
    overlays: ReactNode;
}) {
    const { panes, conversation } = props;
    const { explorerOpen: leftOpen, setExplorerOpen, explorerWidth, setExplorerWidth, leftView, showLeft } = panes;
    const { inspectorOpen: detailOpen, setInspectorOpen: setDetailOpen, detailHeight, setDetailHeight } = panes;
    const { conversationOpen, setConversationOpen, conversationWidth, setConversationWidth } = panes;
    const t = useT();
    const conversationShown = conversation !== undefined && conversationOpen;
    const leftWidth = leftOpen ? BAR_WIDTH + explorerWidth : BAR_WIDTH;
    const conversationSpace = conversationShown ? conversationWidth : 0;
    // the split of the left column follows its height (the window's)
    const column = useRef<HTMLElement>(null);
    const columnHeight = useElementHeight(column);
    const detail = detailSize(detailHeight, columnHeight);
    // opening and closing panes move at different paces (the motion section of styles.css); not on the first display
    const motion = usePaneMotion([leftOpen, detailOpen, conversationShown]);
    const { sessionSlot } = props;
    const slot = useRef<HTMLDivElement | null>(null);
    const setSlot = useCallback(
        (el: HTMLDivElement | null): void => {
            slot.current = el;
            sessionSlot(el);
        },
        [sessionSlot],
    );
    const sessionSpace = useSessionBarSpace(slot, props.session);

    return (
        <div className={`app motion-${motion}`}>
            <header className="app-bar">
                <span className="app-bar-brand">
                    {/* the logo for the theme (the other hidden by CSS), decorative: the text beside it names it */}
                    <img className="brand-logo brand-logo-light" src={logoLight} alt="" />
                    <img className="brand-logo brand-logo-dark" src={logoDark} alt="" />
                    <span className="brand">DomainTrail</span>
                    {props.workspaceName && (
                        <span className="workspace-name" data-tooltip={props.workspaceName}>
                            {props.workspaceName}
                        </span>
                    )}
                </span>
                {props.world}
                <span className="app-bar-space" />
                <ProblemsButton panes={panes} list={props.lists.problems} />
                <div className="app-bar-session" ref={setSlot}>
                    {/* the session's controls' place, kept until they arrive (a quiet blank, the width they had) */}
                    {sessionSpace !== null && <span className="app-bar-session-pending" style={{ width: sessionSpace }} aria-hidden />}
                </div>
            </header>
            <div className="app-body">
                <div className={`left${leftOpen ? ' open' : ''}`} style={{ width: leftWidth }}>
                    <div className="left-main">
                        <div className="activity-bar" role="tablist" aria-orientation="vertical" aria-label={t.listsLabel}>
                            {RAIL_LISTS.map((k) => {
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
                        <aside className="pane left-pane" style={{ width: explorerWidth }} inert={!leftOpen} ref={column}>
                            <div className="navigator">
                                {/* every list stays mounted, so that switching keeps the tree's filter and the lists' scroll */}
                                {LISTS.map((k) => (
                                    <div key={k} className="left-content" hidden={leftView !== k}>
                                        {props.lists[k].content}
                                    </div>
                                ))}
                            </div>
                            <Resizer
                                direction="y"
                                size={detail}
                                min={DETAIL_MIN}
                                max={() => detailMax(column.current?.clientHeight ?? columnHeight)}
                                invert
                                open={detailOpen}
                                collapsed={RAIL_SIZE}
                                onResize={setDetailHeight}
                                onOpenChange={setDetailOpen}
                                onReset={() => setDetailHeight(null)}
                                label={t.resizeDetail}
                                grip
                            />
                            {/* the detail stays mounted while closed, so that it keeps its tab, its scroll and its diagram's camera */}
                            <div
                                className={`detail${detailOpen ? ' open' : ''}`}
                                style={{ height: drawnDetailHeight(detailOpen, detailHeight, columnHeight, RAIL_SIZE) }}
                            >
                                <div className="rail" inert={detailOpen}>
                                    <button
                                        className="icon-button"
                                        onClick={() => setDetailOpen(true)}
                                        data-tooltip={t.openInspector}
                                        aria-label={t.openInspector}
                                    >
                                        <PanelBottomOpen size={16} aria-hidden />
                                    </button>
                                </div>
                                <div className="detail-inner" style={{ height: detail }} inert={!detailOpen}>
                                    {props.inspector}
                                </div>
                            </div>
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
                    min={LEFT_MIN}
                    max={() => Math.min(LEFT_MAX, window.innerWidth - BAR_WIDTH - conversationSpace - MIN_CANVAS_WIDTH)}
                    open={leftOpen}
                    collapsed={0}
                    onResize={setExplorerWidth}
                    onOpenChange={setExplorerOpen}
                    onReset={() => setExplorerWidth(null)}
                    label={t.resizeLeft}
                />
                <div className="main">
                    <div className="canvas-pane">
                        <div className="banners">{props.banners}</div>
                        {props.workspace}
                        {conversation && !conversationOpen && <div className="launcher-slot">{conversation.launcher}</div>}
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
                                onReset={() => setConversationWidth(null)}
                                label={t.resizeConversation}
                            />
                        )}
                        <div className={`conversation${conversationOpen ? ' open' : ''}`} style={{ width: conversationSpace }} inert={!conversationOpen}>
                            <div className="pane conversation-inner" style={{ width: conversationWidth }}>
                                {conversation.content}
                            </div>
                        </div>
                    </>
                )}
            </div>
            {props.overlays}
            <Tooltips />
        </div>
    );
}

/** 問題 in the app bar: the number of errors (else warnings) as its badge; it opens the left pane on the problems, or closes it. */
function ProblemsButton({ panes, list }: { panes: Panes; list: LeftList }) {
    const t = useT();
    const active = panes.explorerOpen && panes.leftView === 'problems';
    return (
        <button
            className={`activity app-bar-problems${active ? ' active' : ''}`}
            aria-pressed={active}
            aria-label={t.listLabel(t.lists.problems, list.count)}
            data-tooltip={t.listHints.problems}
            onClick={() => (active ? panes.setExplorerOpen(false) : panes.showLeft('problems'))}
        >
            <TriangleAlert size={18} aria-hidden />
            {list.badge}
        </button>
    );
}
