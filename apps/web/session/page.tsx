// The session's part of the page (ADR 0026): computed on every page, shown only in a session. Under `dt view` no
// `session.state` ever arrives, so `useSessionPage` gives nothing to draw, sends nothing and calls no session API.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { firstDeclarations } from '@domaintrail/storming';
import { type DisplayMode, LEVEL_KINDS } from '@domaintrail/visualization';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import { contextNames } from '@domaintrail/modeling';
import type { Panes } from '../app/panes';
import type { Conversation } from '../app/shell';
import type { ViewSocket } from '../app/useViewSocket';
import { useT } from '../i18n';
import { contextLabels } from '../model-utils';
import { stormingGraph, type StormingChoice } from '../storming';
import { graphNodeOf, nodeItemId } from '../scene';
import { highlightElement, showItem } from '../view/canvas';
import { useCanvasValue } from '../view/diagram';
import type { Workspace } from '../view/workspace';
import { aiPresence } from './ai';
import { ChatLauncher, SessionChat } from './chat';
import { PeerCursors } from './cursors';
import { TargetNamingProvider } from './naming';
import { viewLocation } from './location';
import { AddButton, SelectionAction, type AddAction } from './selection-action';
import { confirmSelection, isAdded, isConfirmKey, isTyping } from './selection';
import type { ComposerValue } from './mentions';
import { cursorsOn } from './presence';
import { mentionCandidates } from './mentions';
import type { ViewScope, ViewTarget } from './views';
import { occurrenceNode, targetKey, targetOfSelection, type ModelTarget, type NamingContext, type TargetDraft } from './targets';
import { agentStatus, latestAt, streamItems, unreadCount, unreadMentions } from './stream';
import { defaultDraftStorage, useComposerDraft, usePresence, useSession } from './useSession';

export interface SessionPage {
    /** The session's chat for `AppShell`'s `conversation`, for everyone; undefined outside a session. */
    readonly conversation: Conversation | undefined;
    /** The others' cursors over the canvas, and the selection's 💬; undefined outside a session. */
    readonly canvasOverlay: ReactNode;
    /** The 💬 next to the selected element's name in the inspector's heading, while a session is live. */
    readonly inspectorAction: ReactNode;
    /** In a session only the facilitator changes the shared baseline (the server answers others 403). */
    readonly baselineLocked: boolean;
    /** The collab ended: the server is gone for good, so the page does not say it waits to reconnect (the summary says it ended). */
    readonly ended: boolean;
    /** An AI is connected to the live chat (every role): an empty view says that asking there makes it. */
    readonly aiReady: boolean;
}

