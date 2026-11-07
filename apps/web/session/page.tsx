// The session's part of the page (ADR 0026): computed on every page, shown only in a session. Under `dt view` no
// `session.state` ever arrives, so `useSessionPage` gives nothing to draw, sends nothing and calls no session API.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { firstDeclarations } from '@domaintrail/storming';
import { type DisplayMode, LEVEL_KINDS, type ViewLevel } from '@domaintrail/visualization';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { contextNames } from '@domaintrail/modeling';
import type { Panes } from '../app/panes';
import type { Conversation } from '../app/shell';
import type { ViewSocket } from '../app/useViewSocket';
import { useT } from '../i18n';
import { contextLabels, resolve } from '../model-utils';
import { chooseScope, choosePlace, revealIn, stormingGraph, type StormingChoice, type StormingDetailSession } from '../storming';
import { graphNodeOf, nodeItemId } from '../scene';
import { highlightElement, showItem } from '../view/canvas';
import { useCanvasValue } from '../view/diagram';
import { canStartFromEmpty } from '../view/empty';
import type { Workspace } from '../view/workspace';
import { aiPresence } from './ai';
import { ChatLauncher, SessionChat, type ChatGoTo } from './chat';
import { beginMessage, elementActivity, useRunChanges } from './element-activity';
import { selectedOf } from './slash';
import { PAGE_REVEAL, revealKeys } from './reveal';
import { PeerCursors } from './cursors';
import { TargetNamingProvider } from './naming';
import { viewLocation } from './location';
import { AddButton, SelectionAction, type AddAction } from './selection-action';
import { SessionApiError, sessionApi } from './api';
import type { StickySession, StickyWritten } from '../stickies/layer';
import { confirmSelection, isAdded, isConfirmKey, isTyping } from './selection';
import type { ComposerValue } from './mentions';
import { cursorsOn, NO_PEERS } from './presence';
import { FollowFrame, useFollowApproved, usePersonFollow } from './follow';
import type { ChatFollow } from './chat-context';
import { mentionCandidates } from './mentions';
import { openViewTarget, sentView, type ViewScope, type ViewTarget } from './views';
import {
    occurrenceNode,
    resolveTarget,
    targetKey,
    targetOfSelection,
    viewOfDeclaration,
    type ModelTarget,
    type NamingContext,
    type TargetDraft,
} from './targets';
import { agentStatus, latestAt, participantNames, speakerName, streamItems, unreadCount, unreadMentions } from './stream';
import type { KnowledgeView } from '../knowledge/useKnowledge';
import { defaultDraftStorage, useComposerDraft, usePresence, useSession } from './useSession';
import { journeyOverview, journeysOfContext, journeysOfStorming, pageGuideWorkspace } from './journey-view';
import { JourneyDetail } from './journey-detail';
import { TurnMarksBar, useTurnMarks } from './turn-marks';

export interface SessionPage {
    /** The session's chat for `AppShell`'s `conversation`, for everyone; undefined outside a session. */
    readonly conversation: Conversation | undefined;
    /** The others' cursors over the canvas, and the selection's 💬; undefined outside a session. */
    readonly canvasOverlay: ReactNode;
    /** The 💬 next to the selected element's name in the inspector's heading, while a session is live. */
    readonly inspectorAction: ReactNode;
    /** What the detail of a storming element shows of the session and the actions it begins; undefined outside a session. */
    readonly stormingDetail: StormingDetailSession | undefined;
    /** In a session only the facilitator changes the shared baseline (the server answers others 403). */
    readonly baselineLocked: boolean;
    /** The collab ended: the server is gone for good, so the page does not say it waits to reconnect (the summary says it ended). */
    readonly ended: boolean;
    /** An AI is connected to the live chat (every role) and the person may start `/es`: an empty view points to it. */
    readonly aiReady: boolean;
    /** A selected context's modeling journeys, in brief (the detail). */
    readonly contextJourneys?: (context: string) => ReactNode;
    /** A knowledge item's source when the session holds its message: its author as the chat names them, and going to it. */
    readonly messageOf?: KnowledgeView['messageOf'];
    /** What the stickies' actions get of the session (ADR 0033): adding to the chat, and editing; undefined outside a session. */
    readonly stickies: StickySession | undefined;
}

