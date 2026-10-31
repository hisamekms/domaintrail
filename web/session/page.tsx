// The session's part of the page (ADR 0026): computed on every page, shown only in a session. Under `dt view` no
// `session.state` ever arrives, so `useSessionPage` gives nothing to draw, sends nothing and calls no session API.
import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { Users } from 'lucide-react';
import { createShapeId, useValue } from 'tldraw';
import { LEVEL_KINDS } from '@domaintrail/visualization/domain/storming/ir';
import { firstDeclarations } from '@domaintrail/visualization/domain/storming/semantic';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import type { Panes } from '../app/panes';
import type { ViewSocket } from '../app/useViewSocket';
import { useT } from '../i18n';
import { Resizer, usePersistentState } from '../shared/layout';
import { stormingGraph, type StormingChoice } from '../storming';
import { highlightElement } from '../view/canvas';
import type { Workspace } from '../view/workspace';
import { PeerCursors } from './cursors';
import { viewLocation } from './location';
import { SessionPanel } from './panel';
import { cursorsOn } from './presence';
import { occurrenceNode, targetOfSelection, type ModelTarget } from './targets';
import { defaultDraftStorage, useDrafts, usePresence, useSession } from './useSession';

/** Width of a closed side pane's rail (RAIL_WIDTH of app/shell.tsx). */
const RAIL_WIDTH = 28;
/** The graph node of a shape on the canvas (`render.ts`: `n:<graph node ID>`). */
const NODE_SHAPE = 'shape:n:';

export interface SessionPage {
    /** The session pane for `AppShell`'s `sidePanel`; undefined outside a session. */
    readonly sidePanel: ReactNode;
    /** The others' cursors over the canvas; undefined outside a session. */
    readonly canvasOverlay: ReactNode;
}