export function useSessionPage(input: {
    socket: ViewSocket;
    current: ViewPayload | null;
    workspace: Workspace;
    panes: Panes;
    /** The name display setting (ラベル / 名前 / 両方): targets are named in it. */
    mode: DisplayMode;
    /** Shows a `.dt` item in the view that suits it best (the explorer's double-click). */
    openBest: (id: string) => void;
}): SessionPage {
    const { socket, current, workspace, panes } = input;
    const { canvas, stormings, nav, settings, viewGraph } = workspace;
    const { view } = nav;
    const session = useSession(socket, current);
    const model = current?.model ?? null;
    const naming = useMemo((): NamingContext => ({ mode: input.mode, model, stormings }), [input.mode, model, stormings]);
    const t = useT();

    const location = viewLocation({
        view,
        viewKey: viewGraph.cameraKey(view),
        graph: viewGraph.graph,
        storming: viewGraph.shown && { id: viewGraph.shown.storming.id, options: viewGraph.shown.options },
    });
    const selectedItem = useCanvasValue(canvas, (c) => c?.onlySelectedId(), []);
    const selectedNode = selectedItem && graphNodeOf(selectedItem);
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
    usePresence(socket, session, canvas, location, selectionTarget?.target);

    // a selection of several items on the canvas: each targetable element once (the composer's `+` adds them all)
    const selectedKey = useCanvasValue(
        canvas,
        (c) => {
            if (!c) return '';
            const items = c.selectedIds();
            if (items.length < 2) return '';
            return JSON.stringify(
                items.flatMap((id) => {
                    const element = c.item(id)?.elementId;
                    return element ? [[element, graphNodeOf(id) ?? '']] : [];
                }),
            );
        },
        [],
    );
    const sources = current?.sources;
    const selectionTargets = useMemo((): TargetDraft[] => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written just above from [element, node] pairs
        const picked = selectedKey ? (JSON.parse(selectedKey) as [string, string][]) : [];
        if (picked.length === 0) return selectionTarget ? [selectionTarget] : [];
        const out: TargetDraft[] = [];
        for (const [selected, node] of picked) {
            const target = targetOfSelection({
                selected,
                model,
                stormings,
                sources: sources ?? [],
                ...(timelineView && { timelineView }),
                ...(node && { selectedNode: node }),
            });
            if (target && !out.some((o) => targetKey(o.target) === targetKey(target.target))) out.push(target);
        }
        return out;
        // the selection target and the timeline view are covered by their keys
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedKey, model, stormings, sources, selectionTarget && targetKey(selectionTarget.target), timelineView?.timelineId, timelineView?.render]);
    const candidates = useMemo(
        () => (session ? mentionCandidates({ mode: input.mode, model, stormings, sources: sources ?? [] }) : []),
        [session !== undefined, input.mode, model, stormings, sources],
    );

    const storage = useMemo(defaultDraftStorage, []);
    const scope = session && { session: session.me.session, participant: session.me.participant.id };
    const composer = useComposerDraft(storage, scope);

    // the selection added as the request's targets (💬 on the canvas or in the inspector, or `C`): the chat shown, the
    // caret in its text; what already is a chip is not added again
    const [focusPending, setFocusPending] = useState(false);
    const onFocused = useCallback(() => setFocusPending(false), []);
    const composerValue = composer.value;
    const setComposerValue = useCallback((v: ComposerValue) => composer.setValue(v), [composer]);
    const { conversationOpen, setConversationOpen } = panes;
    const confirm = useCallback(
        (targets: readonly TargetDraft[]) => {
            if (targets.length === 0) return;
            setComposerValue(confirmSelection(composerValue, targets).value);
            setConversationOpen(true);
            setFocusPending(true);
        },
        [composerValue, setComposerValue, setConversationOpen],
    );
    const live = session?.status === 'live' && session.state.session.state === 'Open';
    useEffect(() => {
        if (!live) return;
        const onKey = (e: KeyboardEvent): void => {
            if (selectionTargets.length === 0 || !isConfirmKey(e, isTyping(document.activeElement))) return;
            e.preventDefault();
            e.stopPropagation();
            confirm(selectionTargets);
        };
        // before the canvas's own shortcuts (it binds no plain `c`, but the key is ours here)
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [live, selectionTargets, confirm]);
    const addAction = (targets: readonly TargetDraft[]): AddAction | undefined =>
        live && targets.length > 0
            ? {
                  added: isAdded(composerValue, targets),
                  label: t.session.chat.addToRequest('C'),
                  addedLabel: t.session.chat.addedToRequest,
                  onAdd: () => confirm(targets),
              }
            : undefined;
    // the inspector's 💬 adds the element the inspector shows
    const inspectorAdd = addAction(selectionTarget ? [selectionTarget] : []);

    // the chat is the session's first place: the conversation opens when the page joins a session
    const inSession = session !== undefined;
    useEffect(() => {
        if (inSession) setConversationOpen(true);
        // only joining opens it; closing it afterwards is the reader's choice
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inSession]);
    // the collab ended: the chat opens, with its summary
    const ended = session !== undefined && (session.status === 'closed' || session.state.session.state === 'Closed');
    useEffect(() => {
        if (ended) setConversationOpen(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ended]);
    // what came since the chat was last shown: the floating button counts it
    const items = useMemo(() => (session ? streamItems(session.state) : []), [session?.state]);
    const latest = latestAt(items);
    const [seen, setSeen] = useState<string | undefined>();
    useEffect(() => {
        if (conversationOpen) setSeen(latest);
    }, [conversationOpen, latest]);

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
                requestAnimationFrame(() => requestAnimationFrame(() => canvas && highlightElement(canvas, id)));
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
            if (!canvas || !node) return;
            requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                    const item = nodeItemId(node);
                    if (canvas.item(item)) showItem(canvas, item);
                }),
            );
        },
        [canvas, stormings, stormingChoice, setStormingChoice, select, setView, openBest],
    );

    // another participant's view, opened here as it is (the view, not their camera)
    const viewScope = useMemo(
        (): ViewScope => ({
            mode: input.mode,
            contexts: model ? contextNames(model) : [],
            contextLabels: model ? contextLabels(model) : {},
            stormings,
        }),
        [input.mode, model, stormings],
    );
    const { setStructureLevel, setStructureContexts, setHiddenContexts, setMapAll } = settings;
    const openView = useCallback(
        (target: ViewTarget) => {
            switch (target.kind) {
                case 'catalog':
                    return setView({ kind: 'catalog' });
                case 'contextMap':
                    setMapAll(target.all);
                    return setView({ kind: 'contextMap' });
                case 'structure':
                    setStructureLevel(target.level);
                    setStructureContexts(target.focus ? [...target.focus.contexts] : null);
                    if (target.focus) setHiddenContexts([...target.focus.hidden]);
                    return setView({ kind: 'structure' });
                case 'storming': {
                    const { [target.stormingId]: _, ...others } = stormingChoice.timelines;
                    setStormingChoice({
                        stormingId: target.stormingId,
                        level: target.level,
                        timelines: target.timelineId === undefined ? others : { ...others, [target.stormingId]: target.timelineId },
                    });
                    return setView({ kind: 'storming' });
                }
            }
        },
        [setView, setMapAll, setStructureLevel, setStructureContexts, setHiddenContexts, stormingChoice, setStormingChoice],
    );

    if (!session) return { conversation: undefined, canvasOverlay: undefined, inspectorAction: undefined, baselineLocked: false, ended: false, aiReady: false };
    const facilitator = session.me.participant.role === 'facilitator';
    return {
        baselineLocked: !facilitator,
        ended,
        aiReady: !ended && aiPresence(session.state.agent).kind === 'connected',
        canvasOverlay: (
            <>
                <PeerCursors canvas={canvas} cursors={cursorsOn(session.peers, location)} />
                <SelectionAction canvas={canvas} action={addAction(selectionTargets)} />
            </>
        ),
        inspectorAction: inspectorAdd && <AddButton action={inspectorAdd} />,
        conversation: {
            content: (
                <TargetNamingProvider value={naming}>
                    <SessionChat
                        session={session}
                        composer={composer}
                        candidates={candidates}
                        focusPending={focusPending}
                        onFocused={onFocused}
                        location={location}
                        viewScope={viewScope}
                        onOpenView={openView}
                        onNavigate={navigate}
                        onClose={() => setConversationOpen(false)}
                    />
                </TargetNamingProvider>
            ),
            launcher: (
                <ChatLauncher
                    status={agentStatus(session.state.runs)}
                    unread={conversationOpen ? 0 : unreadCount(items, seen)}
                    mentions={conversationOpen ? 0 : unreadMentions(items, seen, session.state, session.me.participant.id)}
                    onOpen={() => setConversationOpen(true)}
                />
            ),
        },
    };
}