/** The hotspots the AI named after a person added them under a provisional name: `es/S/<provisional>` → `es/S/<name>`. */
export function renamedHotspots(runs: SessionStateBody['runs']): Map<string, string> {
    const out = new Map<string, string>();
    for (const r of runs) {
        if (r.state !== 'Edited' || r.hotspotName === undefined) continue;
        const added = r.input.requests[0]?.edit;
        if (added?.kind === 'HotspotAdded') out.set(`es/${added.storming}/${added.hotspot}`, `es/${added.storming}/${r.hotspotName}`);
    }
    return out;
}

/** A person's edit of a sticky, written by the server; a refusal is thrown as its error body (`type`, `current`, …). */
async function editSticky(edit: object, body: string): Promise<StickyWritten> {
    try {
        const answer = await sessionApi.editSticky(edit, body);
        // a new hotspot's name, the AI's or dt's: the page selects it once drawn
        const request: unknown = typeof answer === 'object' && answer !== null && 'request' in answer ? answer.request : undefined;
        const written: unknown = typeof request === 'object' && request !== null && 'edit' in request ? request.edit : undefined;
        const hotspot =
            typeof written === 'object' && written !== null && 'hotspot' in written && typeof written.hotspot === 'string' ? written.hotspot : undefined;
        return hotspot === undefined ? {} : { hotspot };
    } catch (e) {
        if (e instanceof SessionApiError) throw { ...e.detail, type: e.type };
        throw e;
    }
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
    /** The app bar's place for the session's controls of the whole page (the collab menu, the AI's state). */
    barSlot: HTMLElement | null;
    /** The app bar's place for the current journey's chip, after the world switch. */
    journeySlot: HTMLElement | null;
}): SessionPage {
    const { socket, current, workspace, panes } = input;
    const { canvas, stormings, nav, settings, viewGraph } = workspace;
    const { view } = nav;
    const session = useSession(socket, current);
    // what the guide reads, as the page holds it: the chip, the panel and the guide card's maps are computed from it
    const journeyFile = session?.journey.file;
    const guideWorkspace = useMemo(() => pageGuideWorkspace(current, journeyFile), [current, journeyFile]);
    // the journeys panel: opened from the chip, the guide card and the detail
    const [journeysOpen, setJourneysOpen] = useState(false);
    const chosenJourney = session?.state.session.currentJourney;
    const overview = useMemo(() => journeyOverview(guideWorkspace, chosenJourney), [guideWorkspace, chosenJourney]);
    const allJourneys = [overview.current, ...overview.others, ...overview.archived].flatMap((j) => (j ? [j] : []));
    const currentKey = overview.current?.summary.key;
    const openJourneys = (): void => setJourneysOpen(true);
    // what the chat holds when the page first has the session is its history (clamped), even with the chat closed
    if (session) PAGE_REVEAL.history(session.state.session.id, () => revealKeys(session.state));
    const model = current?.model ?? null;
    const naming = useMemo((): NamingContext => ({ mode: input.mode, model, stormings }), [input.mode, model, stormings]);
    const t = useT();

    const location = viewLocation({
        view,
        viewKey: viewGraph.cameraKey(view),
        graph: viewGraph.graph,
        storming: viewGraph.shown && {
            id: viewGraph.shown.storming.id,
            options: viewGraph.shown.options,
            flow: viewGraph.shown.flow,
            stageId: viewGraph.shown.stageId,
        },
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

    // where a message is sent from: the view, a storming's stage and exceptions, the catalog's filter, and the
    // aggregate whose state diagram the inspector shows
    const resolvedSelection = model && nav.selected ? resolve(model, nav.selected) : undefined;
    const statesOf =
        panes.explorerOpen && panes.leftView === 'tree' && panes.inspectorTab === 'states' && resolvedSelection
            ? resolvedSelection.kind === 'element'
                ? resolvedSelection.el.kind === 'aggregate'
                    ? resolvedSelection.el.id
                    : undefined
                : resolvedSelection.kind === 'state' || resolvedSelection.kind === 'command'
                  ? resolvedSelection.agg.id
                  : undefined
            : undefined;
    const viewedAt = sentView({
        location,
        ...(view.kind === 'catalog' && { catalog: workspace.catalog.filter }),
        ...(statesOf !== undefined && { states: statesOf }),
    });

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

    // what `/` lists depends on the view (a storming at its level, a `.dt` view) and the element selected
    const level = viewGraph.shown?.options.level;
    const slash = useMemo(
        () => ({
            view:
                view.kind === 'storming'
                    ? ({ kind: 'storming', level: level ?? 'big-picture' } as const)
                    : view.kind === 'catalog' || view.kind === 'structure' || view.kind === 'contextMap'
                      ? ({ kind: 'model' } as const)
                      : ({ kind: 'other' } as const),
            selected: selectionTarget,
        }),
        // the selection is covered by its key
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [view.kind, level, selectionTarget && targetKey(selectionTarget.target)],
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

    // the detail of a storming element: what the session did about it, the way to it in the chat and AI の作業, and the
    // beginnings of messages about it
    const runChanges = useRunChanges(session?.state);
    // what a turn changed, marked on the storming canvas: the latest turn's as it ends, a card's on 図で見る
    const turnMarks = useTurnMarks(session?.state, workspace, input.mode);
    const [goTo, setGoTo] = useState<ChatGoTo | undefined>();
    const go = useCallback(
        (kind: ChatGoTo['kind'], id: string): void => {
            setConversationOpen(true);
            setGoTo((g) => ({ kind, id, n: (g?.n ?? 0) + 1 }));
        },
        [setConversationOpen],
    );
    const begin = useCallback(
        (elementId: string, write: (target: string) => string): void => {
            const target = targetOfSelection({ selected: elementId, model, stormings, sources: sources ?? [] });
            if (!target) return;
            const mention = selectedOf(target, candidates)?.mention ?? target.label ?? elementId;
            setComposerValue(beginMessage(composerValue, target, mention, write));
            setConversationOpen(true);
            setFocusPending(true);
        },
        [model, stormings, sources, candidates, composerValue, setComposerValue, setConversationOpen],
    );

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
        (written: ModelTarget) => {
            // as the reference was named (`resolveTarget`): by its label, `es:` left out, …
            const target = resolveTarget(written, naming) ?? written;
            if (target.kind === 'Workspace') return;
            if (target.kind === 'DtElement') return openBest(target.element);
            const storming = stormings.find((s) => s.id === target.storming);
            if (!storming) return;
            /** The whole storming of the target, at `level`, its flow kept where it can be (`choosePlace`). */
            const whole = (level: ViewLevel): StormingChoice => choosePlace(stormings, { ...stormingChoice, stormingId: target.storming, level }, '');
            if (target.kind === 'DtesStorming') {
                // the whole storming: its integrated canvas, at the level chosen, the storming in the inspector (its
                // description: an interview's brief)
                setStormingChoice(whole(stormingChoice.level));
                setView({ kind: 'storming' });
                select(`es/${target.storming}`, { highlight: false });
                return;
            }
            if (target.kind === 'DtesElement') {
                const id = `es/${target.storming}/${target.local}`;
                // a timeline, an exception or a stage: its own view, as the storming navigator opens it (`chooseScope`); a
                // group: the view of its timeline. The declaration in the inspector.
                const scope = viewOfDeclaration(storming.storming, target.local);
                if (scope !== undefined) {
                    setStormingChoice(chooseScope(stormings, stormingChoice, target.storming, scope));
                    setView({ kind: 'storming' });
                    select(id, { highlight: false });
                    return;
                }
                // the integrated canvas, at a level that draws the element, with what the 絞り込み hides of it shown
                const kind = firstDeclarations(storming.storming).get(target.local)?.kind;
                const drawn = LEVEL_KINDS[stormingChoice.level].some((k) => k === kind);
                const level = drawn ? stormingChoice.level : 'design-level';
                setStormingChoice(revealIn(stormings, whole(level), id));
                setView({ kind: 'storming' });
                select(id, { highlight: false });
                requestAnimationFrame(() => requestAnimationFrame(() => canvas && highlightElement(canvas, id)));
                return;
            }
            // an occurrence: its timeline's view (an exception's case), and the note of that step
            const choice = chooseScope(stormings, stormingChoice, target.storming, target.timeline);
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
        [canvas, naming, stormings, stormingChoice, setStormingChoice, select, setView, openBest],
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
    const openView = useCallback((target: ViewTarget) => openViewTarget(target, { setView, settings }), [setView, settings]);

    // following (docs/live-view.md, "Following"): a participant to their view and camera, the AI from a request the
    // reader sends or their proposal approved; the AI chosen is brought to its latest changes at once
    const { follow } = workspace;
    usePersonFollow(follow, session?.peers ?? NO_PEERS, location, viewScope);
    useFollowApproved(follow, session?.state.proposals, session?.me.participant.id);
    const followTurns = turnMarks.follow;
    const chatFollow = useMemo(
        (): ChatFollow => ({
            followee: follow.followee,
            choose: (f) => {
                follow.choose(f);
                if (f?.kind === 'ai') followTurns();
            },
            asked: follow.asked,
        }),
        [follow, followTurns],
    );

    if (!session)
        return {
            conversation: undefined,
            canvasOverlay: undefined,
            inspectorAction: undefined,
            stormingDetail: undefined,
            baselineLocked: false,
            ended: false,
            aiReady: false,
            stickies: undefined,
        };
    const facilitator = session.me.participant.role === 'facilitator';
    const names = participantNames(session.state, session.peers, session.me);
    return {
        messageOf: (sessionId, message) => {
            const request = sessionId === session.state.session.id ? session.state.requests.find((r) => r.id === message) : undefined;
            return (
                request && {
                    who: speakerName(request.author, session.me.participant.id, (id) => names.get(id) ?? id, t.session.chat.you),
                    open: () => go('message', message),
                }
            );
        },
        baselineLocked: !facilitator,
        ended,
        // the empty view points to its world's `/…:start` (anyone may start it)
        aiReady: canStartFromEmpty({ ended, aiConnected: aiPresence(session.state.agent).kind === 'connected' }),
        canvasOverlay: (
            <>
                <PeerCursors canvas={canvas} cursors={cursorsOn(session.peers, location)} />
                <FollowFrame followee={follow.followee} faint={follow.followee?.kind === 'ai' && agentStatus(session.state.runs).kind === 'idle'} />
                {/* on a storming, the stickies' toolbar has the 💬 among its actions (ADR 0033) */}
                {view.kind !== 'storming' && <SelectionAction canvas={canvas} action={addAction(selectionTargets)} />}
                {view.kind === 'storming' && <TurnMarksBar canvas={canvas} marks={turnMarks} stormings={stormings} choice={stormingChoice} />}
            </>
        ),
        inspectorAction: inspectorAdd && <AddButton action={inspectorAdd} />,
        stickies: {
            live,
            chat: { added: isAdded(composerValue, selectionTargets), add: () => confirm(selectionTargets) },
            edit: editSticky,
            renamed: renamedHotspots(session.state.runs),
        },
        stormingDetail: {
            activity: (el) => elementActivity(session.state, runChanges, el),
            ...(live && { begin }),
            openMessage: (id) => go('message', id),
            openRun: (id) => go('run', id),
            openRuns: (id) => go('unit', id),
            journeys: (storming) => {
                const keys = new Set(
                    journeysOfStorming(journeyFile, storming)
                        .filter((j) => j.kind === 'es')
                        .map((j) => j.key),
                );
                return <JourneyDetail items={allJourneys.filter((j) => keys.has(j.summary.key))} current={currentKey} onOpen={openJourneys} empty />;
            },
        },
        contextJourneys: (context) => {
            const keys = new Set(journeysOfContext(journeyFile, context).map((j) => j.key));
            return <JourneyDetail items={allJourneys.filter((j) => keys.has(j.summary.key))} current={currentKey} onOpen={openJourneys} />;
        },
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
                        slash={slash}
                        viewedAt={viewedAt}
                        onOpenView={openView}
                        follow={chatFollow}
                        onNavigate={navigate}
                        onSeeChanges={turnMarks.see}
                        goTo={goTo}
                        onOpen={() => setConversationOpen(true)}
                        onClose={() => setConversationOpen(false)}
                        barSlot={input.barSlot}
                        journeySlot={input.journeySlot}
                        guideWorkspace={guideWorkspace}
                        journeysOpen={journeysOpen}
                        setJourneysOpen={setJourneysOpen}
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