export function useSessionPage(input: {
    socket: ViewSocket;
    current: ViewPayload | null;
    workspace: Workspace;
    panes: Panes;
    /** Shows a `.dt` item in the view that suits it best (the explorer's double-click). */
    openBest: (id: string) => void;
}): SessionPage {
    const { socket, current, workspace, panes } = input;
    const { editor, stormings, nav, settings, viewGraph } = workspace;
    const { view } = nav;
    const session = useSession(socket, current);
    const t = useT();

    const location = viewLocation({
        view,
        viewKey: viewGraph.cameraKey(view),
        graph: viewGraph.graph,
        storming: viewGraph.shown && { id: viewGraph.shown.storming.id, options: viewGraph.shown.options },
    });
    const selectedShape = useValue('selected shape', () => editor?.getOnlySelectedShapeId() ?? undefined, [editor]);
    const selectedNode = selectedShape?.startsWith(NODE_SHAPE) ? selectedShape.slice(NODE_SHAPE.length) : undefined;
    const timelineId = viewGraph.shown?.options.timelineId;
    const timelineView =
        view.kind === 'storming' && viewGraph.shown && timelineId !== undefined && viewGraph.stormingShown
            ? { stormingId: viewGraph.shown.storming.id, timelineId, render: viewGraph.stormingShown.render }
            : undefined;
    const selectionTarget = targetOfSelection({
        selected: nav.selected,
        model: current?.model ?? null,
        stormings,
        sources: current?.sources ?? [],
        ...(timelineView && { timelineView }),
        ...(selectedNode && { selectedNode }),
    });
    usePresence(socket, session, editor, location, selectionTarget?.target);

    const storage = useMemo(defaultDraftStorage, []);
    const drafts = useDrafts(storage, session && { session: session.me.session, participant: session.me.participant.id });

    // the session pane and the inspector take turns on the right
    const [open, setOpen] = usePersistentState('domaintrail.layout.session', true);
    const [width, setWidth] = usePersistentState('domaintrail.layout.sessionWidth', 380);
    const { inspectorOpen, setInspectorOpen } = panes;
    const shown = session !== undefined && open;
    useEffect(() => {
        if (inspectorOpen && shown) setOpen(false);
        // only the inspector opening closes the session pane
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inspectorOpen]);
    useEffect(() => {
        if (shown && inspectorOpen) setInspectorOpen(false);
        // only the session pane opening (or the session starting with it open) closes the inspector
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shown]);
    const openPane = useCallback(
        (o: boolean) => {
            setOpen(o);
            if (o) setInspectorOpen(false);
        },
        [setOpen, setInspectorOpen],
    );

    const { select, setView } = nav;
    const { stormingChoice, setStormingChoice } = settings;
    const { openBest } = input;
    const navigate = useCallback(
        (target: ModelTarget) => {
            if (target.kind === 'Workspace') return;
            if (target.kind === 'DtElement') return openBest(target.element);
            const storming = stormings.find((s) => s.id === target.storming);
            if (!storming) return;
            const { [target.storming]: _, ...others } = stormingChoice.timelines;
            if (target.kind === 'DtesElement') {
                // the integrated canvas, at a level that draws the element
                const kind = firstDeclarations(storming.storming).get(target.local)?.kind;
                const drawn = LEVEL_KINDS[stormingChoice.level].some((k) => k === kind);
                const level = drawn ? stormingChoice.level : 'design-level';
                setStormingChoice({ stormingId: target.storming, level, timelines: others });
                const id = `es/${target.storming}/${target.local}`;
                setView({ kind: 'storming' });
                select(id, { highlight: false });
                requestAnimationFrame(() => requestAnimationFrame(() => editor && highlightElement(editor, id)));
                return;
            }
            // an occurrence: its timeline's view, and the note of that step
            const choice: StormingChoice = {
                stormingId: target.storming,
                level: stormingChoice.level,
                timelines: { ...others, [target.storming]: target.timeline },
            };
            setStormingChoice(choice);
            setView({ kind: 'storming' });
            select(`es/${target.storming}/${target.eventName}`, { highlight: false });
            const render = stormingGraph(stormings, choice)?.render;
            const node = render && occurrenceNode(render, target);
            if (!editor || !node) return;
            requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                    const shape = createShapeId(`n:${node}`);
                    if (!editor.getShape(shape)) return;
                    editor.select(shape);
                    const b = editor.getShapePageBounds(shape);
                    if (b && !editor.getViewportPageBounds().contains(b)) editor.centerOnPoint(b.center, { animation: { duration: 200 } });
                }),
            );
        },
        [editor, stormings, stormingChoice, setStormingChoice, select, setView, openBest],
    );

    if (!session) return { sidePanel: undefined, canvasOverlay: undefined };
    const online = new Set([...session.peers.values()].map((p) => p.participant.id)).size + 1;
    return {
        canvasOverlay: <PeerCursors editor={editor} cursors={cursorsOn(session.peers, location)} />,
        sidePanel: (
            <>
                <Resizer
                    direction="x"
                    size={width}
                    min={300}
                    max={() => window.innerWidth - 400}
                    invert
                    open={shown}
                    collapsed={RAIL_WIDTH}
                    onResize={setWidth}
                    onOpenChange={openPane}
                />
                <div className={`side side-right side-session${shown ? ' open' : ''}`} style={{ width: shown ? width : RAIL_WIDTH }}>
                    <div className="rail" inert={shown}>
                        <button className="icon-button" onClick={() => openPane(true)} data-tooltip={t.session.open} aria-label={t.session.open}>
                            <Users size={16} aria-hidden />
                        </button>
                        <span className="count">{online}</span>
                    </div>
                    <aside className="pane" style={{ width }} inert={!shown}>
                        <SessionPanel
                            session={session}
                            drafts={drafts}
                            location={location}
                            selectionTarget={selectionTarget}
                            onNavigate={navigate}
                            onShowInspector={() => setInspectorOpen(true)}
                            onClose={() => setOpen(false)}
                        />
                    </aside>
                </div>
            </>
        ),
    };
}
