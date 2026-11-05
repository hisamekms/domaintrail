// The session's chat in the conversation pillar (ADR 0026, amendment: messages and apply; ADR 0030), the same for
// everyone: who is here, what the agent is doing and whether the AI is connected at a glance, then two views. チャット:
// one stream of every message (each is chat; those addressed to the AI — `@AI`, a reply to the AI, every message in
// Solo — show where they stand with it), the AI's answers as its messages, the change proposals it wrote for
// participants' 依頼 (`proposal.tsx`), one card per run with the runs that continue it (`card.tsx`), the revisions
// restored, and the composer of a message about the selection. AI の作業: everything sent to the AI, from start to end
// (awaiting an answer, running, queued, finished), with the same cards. The facilitator's controls are in the stream
// itself: send a message to the AI (the Bot button, the rescue for a forgotten `@AI`; … for several together, also
// chosen with Shift/⌘, and for the triage's record), approve or reject proposals, answer or pick an alternative on a
// card, cancel, and the menus of the cards and of the head. In Solo (`dt open`) what only makes sense with others is
// hidden: every message goes to the AI as it is sent.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react';
import { createPortal } from 'react-dom';
import {
    ArrowDown,
    Bot,
    Check,
    ChevronRight,
    CircleCheck,
    CircleHelp,
    CircleMinus,
    CircleSlash,
    CircleX,
    Clock,
    Ellipsis,
    Info,
    LoaderCircle,
    MessagesSquare,
    PencilLine,
    SendHorizontal,
    Ban,
    X,
    type LucideIcon,
} from 'lucide-react';
import { isInterviewCommandId } from '@domaintrail/collaboration';
import type { ViewLocation } from '@domaintrail/collaboration/protocol';
import { useDismiss } from '../shared/layout';
import { motionMs, useGrow, useSwap } from '../shared/motion';
import { useLang, useT } from '../i18n';
import { useChatActions, type QuestionChoice } from './actions';
import { ActivityLine } from './activity';
import {
    AI_PARTICIPANT,
    aiPresence,
    aiSlot,
    givenUpRequests,
    isAiAuthor,
    isRecord,
    isSolo,
    messageAi,
    settleOutgoing,
    triagesByRequest,
    willAddress,
    type AiSlot,
    type MessageAi,
    type Outgoing,
} from './ai';
import { sessionApi } from './api';
import { Bubble, Clamped, time } from './bubble';
import { arrival, clamps, followTop, HEAD_MARGIN, PAGE_REVEAL, revealKeys } from './reveal';
import { MarkdownText } from './markdown-text';
import { ChangedElements, ReplyButton, RunCard, useUnitAbout } from './card';
import { AddReaction, ReactionRow, useMarking } from './mark-controls';
import { messageMarks, updatedCards } from './cards';
import { ChatProvider, useChat, type ChatContextValue, type Tx } from './chat-context';
import { ChatHead, type ChatView } from './chat-head';
import { ComposerResizer, useComposerSize } from './composer-resizer';
import { changeUnits, requestersOf, shownUnits, statusUnit, unfinishedCount, unitName, workGroups, type ChangeUnit, type UnitOutcome } from './history';
import {
    addChips,
    composerKey,
    matchCandidates,
    matchPeople,
    MAX_REQUEST_MENTIONS,
    MAX_REQUEST_TARGETS,
    ownTokenName,
    removeChip,
    type MentionCandidate,
    type PersonCandidate,
} from './mentions';
import { useTargetNaming } from './naming';
import { CollabMenu, CollabSummaryDialog, openPeople, useCollabSummary } from './collab-menu';
import { JoinRequests } from './join-requests';
import { Avatar, failure, MentionedText, TargetChips } from './parts';
import { AiAvatar, ProposalCard } from './proposal';
import { chosenIndex } from './proposal-view';
import { referencesAsText } from './references';
import { TriageRecordPanel } from './triage-record';
import { InterviewChoices, InterviewPanel, interviewSlot } from './interview';
import { JourneyNoteActions } from './journey-note';
import { CandidatesCard, commandSlot } from './candidates';
import { GuideButton, startGuide, SuggestedMark } from './guide';
import { GuideCard } from './guide-card';
import { isGuide } from './guide-view';
import { CommandChip, CommandIcon } from './command-chip';
import { commandComposerValue } from './next-steps';
import {
    canStartCommand,
    commandOfOpening,
    commandType,
    guideButton,
    guideSuggestions,
    runningInterview,
    selectedOf,
    slashItems,
    slashQuery,
    templateValue,
    type SlashItem,
    type SlashScope,
} from './slash';
import { isReplyable, messageReference, messageReplyTargets, repliesToMe, replyReference, replyTargets, type ReplyDraft } from './replies';
import { useRevisionTools } from './revisions';
import { CancelButton, CancelDialog, RowActions, StatusSizer, StatusSlot, TurnLink } from './status-slot';
import { latestRevision } from './state';
import {
    agentStatus,
    arrivedBelow,
    changedAt,
    elapsed,
    isFacilitator,
    mentionablePeople,
    mentionsMe,
    participantAvatars,
    participantNames,
    placeAiSlots,
    speakerName,
    streamItems,
    targetShortText,
    targetText,
    type AgentStatus,
    type ChatEntry,
    type StreamItem,
} from './stream';
import { ComposerChips } from './composer-chips';
import { ComposerEditor, type ComposerEditorApi, type EditorQuery, type MentionLook } from './composer-editor';
import { mentionFits, type ComposerMention } from './composer-text';
import type { ModelTarget, TargetDraft } from './targets';
import { commandBody, interviewBody, messageBody } from './outgoing';
import { replyLooks, threadLines, type ReplyLook } from './threads';
import { continued, isMac } from './views';
import type { SentView, ViewScope, ViewTarget } from './views';
import type { ComposerDraft, SessionData } from './useSession';
import type { GuideWorkspace, JourneyAct } from '@domaintrail/collaboration';
import { JourneyChip } from './journey-panel';
import { journeyOverview } from './journey-view';
import { latestGuide } from './guide-view';
import { Act } from '../shared/act';
import { RecordRow } from './record-row';

type RequestJson = SessionData['state']['requests'][number];
/** A unit to open and reveal in AI の作業 (the header status clicked); `n` tells a click on the same unit again apart. */
type Peek = { readonly key: string; readonly n: number };

/**
 * Where another part of the page sends the chat (the detail of a storming element): a message or a run's card in the
 * chat, or a run's unit in AI の作業. `n` tells a second ask for the same place apart.
 */
export type ChatGoTo = { readonly kind: 'message' | 'run' | 'unit'; readonly id: string; readonly n: number };

/**
 * What the stream shows: its items by time (the messages still on their way last), its lines with the AI's cards placed
 * (Solo), the server's messages that stand for ones this page sent (their ID → this page's key for them, kept as their
 * rows' keys) and the messages still on their way (by that key).
 */
interface Shown {
    readonly items: readonly StreamItem[];
    readonly entries: readonly ChatEntry[];
    readonly sent: ReadonlyMap<string, string>;
    readonly waiting: ReadonlySet<string>;
}

/** The composer's side of the messages shown at once (Solo): one sent, the server's ID for it, one that failed. */
interface OutgoingTools {
    add(outgoing: Outgoing): void;
    settle(local: string, id: string): void;
    drop(local: string): void;
}

/** A run's answer before anything was chosen. */
const NO_CHOICES: Readonly<Record<string, QuestionChoice>> = {};

/**
 * Scrolls `list` (the scrolling box) so that `item` is wholly in it, as little as needed (`block: 'nearest'`), without
 * scrolling anything around the list.
 */
function keepInView(list: HTMLElement, item: HTMLElement): void {
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

/**
 * Caps the candidates' height to the room above the text, within the chat's view (under its header and tabs): however
 * tall the composer is, the list opens directly above the text and never over the header. It scrolls within itself.
 */
function fitAbove(list: HTMLElement): void {
    const anchor = list.parentElement;
    const view = list.closest('.chat-view');
    if (!anchor || !view) return;
    const room = anchor.getBoundingClientRect().top - view.getBoundingClientRect().top - 8;
    list.style.maxHeight = `min(16.25rem, 45vh, ${Math.max(48, Math.floor(room))}px)`;
}

/** The current time, ticking every second while `active`. */
function useNow(active: boolean): number {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        if (!active) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [active]);
    return now;
}

export function SessionChat(props: {
    session: SessionData;
    composer: ComposerDraft;
    /** What `#` offers. */
    candidates: readonly MentionCandidate[];
    /** The composer is asked to take the focus (the selection was just added with 💬 or `C`). */
    focusPending: boolean;
    onFocused: () => void;
    onNavigate: (target: ModelTarget) => void;
    /** This page's location (to tell who is on the same view). */
    location: ViewLocation;
    /** Opens the view another participant is on. */
    onOpenView: (target: ViewTarget) => void;
    /** What view names are made of, and which views this page can open. */
    viewScope: ViewScope;
    /** What is open and selected, for what `/` lists. */
    slash: { readonly view: SlashScope['view']; readonly selected: TargetDraft | undefined };
    /** Where this page is looking: sent with each message. */
    viewedAt: SentView | undefined;
    onOpen: () => void;
    onClose: () => void;
    /** The app bar's place for the collab menu and the AI's state (they concern the whole page). */
    barSlot: HTMLElement | null;
    /** The app bar's place for the current journey's chip, after the world switch. */
    journeySlot: HTMLElement | null;
    /** What the guide reads of the workspace as the page holds it (the view's model, stormings, findings; the journey file). */
    guideWorkspace: GuideWorkspace;
    /** The journeys panel open (it is opened from the detail too). */
    journeysOpen: boolean;
    setJourneysOpen: (open: boolean) => void;
    /** A place of the chat or of AI の作業 to show (asked from elsewhere on the page). */
    goTo?: ChatGoTo | undefined;
}) {
    const { session, composer, focusPending } = props;
    const { state, me } = session;
    const t = useT();
    const tx = t.session;
    const names = participantNames(state, session.peers, me);
    const nameOf = (id: string): string => names.get(id) ?? id;
    const avatars = participantAvatars(session.peers, me);
    const avatarOf = (id: string): string | undefined => avatars.get(id);
    const live = session.status === 'live' && state.session.state === 'Open';
    const control = live && me.participant.role === 'facilitator';
    const solo = isSolo(state);
    const triages = useMemo(() => triagesByRequest(state), [state]);
    const givenUp = useMemo(() => givenUpRequests(state), [state]);
    // the open proposals chosen to approve together: those no longer open drop out
    const [picks, setPicks] = useState<ReadonlySet<string>>(new Set());
    const openKey = (state.proposals ?? [])
        .filter((p) => p.state === 'Open')
        .map((p) => p.id)
        .join(',');
    const picked = useMemo(() => {
        const open = new Set(openKey.split(','));
        return new Set([...picks].filter((id) => open.has(id)));
    }, [picks, openKey]);
    // the option picked of each proposal with options, kept here so that approving several takes each one's pick
    const [options, setOptions] = useState<ReadonlyMap<string, number>>(new Map());
    const proposalPicks = useMemo(
        () => ({
            ids: picked,
            toggle: (id: string) =>
                setPicks((s) => {
                    const next = new Set(s);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                }),
            clear: () => setPicks(new Set()),
            options,
            choose: (id: string, option: number) => setOptions((m) => new Map(m).set(id, option)),
        }),
        [picked, options],
    );
    const status = agentStatus(state.runs);
    const items = useMemo(() => streamItems(state), [state]);
    // Solo: the messages this page sent, each shown at once with the AI's card under it, until the server's is here
    const [outgoing, setOutgoing] = useState<readonly Outgoing[]>([]);
    const settled = useMemo(() => settleOutgoing(outgoing, state.requests), [outgoing, state.requests]);
    const shown = useMemo((): Shown => {
        const waiting = settled.waiting.map((o): StreamItem => ({ kind: 'message', key: `message:${o.local}`, at: o.request.sentAt, request: o.request }));
        const slots = new Map<string, AiSlot>();
        // the AI's message replying to each message: its answer, maybe before its triage says so
        const aiReplies = new Map<string, string>();
        for (const r of state.requests) if (isAiAuthor(r.author) && r.replyTo?.kind === 'Message') aiReplies.set(r.replyTo.request, r.id);
        for (const r of state.requests) {
            // a message of an interview: the AI's question under it, or pending while the interviewer thinks
            const inInterview = solo ? (interviewSlot(state, r) ?? commandSlot(state, r)) : undefined;
            const slot =
                inInterview === 'none' ? undefined : (inInterview ?? aiSlot(solo, r, triages.get(r.id), givenUp, settled.sent.has(r.id), aiReplies.get(r.id)));
            if (slot) slots.set(r.id, slot);
        }
        for (const o of settled.waiting) slots.set(o.local, { kind: 'pending' });
        const all = [...items, ...waiting];
        return { items: all, entries: placeAiSlots(all, slots), sent: settled.sent, waiting: new Set(settled.waiting.map((o) => o.local)) };
    }, [items, settled, state.requests, solo, triages, givenUp]);
    const outgoingTools = useMemo(
        (): OutgoingTools => ({
            add: (o) => setOutgoing((all) => [...all, o]),
            settle: (local, id) => setOutgoing((all) => all.map((o) => (o.local === local ? { ...o, id } : o))),
            drop: (local) => setOutgoing((all) => all.filter((o) => o.local !== local)),
        }),
        [],
    );
    const units = useMemo(() => changeUnits(state), [state]);
    const marks = useMemo(() => messageMarks(units), [units]);
    const unfinished = unfinishedCount(units);
    const running = state.runs.some((r) => r.state === 'Running');
    const now = useNow(running);
    const actions = useChatActions();
    const marking = useMarking(session);
    // a revert just asked: its message, gone to once the stream has it and its card below it (the server's events may
    // come after its answer)
    const [revertAsked, setRevertAsked] = useState<{ readonly request: string; readonly run: string } | undefined>();
    const revisions = useRevisionTools(state, tx, setRevertAsked);
    const [leaveError, setLeaveError] = useState<string | undefined>();
    const leave = async (): Promise<void> => {
        try {
            const left = await sessionApi.leave();
            if (left.logout) location.assign(left.logout);
            else location.reload();
        } catch (e) {
            setLeaveError(failure(e));
        }
    };
    const [view, setView] = useState<ChatView>('chat');
    // the stream's scroll while チャット shows, put back as it shows again, with the browser's scroll anchoring off for
    // that frame: it would move the stream a little each time the panel comes back (at the bottom, the stream follows
    // the newest itself)
    const chatPanel = useRef<HTMLDivElement | null>(null);
    const streamTop = useRef<number | undefined>(undefined);
    const keepStreamTop = (e: UIEvent<HTMLDivElement>): void => {
        const el = e.target;
        if (el instanceof HTMLElement && el.classList.contains('chat-stream') && el.clientHeight > 0)
            streamTop.current = atBottomOf(el) ? undefined : el.scrollTop;
    };
    useLayoutEffect(() => {
        const el = chatPanel.current?.querySelector<HTMLElement>('.chat-stream');
        const top = streamTop.current;
        if (view !== 'chat' || !el || top === undefined) return;
        el.style.overflowAnchor = 'none';
        el.scrollTop = top;
        const frame = requestAnimationFrame(() => el.style.removeProperty('overflow-anchor'));
        return () => {
            cancelAnimationFrame(frame);
            el.style.removeProperty('overflow-anchor');
        };
    }, [view]);
    // the collab ended: its summary, shown once to everyone (and again from the notice)
    const ended = session.status === 'closed' || state.session.state === 'Closed';
    const summary = useCollabSummary(session, ended);
    const [summaryShown, setSummaryShown] = useState(false);
    const [summaryOpen, setSummaryOpen] = useState(false);
    useEffect(() => {
        if (!summary || summaryShown) return;
        setSummaryShown(true);
        setSummaryOpen(true);
    }, [summary, summaryShown]);
    // the reply being written (to an AI turn or a message): its chip above the composer; the composer takes the focus when it starts
    const [replyDraft, setReplyDraft] = useState<ReplyDraft | undefined>();
    const [replyFocus, setReplyFocus] = useState(0);
    const replies = useMemo(
        () => ({
            draft: replyDraft,
            start: (id: string): void => {
                const run = state.runs.find((r) => r.id === id);
                const ref = replyReference(units, id);
                if (!run || !ref || !isReplyable(run)) return;
                setReplyDraft({ kind: 'Run', run: id, name: ref.name });
                // the targets start with the replied run's requests' (editable as usual)
                composer.setValue(addChips(composer.value, replyTargets(run)).value);
                setView('chat');
                setReplyFocus((n) => n + 1);
            },
            startMessage: (id: string): void => {
                const request = state.requests.find((r) => r.id === id);
                if (!request) return;
                setReplyDraft({ kind: 'Message', request: id, author: request.author });
                // the targets start with the replied message's (editable as usual)
                composer.setValue(addChips(composer.value, messageReplyTargets(request)).value);
                setView('chat');
                setReplyFocus((n) => n + 1);
            },
            cancel: (): void => setReplyDraft(undefined),
            referenceOf: (run: string) => replyReference(units, run),
            messageReferenceOf: (request: string) => messageReference(state.requests, request),
        }),
        [replyDraft, state, composer, units],
    );
    // a command a step of `/guide` suggests: in the composer, `/`'s list open on it, the composer focused
    const putCommand = useCallback(
        (id: string): void => {
            composer.setValue(commandComposerValue(id));
            setView('chat');
            setReplyFocus((n) => n + 1);
        },
        [composer],
    );
    // an interview's その他: the composer, in the chat, focused
    const focusComposer = useCallback((): void => {
        setView('chat');
        setReplyFocus((n) => n + 1);
    }, []);
    // the selection confirmed for a request: the composer is in the chat
    useEffect(() => {
        if (focusPending) setView('chat');
    }, [focusPending]);

    // the messages chosen to apply together
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const selection = useMemo(
        () => ({
            active: selecting,
            ids: selected,
            toggle: (id: string) =>
                setSelected((s) => {
                    const next = new Set(s);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                }),
            start: (id: string) => {
                setSelecting(true);
                setSelected((s) => new Set([...s, id]));
            },
            clear: () => {
                setSelecting(false);
                setSelected(new Set());
            },
        }),
        [selecting, selected],
    );
    useEffect(() => {
        if (!selecting) return;
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') selection.clear();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [selecting, selection]);

    // the answers being chosen, per run: one draft for the chat's form and AI の作業's of the same run
    const [answerDrafts, setAnswerDrafts] = useState<Readonly<Record<string, Readonly<Record<string, QuestionChoice>>>>>({});
    const answers = useMemo(
        (): ChatContextValue['answers'] => ({
            of: (run) => answerDrafts[run] ?? NO_CHOICES,
            update: (run, f) => setAnswerDrafts((all) => ({ ...all, [run]: f(all[run] ?? NO_CHOICES) })),
        }),
        [answerDrafts],
    );
    const root = useRef<HTMLDivElement | null>(null);
    // an item of the stream, scrolled to the middle and marked for a moment (from AI の作業, a quote or a mark)
    const jump = useCallback((key: string): void => {
        setView('chat');
        requestAnimationFrame(() => {
            const el = root.current?.querySelector<HTMLElement>(`.chat-stream [data-item="${CSS.escape(key)}"]`);
            if (!el) return;
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            el.classList.add('chat-flash');
            setTimeout(() => el.classList.remove('chat-flash'), 1600);
        });
    }, []);

    useEffect(() => {
        if (revertAsked === undefined) return;
        const key = `message:${revertAsked.request}`;
        const card = items.some((i) => i.kind === 'card' && i.unit.runs.some((r) => r.run.id === revertAsked.run));
        if (!card || !items.some((i) => i.key === key)) return;
        setRevertAsked(undefined);
        jump(key);
    }, [revertAsked, items, jump]);

    // the header status clicked: AI の作業, at the unit it stands for (opened and revealed); the chat keeps its scroll
    const [peek, setPeek] = useState<Peek | undefined>();
    const peekStatus = (): void => {
        props.onOpen();
        setView('history');
        const unit = statusUnit(status.kind, units);
        if (unit) setPeek((p) => ({ key: unit.key, n: (p?.n ?? 0) + 1 }));
    };

    // a place asked from elsewhere on the page: a message or a run's card in the chat, a run's unit in AI の作業
    const goTo = props.goTo;
    useEffect(() => {
        if (!goTo) return;
        const unit = units.find((u) => u.runs.some((r) => r.run.id === goTo.id));
        if (goTo.kind === 'message') jump(`message:${goTo.id}`);
        else if (goTo.kind === 'run') {
            if (unit) jump(`card:${unit.key}`);
        } else {
            setView('history');
            if (unit) setPeek((p) => ({ key: unit.key, n: (p?.n ?? 0) + 1 }));
        }
        // only a new ask moves the chat
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [goTo?.n]);

    // a person shown among the participants (a mention of them clicked): the collab menu opens at them
    const showPerson = useCallback((id: string): void => openPeople(id), []);
    // the unit whose run is being cancelled: the dialog asking first
    const [cancelling, setCancelling] = useState<string | undefined>();
    const closeCancel = useCallback((): void => setCancelling(undefined), []);
    const cancellingUnit = cancelling === undefined ? undefined : units.find((u) => u.key === cancelling);

    // the long texts there when the page loaded are clamped (続きを表示); what arrives while it is open shows in full
    const history = PAGE_REVEAL.history(state.session.id, () => revealKeys(state));
    const reveal = useMemo(
        (): ChatContextValue['reveal'] => ({
            clamps: (key) => clamps(key, history, PAGE_REVEAL.opened),
            open: (key) => PAGE_REVEAL.opened.add(key),
        }),
        [history],
    );

    // the journeys: the overview computed live, the panel, the acts (a participant's become requests)
    const lang = useLang();
    const { journeysOpen, setJourneysOpen } = props;
    const [journeyNotice, setJourneyNotice] = useState<{ readonly text: string; readonly error: boolean } | undefined>();
    const overview = useMemo(() => journeyOverview(props.guideWorkspace, state.session.currentJourney), [props.guideWorkspace, state.session.currentJourney]);
    const journeyDone = (r: { readonly done: boolean }): void => setJourneyNotice(r.done ? undefined : { text: tx.chat.journeys.requested, error: false });
    const journeyFailed = (e: unknown): void => setJourneyNotice({ text: failure(e), error: true });
    const journeys: ChatContextValue['journeys'] = {
        body: session.journey,
        workspace: props.guideWorkspace,
        overview,
        open: journeysOpen,
        setOpen: (open) => {
            setJourneysOpen(open);
            if (!open) setJourneyNotice(undefined);
        },
        act: (act: JourneyAct) => void sessionApi.journeyAct(act, lang).then(journeyDone, journeyFailed),
        choose: (journey) => void sessionApi.chooseJourney(journey).then(journeyDone, journeyFailed),
        decide: (id, decision) => void sessionApi.decideJourneyRequest(id, decision, lang).then(() => setJourneyNotice(undefined), journeyFailed),
        seeGuide: () => {
            props.onOpen();
            const latest = latestGuide(state);
            if (latest && latest.state === 'Working') return jump(`command:${latest.id}`);
            void startGuide(sessionApi, { body: tx.chat.slash.commands.guide, language: lang, viewedAt: props.viewedAt }).then(
                () => setView('chat'),
                journeyFailed,
            );
        },
        notice: journeyNotice,
    };

    const context: ChatContextValue = {
        session,
        tx,
        now,
        nameOf,
        avatarOf,
        onNavigate: props.onNavigate,
        openView: props.onOpenView,
        control,
        solo,
        triages,
        givenUp,
        proposalPicks,
        actions,
        confirmCancel: setCancelling,
        answers,
        revisions,
        marks,
        marking,
        selection,
        jump,
        reveal,
        showPerson,
        putCommand,
        focusComposer,
        replies,
        journeys,
    };

    return (
        <ChatProvider value={context}>
            <JourneyChip slot={props.journeySlot} />
            <div className="session-chat" ref={root}>
                <SessionBar
                    slot={props.barSlot}
                    session={session}
                    status={status}
                    now={now}
                    live={live}
                    units={units}
                    location={props.location}
                    viewScope={props.viewScope}
                    onOpenView={props.onOpenView}
                    onLeave={() => void leave()}
                    onPeek={peekStatus}
                    tx={tx}
                />
                {live && <JoinRequests session={session} />}
                <ChatHead view={view} onView={setView} unfinished={unfinished} onClose={props.onClose} tx={tx} />
                {session.status === 'signed-out' && <p className="session-note chat-notice">{tx.signedOut}</p>}
                {ended && (
                    <p className="session-note chat-notice collab-ended">
                        {tx.closed}
                        {summary && (
                            <Act kind="open" aria-haspopup="dialog" onClick={() => setSummaryOpen(true)}>
                                {tx.collab.showSummary}
                            </Act>
                        )}
                    </p>
                )}
                {summary && summaryOpen && <CollabSummaryDialog summary={summary} tx={tx} onClose={() => setSummaryOpen(false)} />}
                {session.error && <p className="session-note chat-notice session-error">{tx.error(session.error)}</p>}
                {leaveError && <p className="session-note chat-notice session-error">{tx.error(leaveError)}</p>}
                {/* both stay mounted, so that switching keeps the stream's scroll and the open units of AI の作業 */}
                <div className="chat-view" role="tabpanel" hidden={view !== 'chat'} ref={chatPanel} onScrollCapture={keepStreamTop}>
                    <Stream shown={shown} />
                    <div className="chat-tray">
                        {revisions.node}
                        {actions.error && <p className="session-note chat-notice session-error">{tx.error(actions.error)}</p>}
                        {marking.error && <p className="session-note chat-notice session-error">{tx.error(marking.error)}</p>}
                        {actions.undo && <UndoBar />}
                        {control && selection.active && <SelectionBar />}
                        {control && proposalPicks.ids.size > 0 && <ProposalsBar />}
                        <InterviewPanel session={session} live={live} />
                    </div>
                    {live && (
                        <Composer
                            session={session}
                            composer={composer}
                            candidates={props.candidates}
                            focusPending={focusPending}
                            onFocused={props.onFocused}
                            reply={replyDraft}
                            replyFocus={replyFocus}
                            onReplyDone={() => setReplyDraft(undefined)}
                            outgoing={solo ? outgoingTools : undefined}
                            slash={props.slash}
                            viewedAt={props.viewedAt}
                            tx={tx}
                        />
                    )}
                </div>
                <div className="chat-view" role="tabpanel" hidden={view !== 'history'}>
                    <History units={units} reveal={peek} />
                </div>
                {revisions.dialog}
                {control && cancellingUnit && <CancelDialog unit={cancellingUnit} onClose={closeCancel} />}
                <StatusSizer root={root} />
            </div>
        </ChatProvider>
    );
}

/**
 * The session's controls of the whole page, put in the app bar (rendered here, inside the chat's context): the collab
 * menu (the avatars ▾; in Solo a plain ⋯, after the AI's state) and the AI's state at a glance.
 */
function SessionBar(props: {
    slot: HTMLElement | null;
    session: SessionData;
    status: AgentStatus;
    now: number;
    live: boolean;
    units: readonly ChangeUnit[];
    location: ViewLocation;
    viewScope: ViewScope;
    onOpenView: (target: ViewTarget) => void;
    onLeave: () => void;
    onPeek: () => void;
    tx: Tx;
}) {
    const { session, status, tx } = props;
    const solo = isSolo(session.state);
    const label =
        status.kind === 'running' ? tx.chat.status.running(elapsed(status.since, props.now)) : status.kind === 'idle' ? '' : tx.chat.status[status.kind];
    // the AI: nothing while it is connected; else which role is missing and how much waits for it
    const presence = aiPresence(session.state.agent);
    if (!props.slot) return null;
    const menu = (
        <CollabMenu
            solo={solo}
            session={session}
            location={props.location}
            scope={props.viewScope}
            units={props.units}
            live={props.live}
            onOpenView={props.onOpenView}
            onLeave={props.onLeave}
        />
    );
    // `session-chat`: the chat's own look for its buttons and the menu's popover, here outside the chat's pillar
    return createPortal(
        <div className="session-chat session-bar">
            {!solo && menu}
            {/* idle says nothing: only running, a question or a queued run shows; a click opens it in AI の作業 */}
            <span className="chat-status-slot" aria-live="polite">
                {presence.kind === 'missing' && (
                    <span className="chat-status status-ai-missing">
                        <span className="chat-status-mark" aria-hidden>
                            ○
                        </span>
                        {tx.chat.ai.presence(presence.role, presence.waiting)}
                    </span>
                )}
                {status.kind !== 'idle' && (
                    <button
                        className={`chat-status status-${status.kind}`}
                        data-tooltip={tx.chat.peek}
                        aria-label={`${label} — ${tx.chat.peek}`}
                        onClick={props.onPeek}
                    >
                        <span className="chat-status-mark" aria-hidden>
                            {status.kind === 'running' ? '●' : status.kind === 'clarification' ? '?' : '…'}
                        </span>
                        {label}
                    </button>
                )}
            </span>
            {solo && menu}
        </div>,
        props.slot,
    );
}

/** Whether a scrolled element is at its bottom (within a few pixels). */
const atBottomOf = (el: HTMLElement): boolean => el.scrollHeight - el.scrollTop - el.clientHeight < 24;
/** Whether `item` is wholly in the visible part of `list`. */
const inViewOf = (list: HTMLElement, item: HTMLElement): boolean => {
    const a = list.getBoundingClientRect();
    const b = item.getBoundingClientRect();
    return b.top >= a.top - 1 && b.bottom <= a.bottom + 1;
};
/** Whether the top of `item` is in the visible part of `list` (a long one is read from there). */
const headInViewOf = (list: HTMLElement, item: HTMLElement): boolean => {
    const a = list.getBoundingClientRect();
    const top = item.getBoundingClientRect().top;
    return top >= a.top - 1 && top < a.bottom - HEAD_MARGIN;
};
/** An answer of the AI or its proposal: what the stream reveals from its head as it arrives. */
const isAiArrival = (row: Row): boolean => (row.kind === 'message' || row.kind === 'proposal') && row.author === AI_PARTICIPANT;

function Stream({ shown }: { shown: Shown }) {
    const { items } = shown;
    const { tx, jump, session } = useChat();
    const ref = useRef<HTMLDivElement | null>(null);
    // follows the newest item only while the reader is at the bottom (true until they scroll up)
    const atBottom = useRef(true);
    // the AI's answer that arrived while the reader was at the bottom: the scroll that puts its head at the top, which
    // following the bottom goes no further than (the answer is read from its head; none: the bottom)
    const head = useRef<number | undefined>(undefined);
    // the keys of the items there when the reader left the bottom, while they are away from it: 最新へ shows meanwhile,
    // with how many arrived since
    const [away, setAway] = useState<ReadonlySet<string> | undefined>();
    // on the way back to the bottom (最新へ): the smooth scroll does not count as leaving it, unless the reader scrolls
    const returning = useRef(false);
    const follow = (el: HTMLElement): void => {
        const bottom = atBottomOf(el);
        if (bottom) returning.current = false;
        // the reader went on past the answer's head to the bottom: following goes to the bottom again
        if (bottom && head.current !== undefined && el.scrollTop > head.current + 1) head.current = undefined;
        if (returning.current) return;
        atBottom.current = bottom;
        setAway((known) => (bottom ? undefined : (known ?? new Set(items.map((i) => i.key)))));
    };
    // where the stream last put its scroll as it follows the bottom: while it follows, only a scroll up from there leaves
    // the bottom; one that finds it there or further down is the stream's own or the content moving under it (a row
    // growing faster than the bottom's few pixels a frame, the browser's scroll anchoring as texts above are clamped)
    const placed = useRef<number | undefined>(undefined);
    const toBottom = (): void => {
        const el = ref.current;
        if (!el) return;
        if (atBottom.current) {
            const max = el.scrollHeight - el.clientHeight;
            const top = followTop(el.scrollTop, max, head.current);
            el.scrollTop = top;
            placed.current = el.scrollTop;
            // stopped at the head of the AI's answer, the rest below: read from there, the stream no longer follows
            if (top < max - 1) {
                atBottom.current = false;
                setAway((known) => known ?? new Set(items.map((i) => i.key)));
            }
        }
        // the bottom came into view without a scroll (the pane grew)
        else follow(el);
    };
    const toLatest = (): void => {
        const el = ref.current;
        if (!el) return;
        atBottom.current = true;
        returning.current = true;
        head.current = undefined;
        placed.current = undefined;
        setAway(undefined);
        el.scrollTo({ top: el.scrollHeight, behavior: motionMs('--motion-enter') === 0 ? 'auto' : 'smooth' });
    };
    const me = session.me.participant.id;
    const arrived = away && arrivedBelow(items, away, me, (r) => mentionsMe(r, session.state, me) || repliesToMe(r, session.state.requests, session.state, me));
    const latestLabel = tx.chat.latest(arrived?.count ?? 0, arrived?.forMe ?? 0);
    // the AI's cards too (Solo): one appearing, or turning into its answer or run card, is a change of the stream
    const signature = shown.entries
        .map((e) =>
            e.kind === 'item' ? `${e.item.key}@${changedAt(e.item)}` : `ai:${e.request}=${e.content.kind === 'item' ? e.content.item.key : e.content.kind}`,
        )
        .join('|');
    // the pane shown again, resized, or a bubble grown: still at the bottom
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(toBottom);
        observer.observe(el);
        for (const child of el.children) observer.observe(child);
        return () => observer.disconnect();
    }, [signature]);

    // a card that moved on while out of sight: a pill at the bottom goes to it
    const cards = items.flatMap((i) => (i.kind === 'card' ? [{ key: i.key, updatedAt: i.updatedAt, name: unitName(i.unit).text }] : []));
    const seen = useRef(new Map<string, string>());
    // (`head`: an answer of the AI that arrived while the reader was scrolled up, shown from its head)
    const [pill, setPill] = useState<{ key: string; text: string; head: boolean } | undefined>();
    useEffect(() => {
        const el = ref.current;
        const changed = updatedCards(cards, seen.current);
        for (const c of cards) seen.current.set(c.key, c.updatedAt);
        if (!el) return;
        const hidden = changed.filter((key) => {
            const item = el.querySelector<HTMLElement>(`[data-item="${CSS.escape(key)}"]`);
            return item && !inViewOf(el, item);
        });
        const last = hidden.at(-1);
        if (last) setPill({ key: last, text: tx.chat.cardUpdated(cards.find((c) => c.key === last)?.name ?? ''), head: false });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signature]);
    const onScroll = (el: HTMLElement): void => {
        if (!atBottom.current || placed.current === undefined || el.scrollTop < placed.current - 1) {
            placed.current = undefined;
            follow(el);
        }
        if (!pill) return;
        const item = el.querySelector<HTMLElement>(`[data-item="${CSS.escape(pill.key)}"]`);
        if (item && (pill.head ? headInViewOf(el, item) : inViewOf(el, item))) setPill(undefined);
    };
    // the answer's pill: the stream goes to its head, where following would have stopped
    const toHead = (key: string): void => {
        const el = ref.current;
        const item = el?.querySelector<HTMLElement>(`[data-item="${CSS.escape(key)}"]`);
        if (!el || !item) return;
        const top = el.scrollTop + item.getBoundingClientRect().top - el.getBoundingClientRect().top - HEAD_MARGIN;
        el.scrollTo({ top, behavior: motionMs('--motion-enter') === 0 ? 'auto' : 'smooth' });
    };

    const rows = streamRows(shown, tx);
    // what arrived since the last change (a row that is new, or shows something else now: the AI's card its answer)
    const seenRows = useRef<ReadonlyMap<string, string> | undefined>(undefined);
    useLayoutEffect(() => {
        const el = ref.current;
        const before = seenRows.current;
        seenRows.current = new Map(rows.map((r) => [r.id, r.key]));
        const came = before ? rows.filter((r) => before.get(r.id) !== r.key) : [];
        const answer = came.find(isAiArrival);
        const item = answer && el?.querySelector<HTMLElement>(`[data-item="${CSS.escape(answer.key)}"]`);
        if (el && answer && item) {
            switch (arrival(atBottom.current, headInViewOf(el, item))) {
                case 'follow':
                    head.current = el.scrollTop + item.getBoundingClientRect().top - el.getBoundingClientRect().top - HEAD_MARGIN;
                    break;
                case 'pill':
                    setPill({ key: answer.key, text: tx.chat.ai.answerArrived, head: true });
                    break;
                case 'none':
                    break;
            }
        } else if (came.length > 0) head.current = undefined;
        toBottom();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signature]);
    // a row continues the one before of the same author on the same line of replies only (a reply hanging under a
    // message shows its avatar, the line joining the two; so does the row after the replies)
    const follows = continued(rows.map((r) => r.author)).map((c, i) => c && rows[i - 1]?.look.hangsOn === rows[i]?.look.hangsOn);
    // the items there when the stream is first shown with something in it (the page loaded, the tab switched back):
    // only those posted after come in with motion
    const [initial] = useState(() => new Set<string>());
    if (initial.size === 0) for (const row of rows) initial.add(row.id);
    return (
        <div className="chat-stream-wrap">
            <div
                className="chat-stream"
                ref={ref}
                onScroll={(e) => onScroll(e.currentTarget)}
                onWheel={() => {
                    returning.current = false;
                }}
                onTouchStart={() => {
                    returning.current = false;
                }}
            >
                <ol className="chat-items">
                    {rows.map((row, i) => (
                        <StreamLine key={row.id} row={row} continues={follows[i] ?? false} initial={initial} />
                    ))}
                </ol>
            </div>
            {/* the pill goes to what it names; its ✕ only puts it away (until something else moves on out of sight) */}
            {pill && (
                <div className="chat-updated-pill">
                    <button
                        className="chat-updated-pill-go"
                        onClick={() => {
                            if (pill.head) toHead(pill.key);
                            else jump(pill.key);
                            setPill(undefined);
                        }}
                    >
                        <span className="chat-updated-pill-text">{pill.text}</span>
                    </button>
                    <button
                        className="icon-button chat-updated-pill-close"
                        onClick={(e) => {
                            e.stopPropagation();
                            setPill(undefined);
                        }}
                        aria-label={tx.chat.dismissPill}
                        data-tooltip={tx.chat.dismissPill}
                    >
                        <X size={12} aria-hidden />
                    </button>
                </div>
            )}
            {/* away from the bottom: back to the newest, with how many arrived below (`@ n` when some are for me, as 💬) */}
            {arrived && (
                <button className="chat-latest motion-pop motion-pop-up" onClick={toLatest} aria-label={latestLabel} data-tooltip={latestLabel}>
                    <ArrowDown size={16} aria-hidden />
                    {arrived.forMe > 0 ? (
                        <span className="chat-launcher-count mentions" aria-hidden>
                            <span className="chat-launcher-at">@</span>
                            {arrived.forMe}
                        </span>
                    ) : (
                        arrived.count > 0 && (
                            <span className="chat-launcher-count" aria-hidden>
                                {arrived.count}
                            </span>
                        )
                    )}
                </button>
            )}
        </div>
    );
}

/**
 * A row of the stream in its line. One posted after the stream was shown comes in with motion: an answer of the AI
 * grows from nothing as its content fades in (`useGrow`), the others come up a little as they fade in (`motion-pop`).
 */
function StreamLine({ row, continues, initial }: { row: Row; continues: boolean; initial: Set<string> }) {
    const live = !initial.has(row.id);
    const { look } = row;
    const thread = `${look.head ? ' chat-thread-head' : ''}${look.hangsOn !== undefined ? ' chat-thread-reply' : ''}${look.more ? ' chat-thread-more' : ''}`;
    // the AI's card turning into its answer grows in its own row (`AiSlotRow`); this is an answer in a row of its own
    const grows = live && isAiArrival(row) && !row.id.startsWith('ai:');
    const ref = useGrow<HTMLLIElement>(row.id, grows);
    return (
        <li
            ref={ref}
            className={`chat-item chat-item-${row.kind}${continues ? ' continued' : ''}${thread}${live && !grows ? ' motion-pop motion-pop-up' : ''}`}
            data-item={row.key}
            onAnimationEnd={(e) => {
                // once in, it is an item like the others: shown again (the tab switched back), it does not come in again
                if (e.target !== e.currentTarget || initial.has(row.id)) return;
                initial.add(row.id);
                e.currentTarget.classList.remove('motion-pop', 'motion-pop-up');
            }}
        >
            {/* the line it hangs on says it without words: what it replies to, for those who do not see it */}
            {look.hangsOn !== undefined && row.to && <RepliesTo to={row.to} />}
            {row.render(continues)}
        </li>
    );
}

/**
 * A line of the stream: a divider, a card, a message of an author that may continue the one before, or the AI's card
 * under a message (Solo). `key` names what it shows (`message:<id>`, `card:<key>`: what `jump` and the pills look for);
 * `id` is its row's, kept while what it shows changes (the AI's card turning into its answer, a message sent from this
 * page becoming the server's). `look`: how it stands among the replies (`threads.ts`), `to` what it replies to.
 */
interface Row {
    readonly id: string;
    readonly key: string;
    readonly kind: string;
    readonly author: string | undefined;
    readonly look: ReplyLook;
    readonly to: ReplyTo | undefined;
    readonly render: (continues: boolean) => ReactNode;
}

/** What a row replies to: a message, or a run (on its card). */
type ReplyTo = { readonly kind: 'Message'; readonly request: string } | { readonly kind: 'Run'; readonly run: string };

function streamRows(shown: Shown, tx: Tx): Row[] {
    const slotted = new Set(shown.entries.flatMap((e) => (e.kind === 'slot' ? [e.request] : [])));
    // the row of a message sent from this page keeps the key it had while on its way
    const rowId = (item: StreamItem): string => {
        const local = item.kind === 'message' ? shown.sent.get(item.request.id) : undefined;
        return local === undefined ? item.key : `message:${local}`;
    };
    const looks = replyLooks(threadLines(shown.entries));
    const itemRow = (item: StreamItem, look: ReplyLook): Omit<Row, 'id' | 'look' | 'to'> => {
        switch (item.kind) {
            case 'session-start':
                return { key: item.key, kind: item.kind, author: undefined, render: () => <Divider at={item.at}>{tx.chat.started}</Divider> };
            case 'restored':
                return {
                    key: item.key,
                    kind: item.kind,
                    author: undefined,
                    render: () => (
                        <Divider at={item.at} hint={tx.chat.restoredHint(item.from, item.revision)}>
                            {tx.chat.restored(item.work)}
                        </Divider>
                    ),
                };
            case 'message': {
                // hanging right under what it replies to: no line quoting it
                const hangs = look.hangsOn !== undefined;
                const id = item.request.id;
                return {
                    key: item.key,
                    kind: item.kind,
                    author: item.request.author,
                    render: (continues) =>
                        isAiAuthor(item.request.author) ? (
                            <AiMessageRow request={item.request} continues={continues} hangs={hangs} />
                        ) : (
                            <MessageRow request={item.request} continues={continues} hangs={hangs} slotted={slotted.has(id)} waiting={shown.waiting.has(id)} />
                        ),
                };
            }
            case 'proposal':
                return {
                    key: item.key,
                    kind: item.kind,
                    // the AI's, continuing its answer right above as its messages do
                    author: AI_PARTICIPANT,
                    render: (continues) => <ProposalCard proposal={item.proposal} continues={continues} />,
                };
            case 'command':
                return {
                    key: item.key,
                    kind: item.kind,
                    // the AI's, under the message that started it
                    author: AI_PARTICIPANT,
                    render: (continues) =>
                        isGuide(item.command) && item.command.state !== 'Listed' ? (
                            <GuideCard command={item.command} continues={continues} />
                        ) : (
                            <CandidatesCard command={item.command} continues={continues} />
                        ),
                };
            case 'card':
                return { key: item.key, kind: item.kind, author: undefined, render: () => <RunCard unit={item.unit} /> };
            case 'record':
                return {
                    key: item.key,
                    kind: item.kind,
                    author: undefined,
                    render: () => <RecordRow record={item.record} hangs={look.hangsOn !== undefined} />,
                };
        }
    };
    const toOf = (item: StreamItem): ReplyTo | undefined =>
        item.kind === 'message'
            ? item.request.replyTo
            : item.kind === 'record' && item.record.replyTo !== undefined
              ? { kind: 'Message', request: item.record.replyTo }
              : undefined;
    return shown.entries.map((entry, i): Row => {
        const look = looks[i] ?? { hangsOn: undefined, head: false, more: false, quote: false };
        if (entry.kind === 'item') return { id: rowId(entry.item), look, to: toOf(entry.item), ...itemRow(entry.item, look) };
        const local = shown.sent.get(entry.request);
        const id = `ai:${local ?? entry.request}`;
        const to: ReplyTo = { kind: 'Message', request: entry.request };
        const content = entry.content;
        if (content.kind !== 'item')
            return {
                id,
                key: id,
                kind: 'ai-slot',
                author: AI_PARTICIPANT,
                look,
                to,
                render: () => <AiSlotRow request={entry.request} phase={content.kind} />,
            };
        // the answer or the run card, right under its message
        const row = itemRow(content.item, look);
        return { ...row, id, look, to, render: (continues) => <AiSlotRow request={entry.request} phase="item" item={row.render(continues)} /> };
    });
}

/**
 * The AI's card under a message in Solo: 確認中 with the AI's quiet "…" while the message is triaged (or answered), what
 * the header says when no AI is connected to do it, that it could not answer (and the facilitator's もう一度); then its
 * answer or its run card in its place, cross-faded (`--motion-swap`): the card fades out, the answer or the run card
 * fades in where it was, the row growing from the card's height to its own (`useGrow`) rather than jumping to it.
 */
function AiSlotRow({ request, phase, item }: { request: string; phase: 'pending' | 'given-up' | 'item'; item?: ReactNode }) {
    const swap = useSwap(phase);
    const ref = useGrow<HTMLDivElement>(swap.shown);
    return (
        <div ref={ref} className={`chat-ai-slot${swap.swapping ? ' swapping' : ''}`}>
            {swap.shown === 'item' && item !== undefined ? item : <AiPendingCard request={request} givenUp={swap.shown === 'given-up'} />}
        </div>
    );
}

function AiPendingCard({ request, givenUp }: { request: string; givenUp: boolean }) {
    const { session, tx, control, actions } = useChat();
    const presence = aiPresence(session.state.agent);
    // the triage and the answer are the answerer's: without one, the card says so instead of 確認中
    const missing = presence.kind === 'missing' && presence.role !== 'run' ? presence.role : undefined;
    return (
        <div className="chat-row">
            <div className="chat-message chat-ai-pending">
                <AiAvatar />
                <div className="chat-message-main">
                    <div className="chat-message-head">
                        <span className="chat-who">{tx.chat.agent}</span>
                        {!givenUp &&
                            (missing ? (
                                <span className="chat-ai-pending-state">{tx.chat.ai.presence(missing, 0)}</span>
                            ) : (
                                <span className="chat-ai-pending-state" role="status">
                                    {tx.chat.ai.pending}
                                    <span className="chat-ai-dots" aria-hidden>
                                        …
                                    </span>
                                </span>
                            ))}
                    </div>
                    {givenUp && (
                        <p className="chat-ai-given-up">
                            {tx.chat.ai.givenUp}
                            {control && (
                                <Act kind="send" disabled={actions.busy} onClick={() => void actions.retryAnswer(request)}>
                                    {tx.chat.ai.retry}
                                </Act>
                            )}
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * A message of the stream: who sent it (「あなた」 for my own, ファシリ by the facilitator's name), its targets and text; at
 * the right end of its name line, in the status slot, where it stands with the AI once it was addressed: a quiet "…"
 * while the AI reads it, then a link to what came of it — the AI's answer, the proposal, or the AI turn of its latest
 * run (the state is the turn's, so only its tooltip says it) —, nothing when it needed nothing, or that the AI could
 * not answer. Its actions float over its top right: for the facilitator, 「AI に送る」 on a message not addressed (or
 * judged to need nothing) and its … (several together; the triage's record); ↩ and ☺+. In Solo, a message with the AI's
 * card under it (`slotted`) leaves all that to the card; one still on its way to the server (`waiting`) has no actions.
 */
function MessageRow({
    request: r,
    continues,
    hangs,
    slotted,
    waiting,
}: {
    request: RequestJson;
    continues: boolean;
    hangs: boolean;
    slotted: boolean;
    waiting: boolean;
}) {
    const { session, tx, nameOf, avatarOf, onNavigate, control, solo, marks, selection, actions, showPerson, triages, givenUp } = useChat();
    const author = nameOf(r.author);
    const avatarUrl = avatarOf(r.author);
    // it mentions me, or replies to my message: a faint background in my stream only (it asks for my attention)
    const toMe = mentionsMe(r, session.state, session.me.participant.id) || repliesToMe(r, session.state.requests, session.state, session.me.participant.id);
    const mine = r.author === session.me.participant.id;
    const facilitator = isFacilitator(session.state, r.author);
    const statuses = session.targets?.statuses[r.id];
    const mark = marks.get(r.id);
    const triage = triages.get(r.id);
    const ai = messageAi(triage, givenUp);
    const selected = selection.ids.has(r.id);
    const command = commandOfOpening(session.state, r.id);
    const [record, setRecord] = useState(false);
    // 「AI に送る」: a message not addressed yet, or one judged to need nothing (sent again as 相談); never in Solo,
    // where every message is addressed as it is sent
    const addressable = control && !solo && (ai.kind === 'none' || ai.kind === 'neither');
    const choose = (e: React.MouseEvent): void => {
        if (!control || solo) return;
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
            e.preventDefault();
            if (selection.active) selection.toggle(r.id);
            else selection.start(r.id);
        } else if (selection.active && !(e.target instanceof Element && e.target.closest('a, button, input'))) selection.toggle(r.id);
    };
    // at the right of the name line, the status slot: where it stands with the AI
    const status = slotted ? null : mark ? <TurnLink mark={mark} /> : <AiStatus ai={ai} />;
    const side = status && (
        <div className="chat-message-side">
            <StatusSlot>{status}</StatusSlot>
        </div>
    );
    const menu = control && (addressable || (triage !== undefined && isRecord(triage)));
    // the actions, floating over the row's top right: none while messages are being chosen
    const tools = !selection.active && !waiting && (
        <RowActions>
            {menu && (
                <span className="chat-apply">
                    {addressable && (
                        <button
                            className="icon-button chat-apply-button"
                            disabled={actions.busy}
                            onClick={() => void actions.address([r.id])}
                            aria-label={tx.chat.apply}
                            data-tooltip={tx.chat.apply}
                        >
                            <Bot size={14} aria-hidden />
                        </button>
                    )}
                    <MessageMenu id={r.id} addressable={addressable} hasRecord={triage !== undefined && isRecord(triage)} onRecord={() => setRecord(!record)} />
                </span>
            )}
            {/* ↩ just before ☺+, as on an AI turn */}
            <ReplyButton to={{ kind: 'Message', request: r.id }} />
            {/* last: ☺+ at the right end of every row, messages and turns alike; alone in Solo, no one else reacts */}
            {!solo && <AddReaction target={{ kind: 'Message', request: r.id }} />}
        </RowActions>
    );
    return (
        <div
            className={`chat-row${selected ? ' selected' : ''}${toMe ? ' mentions-me' : ''}`}
            onClickCapture={choose}
            // Shift / ⌘ chooses the message: no text selection
            onMouseDown={(e) => control && !solo && (e.shiftKey || e.metaKey || e.ctrlKey) && e.preventDefault()}
        >
            {control && selection.active && (
                <input type="checkbox" className="chat-select" checked={selected} onChange={() => selection.toggle(r.id)} aria-label={tx.chat.select} />
            )}
            {toMe && <span className="visually-hidden">{tx.chat.mentionsYou}</span>}
            <Bubble
                avatar={<Avatar id={r.author} name={author} {...(avatarUrl && { url: avatarUrl })} facilitator={facilitator && !solo} />}
                who={speakerName(r.author, session.me.participant.id, nameOf, tx.chat.you)}
                badge={facilitator && !solo && <span className="chat-role">{tx.chat.facilitatorShort}</span>}
                at={r.sentAt}
                continues={continues}
                className={`chat-bubble-request${mine ? ' mine' : ''}`}
                side={side}
            >
                {/* what it replies to, unless it hangs right under it */}
                {!hangs && r.replyTo?.kind === 'Run' && <ReplyReferenceLine run={r.replyTo.run} />}
                {!hangs && r.replyTo?.kind === 'Message' && <MessageReferenceLine request={r.replyTo.request} />}
                <TargetChips targets={r.targets} statuses={statuses} onNavigate={onNavigate} tx={tx} />
                {/* a `/` command's opening message: the command's chip in place of its name as text */}
                {command ? (
                    <CommandChip
                        id={command}
                        name={tx.chat.slash.commands[command]}
                        description={tx.chat.slash.types[commandType(command)]}
                        label={tx.chat.slash.chip(command, tx.chat.slash.commands[command])}
                    />
                ) : (
                    <Clamped tx={tx} revealKey={`message:${r.id}`}>
                        <MentionedText
                            body={r.body}
                            targets={r.targets}
                            statuses={statuses}
                            onNavigate={onNavigate}
                            mentions={r.mentions}
                            nameOf={nameOf}
                            onPerson={showPerson}
                            tx={tx}
                        />
                    </Clamped>
                )}
                {ai.kind === 'given-up' && !slotted && (
                    <p className="chat-ai-given-up">
                        {tx.chat.ai.givenUp}
                        {control && (
                            <Act kind="send" disabled={actions.busy} onClick={() => void actions.retryAnswer(r.id)}>
                                {tx.chat.ai.retry}
                            </Act>
                        )}
                    </p>
                )}
                <ReactionRow target={{ kind: 'Message', request: r.id }} />
                {record && triage !== undefined && isRecord(triage) && <TriageRecordPanel triage={triage} onClose={() => setRecord(false)} />}
            </Bubble>
            {tools}
        </div>
    );
}

/**
 * Where an addressed message stands with the AI, in its status slot: the AI's mark and a quiet "…" while it reads it, a
 * link to its answer or its proposal (the AI's mark and ↓), that it could not answer; nothing when not addressed or
 * judged to need nothing. A run is the turn link's (`TurnLink`).
 */
function AiStatus({ ai }: { ai: MessageAi }) {
    const { tx, jump } = useChat();
    switch (ai.kind) {
        case 'none':
        case 'neither':
        case 'run':
        // said in the bubble, where it has room
        case 'given-up':
            return null;
        case 'working':
            return (
                <span className="chat-ai-working" role="img" aria-label={tx.chat.ai.working} data-tooltip={tx.chat.ai.working}>
                    <AiAvatar />
                    <span className="chat-ai-dots" aria-hidden>
                        …
                    </span>
                </span>
            );
        case 'answer':
        case 'proposal': {
            const hint = ai.kind === 'answer' ? tx.chat.ai.toAnswer : tx.chat.ai.toProposal;
            const key = ai.kind === 'answer' ? `message:${ai.answer}` : `proposal:${ai.proposal}`;
            return (
                <button className="chat-turn-link" onClick={() => jump(key)} aria-label={hint} data-tooltip={hint}>
                    <AiAvatar />
                    <ArrowDown aria-hidden />
                </button>
            );
        }
    }
}

/**
 * An answer of the AI (ADR 0030): a message of the AI, with its avatar and name, its text as Markdown with element links. On top,
 * the message it answers, unless it hangs right under it. Anyone replies to it (the reply is addressed to the AI) and reacts.
 */
function AiMessageRow({ request: r, continues, hangs }: { request: RequestJson; continues: boolean; hangs: boolean }) {
    const { tx, onNavigate, solo } = useChat();
    return (
        <div className="chat-row">
            <Bubble avatar={<AiAvatar />} who={tx.chat.agent} at={r.sentAt} continues={continues} className="chat-bubble-ai">
                {r.replyTo?.kind === 'Message' && !hangs && <MessageReferenceLine request={r.replyTo.request} />}
                <Clamped tx={tx} revealKey={`message:${r.id}`} blocks>
                    <MarkdownText text={r.body} onNavigate={onNavigate} />
                </Clamped>
                <InterviewChoices request={r.id} />
                <JourneyNoteActions request={r} />
                <ReactionRow target={{ kind: 'Message', request: r.id }} />
            </Bubble>
            <RowActions>
                <ReplyButton to={{ kind: 'Message', request: r.id }} />
                {!solo && <AddReaction target={{ kind: 'Message', request: r.id }} />}
            </RowActions>
        </div>
    );
}

/**
 * What a reply hanging right under it replies to, for a screen reader (the line it hangs on says it to the eye):
 * 「返信: <its author>」, or the name of the run's card.
 */
function RepliesTo({ to }: { to: ReplyTo }) {
    const { session, tx, nameOf, replies } = useChat();
    let who: string | undefined;
    if (to.kind === 'Message') {
        const ref = replies.messageReferenceOf(to.request);
        who = ref && speakerName(ref.author, session.me.participant.id, nameOf, tx.chat.you);
    } else {
        const ref = replies.referenceOf(to.run);
        who = ref && tx.chat.replies.reference(ref.name);
    }
    return who === undefined ? null : <span className="visually-hidden">{tx.chat.replies.repliesTo(who)}</span>;
}

/**
 * The run a reply replies to, on one muted line at the top of the message: `↩ <its card's name>: the head of what it
 * said`; a click goes to its card (scrolled to and flashed, as a quote does).
 */
function ReplyReferenceLine({ run }: { run: string }) {
    const { tx, jump, replies } = useChat();
    const naming = useTargetNaming();
    const ref = replies.referenceOf(run);
    if (!ref) return null;
    const r = tx.chat.replies;
    // plain text in a button: an element the AI named reads as its name, not a link
    const head = ref.summary === undefined ? r.states[ref.state] : referencesAsText(ref.summary, naming);
    return (
        <button className="chat-reply-ref" onClick={() => jump(`card:${ref.card}`)} data-tooltip={r.referenceHint(ref.name)}>
            <span className="chat-reply-ref-run">↩ {r.reference(ref.name)}:</span> <span className="chat-reply-ref-head">{head}</span>
        </button>
    );
}

/**
 * The message a reply replies to, on one muted line at the top of the reply: `↩ <its author>: the head of its body`;
 * a click goes to the message (scrolled to and flashed). Nothing when the session does not hold it.
 */
function MessageReferenceLine({ request }: { request: string }) {
    const { session, tx, nameOf, jump, replies } = useChat();
    const naming = useTargetNaming();
    const ref = replies.messageReferenceOf(request);
    if (!ref) return null;
    const who = speakerName(ref.author, session.me.participant.id, nameOf, tx.chat.you);
    // the AI's answer names elements as references, and so does a choice picked: by their names here, as the bubble shows them
    const head = referencesAsText(ref.head, naming);
    return (
        <button className="chat-reply-ref" onClick={() => jump(`message:${ref.request}`)} data-tooltip={tx.chat.replies.messageReferenceHint(who)}>
            <span className="chat-reply-ref-run">↩ {who}:</span> <span className="chat-reply-ref-head">{head}</span>
        </button>
    );
}

/** A message's menu (the facilitator's, …): choose it among several to send to the AI together; the triage's record. */
function MessageMenu({ id, addressable, hasRecord, onRecord }: { id: string; addressable: boolean; hasRecord: boolean; onRecord: () => void }) {
    const { tx, selection } = useChat();
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    useDismiss(open, root, () => setOpen(false));
    const pick = (f: () => void) => (): void => {
        setOpen(false);
        f();
    };
    return (
        <div className="pane-menu" ref={root}>
            <button
                className="icon-button chat-apply-more"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={tx.chat.messageMenu}
                data-tooltip={tx.chat.messageMenu}
                onClick={() => setOpen(!open)}
            >
                <Ellipsis size={13} aria-hidden />
            </button>
            {open && (
                <div className="pane-menu-list" role="menu">
                    {addressable && (
                        <button role="menuitem" onClick={pick(() => selection.start(id))}>
                            {tx.chat.selectMany}
                        </button>
                    )}
                    {hasRecord && (
                        <button role="menuitem" onClick={pick(onRecord)}>
                            <Info size={12} aria-hidden /> {tx.chat.triage.open}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

/** The bar of the messages chosen to send to the AI together: each is addressed to it (its triage decides what follows). */
function SelectionBar() {
    const { tx, selection, actions } = useChat();
    const n = selection.ids.size;
    const send = async (): Promise<void> => {
        // in the stream's order
        const ids = [...document.querySelectorAll<HTMLElement>('.chat-stream [data-item^="message:"]')]
            .map((el) => el.dataset.item?.slice('message:'.length) ?? '')
            .filter((id) => selection.ids.has(id));
        if (await actions.address(ids)) selection.clear();
    };
    return (
        <div className="chat-selection-bar" role="toolbar" aria-label={tx.chat.selected(n)}>
            <span className="chat-selection-count">{tx.chat.selected(n)}</span>
            <Act kind="send" icon={<Bot size={12} aria-hidden />} disabled={n === 0 || actions.busy} onClick={() => void send()}>
                {tx.chat.applySelected}
            </Act>
            <button className="icon-button" onClick={() => selection.clear()} aria-label={tx.chat.clearSelection} data-tooltip={tx.chat.clearSelection}>
                <X size={14} aria-hidden />
            </button>
        </div>
    );
}

/** The bar of the change proposals chosen to approve together: one run. */
function ProposalsBar() {
    const { tx, proposalPicks, actions, session } = useChat();
    const n = proposalPicks.ids.size;
    const t = tx.chat.proposal;
    const approve = async (): Promise<void> => {
        // in the stream's order
        const ids = [...document.querySelectorAll<HTMLElement>('.chat-stream [data-item^="proposal:"]')]
            .map((el) => el.dataset.item?.slice('proposal:'.length) ?? '')
            .filter((id) => proposalPicks.ids.has(id));
        // each with the option picked on its card (the recommended one when the proposal has options and none was picked)
        const proposals = ids.map((proposal) => {
            const p = session.state.proposals?.find((x) => x.id === proposal);
            const option = p && chosenIndex(p, proposalPicks.options.get(proposal));
            return { proposal, ...(option !== undefined && { option }) };
        });
        if (await actions.approveProposals(proposals)) proposalPicks.clear();
    };
    return (
        <div className="chat-selection-bar" role="toolbar" aria-label={t.selected(n)}>
            <span className="chat-selection-count">{t.selected(n)}</span>
            <Act kind="decide" icon={<Check size={12} aria-hidden />} disabled={n === 0 || actions.busy} onClick={() => void approve()}>
                {t.approveSelected(n)}
            </Act>
            <button className="icon-button" onClick={() => proposalPicks.clear()} aria-label={tx.chat.clearSelection} data-tooltip={tx.chat.clearSelection}>
                <X size={14} aria-hidden />
            </button>
        </div>
    );
}

/** Right after sending to the AI: 実行を中止, while the run is still queued. */
function UndoBar() {
    const { tx, actions, session } = useChat();
    const run = session.state.runs.find((r) => r.id === actions.undo?.run);
    const queued = !run || run.state === 'Queued';
    return (
        <div className="chat-undo" role="status">
            <span>{tx.chat.appliedAs}</span>
            {queued && (
                <Act kind="stop" onClick={() => actions.undoNow()}>
                    {tx.chat.undo}
                </Act>
            )}
            <button className="icon-button" onClick={() => actions.dismissUndo()} aria-label={tx.restoreFlow.close}>
                <X size={13} aria-hidden />
            </button>
        </div>
    );
}

const OUTCOME_ICONS: Record<UnitOutcome, LucideIcon> = {
    edited: PencilLine,
    changed: CircleCheck,
    unchanged: CircleMinus,
    clarification: CircleHelp,
    declined: Ban,
    failed: CircleX,
    cancelled: CircleSlash,
    running: LoaderCircle,
    queued: Clock,
};

/**
 * AI の作業: everything sent to the AI, from start to end, in groups — 答え待ち (the AI asked), 実行中, 待ち (in the
 * order they will run, numbered) and 終わったもの (newest first). すべて filters only the finished ones: by default those
 * that changed files. A unit is one block between lines: its head names the chunk (its title, else its first message)
 * with whose requests they were, how many runs and its time (the running one's elapsed time), then the files it changed
 * (a link to compare them); the facilitator cancels a running or queued unit with ✕ (a dialog asks first). A click on the block opens it:
 * under the same left edge, the unit's card (compact, with the AI's question to answer or vote on, as in the chat) and
 * a link to it in the chat. The card's own menu is the place of the facilitator's other actions on a unit.
 */
function History({ units: all, reveal }: { units: readonly ChangeUnit[]; reveal: Peek | undefined }) {
    const { tx } = useChat();
    const h = tx.chat.history;
    const [everything, setEverything] = useState(false);
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
    const ref = useRef<HTMLDivElement | null>(null);
    // the unit the header status stands for: opened (the others stay as they are), scrolled to and marked for a moment
    useEffect(() => {
        if (!reveal) return;
        setOpen((o) => (o.has(reveal.key) ? o : new Set([...o, reveal.key])));
        requestAnimationFrame(() => {
            const el = ref.current?.querySelector<HTMLElement>(`[data-unit="${CSS.escape(reveal.key)}"]`);
            if (!el) return;
            el.scrollIntoView({ block: 'start', behavior: 'smooth' });
            el.classList.add('chat-flash');
            setTimeout(() => el.classList.remove('chat-flash'), 1600);
        });
    }, [reveal]);
    const groups = workGroups(all);
    const finished = shownUnits(groups.finished, everything);
    const toggle = (key: string): void => {
        const next = new Set(open);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        setOpen(next);
    };
    const rows = (units: readonly ChangeUnit[], mark?: (i: number) => ReactNode): ReactNode => (
        <ol className="chat-units">
            {units.map((unit, i) => (
                <HistoryUnit key={unit.key} unit={unit} mark={mark?.(i)} open={open.has(unit.key)} onToggle={() => toggle(unit.key)} />
            ))}
        </ol>
    );
    return (
        <div className="chat-history" ref={ref}>
            {groups.awaiting.length > 0 && (
                <section className="chat-work-group awaiting">
                    <h3 className="chat-work-label">{h.groups.awaiting}</h3>
                    {rows(groups.awaiting)}
                </section>
            )}
            {groups.running.length > 0 && (
                <section className="chat-work-group running">
                    <h3 className="chat-work-label">{h.groups.running}</h3>
                    {rows(groups.running, () => (
                        <span className="chat-pulse chat-unit-pulse" aria-label={h.outcomes.running} role="img" />
                    ))}
                </section>
            )}
            {groups.queued.length > 0 && (
                <section className="chat-work-group queued">
                    <h3 className="chat-work-label">{h.groups.queued(groups.queued.length)}</h3>
                    {rows(groups.queued, (i) => (
                        <span className="chat-unit-order" role="img" aria-label={h.order(i + 1)}>
                            {i + 1}
                        </span>
                    ))}
                </section>
            )}
            {/* the filter is of the finished ones only: what is still going on always shows */}
            {groups.finished.length > 0 && (
                <section className="chat-work-group finished">
                    <div className="chat-work-label-row">
                        <h3 className="chat-work-label">{h.groups.finished}</h3>
                        <label className="check small" data-tooltip={h.allHint}>
                            <input type="checkbox" checked={everything} onChange={(e) => setEverything(e.target.checked)} />
                            {h.all}
                        </label>
                    </div>
                    {rows(finished)}
                </section>
            )}
        </div>
    );
}

function HistoryUnit({ unit, mark, open, onToggle }: { unit: ChangeUnit; mark: ReactNode; open: boolean; onToggle: () => void }) {
    const { tx, nameOf, control, now, jump } = useChat();
    const h = tx.chat.history;
    const Icon = OUTCOME_ICONS[unit.outcome];
    const name = unitName(unit);
    const asked = requestersOf(unit.requesters.map(nameOf));
    const who =
        asked.kind === 'names' ? h.requesters(asked.names.join(h.separator)) : asked.kind === 'more' ? h.requestersMore(asked.first, asked.others) : undefined;
    const span = unit.span;
    const paths = unit.paths ?? [];
    const about = useUnitAbout(unit);
    const last = unit.runs[unit.runs.length - 1].run;
    // the changes line stands for the files (and how many); one run is the rule, said only when there were more
    const listed = paths.length > 0 && span !== undefined;
    const facts = [
        who,
        unit.runs.length > 1 ? h.runs(unit.runs.length) : undefined,
        !listed && unit.files !== undefined && unit.files > 0 ? h.files(unit.files) : undefined,
    ].filter((x) => x !== undefined);
    // the facilitator's ✕ on what has not finished (asking first); at the right end, before ›
    const cancellable = control && (last.state === 'Queued' || last.state === 'Running');
    // the card is mounted the first time the unit opens, and stays so that it folds away as it closes
    const [mounted, setMounted] = useState(open);
    if (open && !mounted) setMounted(true);
    return (
        <li
            className={`chat-unit outcome-${unit.outcome}${open ? ' open' : ''}${cancellable ? ' cancellable' : ''}${listed ? ' has-files' : ''}`}
            data-unit={unit.key}
        >
            <button className="chat-unit-head" aria-expanded={open} aria-label={open ? h.collapse : h.expand} onClick={onToggle}>
                <span className="chat-unit-mark">{mark ?? <Icon size={14} className="chat-unit-icon" aria-label={h.outcomes[unit.outcome]} />}</span>
                <span className="chat-unit-text">
                    <span
                        className={`chat-unit-title${name.kind === 'request' ? ' untitled' : ''}`}
                        {...(name.kind === 'request' && { 'data-tooltip': h.untitledHint })}
                    >
                        {name.text}
                    </span>
                    {/* small, under the title: whose requests, how many runs, and when (the running one: for how long) */}
                    <span className="chat-unit-facts">
                        {facts.map((f) => `${f} · `).join('')}
                        {last.state === 'Running' ? (
                            <span data-tooltip={h.elapsedHint}>{elapsed(last.startedAt, now)}</span>
                        ) : (
                            <>
                                <time dateTime={unit.start}>{time(unit.start)}</time>
                                {time(unit.at) !== time(unit.start) && (
                                    <>
                                        –<time dateTime={unit.at}>{time(unit.at)}</time>
                                    </>
                                )}
                            </>
                        )}
                    </span>
                    {last.state === 'Running' && <ActivityLine run={last.id} />}
                </span>
                {cancellable && <span className="chat-unit-cancel-space" aria-hidden />}
                <ChevronRight size={14} className="chat-unit-twisty" aria-hidden />
            </button>
            {cancellable && (
                <span className="chat-unit-cancel">
                    <CancelButton unit={unit} />
                </span>
            )}
            {/* what the whole chunk changed: its elements as chips, then 変更を見る. The line is part of the row: a click on
                it, but on a chip or the button, opens or closes the unit as the head does (a pointer's convenience; the
                head stays the one toggle for the keyboard) */}
            {listed && span && (
                <div
                    className="chat-unit-files"
                    onClick={(e) => {
                        if (!(e.target instanceof Element && e.target.closest('button'))) onToggle();
                    }}
                >
                    <ChangedElements kind="unit" base={span.base} result={span.result} about={about} />
                </div>
            )}
            {/* the body unfolds like the tree's branches (a grid row from 0fr to 1fr) */}
            <div className="chat-unit-fold" inert={!open}>
                <div className="chat-unit-fold-inner">
                    {mounted && (
                        <div className="chat-unit-body">
                            <RunCard
                                unit={unit}
                                compact
                                actions={
                                    <Act kind="see" icon={<MessagesSquare size={12} aria-hidden />} onClick={() => jump(`card:${unit.key}`)}>
                                        {h.showInChat}
                                    </Act>
                                }
                            />
                        </div>
                    )}
                </div>
            </div>
        </li>
    );
}

/**
 * The floating button opening the conversation while it is closed, with the agent's state as a mark (a spinner while
 * it runs, `?` while it waits for an answer) and how many messages and cards changed since the chat was last shown —
 * or, when some of those messages mention me, how many do (`@ 2`): the only sign that someone called me.
 */
export function ChatLauncher(props: { status: AgentStatus; unread: number; mentions: number; onOpen: () => void }) {
    const t = useT();
    const tx = t.session;
    const { status, unread, mentions } = props;
    const label = tx.chat.launcher(unread, mentions);
    return (
        <button className={`chat-launcher status-${status.kind}`} onClick={props.onOpen} aria-label={label} data-tooltip={label}>
            <MessagesSquare size={20} aria-hidden />
            {status.kind === 'running' && <LoaderCircle size={14} className="chat-launcher-mark spin" aria-hidden />}
            {status.kind === 'clarification' && (
                <span className="chat-launcher-mark question" aria-hidden>
                    ?
                </span>
            )}
            {mentions > 0 ? (
                <span className="chat-launcher-count mentions" aria-hidden>
                    <span className="chat-launcher-at">@</span>
                    {mentions}
                </span>
            ) : (
                unread > 0 && (
                    <span className="chat-launcher-count" aria-hidden>
                        {unread}
                    </span>
                )
            )}
        </button>
    );
}

/** A line of the stream about the session (its start, a restore); `hint`: its tooltip. */
function Divider({ at, hint, children }: { at: string; hint?: string; children: ReactNode }) {
    return (
        <div className="chat-system">
            <span className="chat-system-text" {...(hint !== undefined && { 'data-tooltip': hint })}>
                {children}
            </span>
            <time className="chat-time" dateTime={at}>
                {time(at)}
            </time>
        </div>
    );
}

/** A candidate of the composer's list: an element after `#`, a person after `@`. */
type Suggestion =
    | { readonly kind: 'element'; readonly key: string; readonly element: MentionCandidate }
    | { readonly kind: 'person'; readonly key: string; readonly person: PersonCandidate };

/** A person offered after `@`: their avatar and name, the facilitator marked, those away said so. */
function PersonOption({ person, tx }: { person: PersonCandidate; tx: Tx }) {
    if (person.ai)
        return (
            <span className="chat-mention-person">
                <AiAvatar />
                <span className="chat-mention-name">{person.name}</span>
            </span>
        );
    return (
        <>
            <span className="chat-mention-person">
                <Avatar id={person.id} name={person.name} {...(person.avatarUrl && { url: person.avatarUrl })} facilitator={person.role === 'facilitator'} />
                <span className="chat-mention-name">{person.name}</span>
                {person.role === 'facilitator' && <span className="chat-role">{tx.chat.facilitatorShort}</span>}
            </span>
            {!person.online && <span className="chat-mention-away muted">{tx.whereabouts.away}</span>}
        </>
    );
}

function Composer(props: {
    session: SessionData;
    composer: ComposerDraft;
    candidates: readonly MentionCandidate[];
    focusPending: boolean;
    onFocused: () => void;
    /**
     * The run or message the message replies to, while a reply is written; `replyFocus` changes when one starts (and when
     * a command is put in the composer).
     */
    reply: ReplyDraft | undefined;
    replyFocus: number;
    onReplyDone: () => void;
    /** Solo: the message is shown at once as it is sent, the AI's card under it. */
    outgoing: OutgoingTools | undefined;
    /** What is open and selected, for what `/` lists. */
    slash: { readonly view: SlashScope['view']; readonly selected: TargetDraft | undefined };
    /** Where this page is looking: sent with each message and each command started. */
    viewedAt: SentView | undefined;
    tx: Tx;
}) {
    const { session, composer, tx, reply, onReplyDone, outgoing, viewedAt } = props;
    const personName = useChat().nameOf;
    const replyingTo =
        reply?.kind === 'Message'
            ? tx.chat.replies.replyingToMessage(speakerName(reply.author, session.me.participant.id, personName, tx.chat.you))
            : reply && tx.chat.replies.replyingTo(reply.name);
    const t = useT();
    const naming = useTargetNaming();
    const value = composer.value;
    const input = useRef<HTMLElement | null>(null);
    const editor = useRef<ComposerEditorApi | null>(null);
    const size = useComposerSize(input);
    // the `#query` or `@query` at the caret, as the editor reports it
    const [query, setQuery] = useState<EditorQuery | undefined>();
    const [active, setActive] = useState(0);
    // the `#` or `@` whose candidates were closed with Esc: they stay closed until another one
    const [dismissed, setDismissed] = useState<string | undefined>();
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [notice, setNotice] = useState<string | undefined>();
    // the chips shown whole (`+n` pressed); sending collapses them again
    const [chipsExpanded, setChipsExpanded] = useState(false);
    // `@` offers the others in the session: with no one else (or no session), it offers nothing and stays closed
    const people = useMemo(() => mentionablePeople(session.state, session.peers, session.me), [session.state, session.peers, session.me]);
    const queryKey = query && `${query.node}:${query.start}`;
    // `/` alone in the composer (then its query): the commands and the templates, instead of `#` and `@`
    const lang = useLang();
    const slashText = slashQuery(value.text);
    const slashKey = slashText === undefined ? undefined : 'slash';
    const slashOpen = slashText !== undefined && dismissed !== slashKey;
    const running = runningInterview(session.state);
    // ガイド: with an answerer to take it, one at a time
    const presence = aiPresence(session.state.agent);
    const guide = guideButton(session.state, !(presence.kind === 'missing' && presence.role !== 'run'));
    const [guiding, setGuiding] = useState(false);
    // the commands the latest guide suggests: marked in `/`'s list
    const suggested = useMemo(() => guideSuggestions(session.state), [session.state]);
    const scope = useMemo(
        (): SlashScope => ({ view: props.slash.view, selected: selectedOf(props.slash.selected, props.candidates) }),
        [props.slash.view, props.slash.selected, props.candidates],
    );
    const slashed: readonly SlashItem[] = slashOpen
        ? slashItems({
              query: slashText,
              lang,
              scope,
              commandNames: tx.chat.slash.commands,
              canStart: (id) => canStartCommand(session.state, id),
              ...(session.state.templates && { team: session.state.templates }),
          })
        : [];
    const open = !slashOpen && query !== undefined && queryKey !== dismissed && (query.sign === '#' || people.length > 0);
    const matches: readonly Suggestion[] = !open
        ? []
        : query.sign === '#'
          ? matchCandidates(props.candidates, query.query).map((c) => ({ kind: 'element', key: c.key, element: c }))
          : matchPeople(people, query.query).map((p) => ({ kind: 'person', key: p.id, person: p }));
    const canSend = !sending && value.text.trim() !== '';
    const mac = isMac(typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent);
    // a chip shows the target's own name; its whole name is in the tooltip and the labels
    const nameOf = (target: TargetDraft): string => targetText(target, tx.workspace, naming);
    const shortOf = (target: TargetDraft): string => targetShortText(target, tx.workspace, naming);
    // a mention in the text: an element by its own name (its whole name in the tooltip), a person by their name
    const look = (m: ComposerMention): MentionLook =>
        m.kind === 'element' ? { label: `#${ownTokenName(m.name, m.target)}`, title: `#${nameOf(m.target)}` } : { label: `@${m.name}`, title: `@${m.name}` };
    const kindOf = (c: MentionCandidate): string => {
        if (c.kind.language === 'dtes' && c.kind.kind === 'storming') return t.inStorming;
        const names: Readonly<Record<string, string>> = c.kind.language === 'dt' ? t.kinds : t.esKinds;
        return names[c.kind.kind] ?? c.kind.kind;
    };

    useEffect(() => setActive(0), [query?.start, query?.query, slashText]);
    // the active candidate stays in view when the keys move it (wrapping too); a hover moves it where the pointer
    // already is, so it never scrolls the list under the pointer
    const list = useRef<HTMLUListElement | null>(null);
    const hovered = useRef(false);
    useLayoutEffect(() => {
        const ul = list.current;
        if (!ul) return;
        fitAbove(ul);
        if (hovered.current) return;
        const item = ul.querySelector<HTMLElement>(`[data-index="${active}"]`);
        if (item) keepInView(ul, item);
    }, [active, open, slashOpen, matches.length, slashed.length, size.rows]);
    // the window resized (or the pane): the list still fits above the text
    useEffect(() => {
        if (!open && !slashOpen) return;
        const refit = (): void => {
            if (list.current) fitAbove(list.current);
        };
        window.addEventListener('resize', refit);
        return () => window.removeEventListener('resize', refit);
    }, [open, slashOpen]);
    // the selection added with 💬 or `C`: the text takes the focus, the caret at its end
    const { focusPending, onFocused } = props;
    useEffect(() => {
        if (!focusPending || !editor.current) return;
        editor.current.focusEnd();
        onFocused();
    }, [focusPending, onFocused]);

    // a reply just started (↩ on an AI turn or a message): the text takes the focus, the caret at its end
    const { replyFocus } = props;
    useEffect(() => {
        if (replyFocus !== 0) editor.current?.focusEnd();
    }, [replyFocus]);

    const pick = (c: Suggestion | undefined): void => {
        if (!c || !query) return;
        const mention: ComposerMention =
            c.kind === 'element'
                ? { kind: 'element', name: c.element.mention, target: c.element.target }
                : { kind: 'person', name: c.person.name, person: c.person.id };
        if (!mentionFits(value, mention))
            return setNotice(c.kind === 'element' ? tx.chat.targetsLimit(MAX_REQUEST_TARGETS) : tx.chat.mentionsLimit(MAX_REQUEST_MENTIONS));
        setNotice(undefined);
        editor.current?.pick(query, mention);
    };

    /** A `/` item picked: a template's text into the composer (to edit), or a command started (an interview, or another). */
    const pickSlash = async (item: SlashItem | undefined): Promise<void> => {
        if (!item || (item.kind === 'command' && item.disabled)) return;
        if (item.kind === 'template') {
            composer.setValue(templateValue(item.template, lang, scope.selected));
            setError(undefined);
            requestAnimationFrame(() => editor.current?.focusEnd());
            return;
        }
        setSending(true);
        try {
            const focus = scope.selected?.target.target;
            const start = { body: tx.chat.slash.commands[item.id], language: lang, focus, viewedAt };
            if (isInterviewCommandId(item.id)) await sessionApi.startInterview(interviewBody({ ...start, command: item.id }));
            else await sessionApi.startCommand(commandBody({ ...start, command: item.id }));
            await composer.clear();
            setError(undefined);
        } catch (e) {
            setError(failure(e));
        } finally {
            setSending(false);
        }
    };

    /** ガイド pressed: `/guide` started at once, the composer left as it is (nothing to type, no file changed). */
    const askGuide = async (): Promise<void> => {
        setGuiding(true);
        try {
            const focus = scope.selected?.target.target;
            await startGuide(sessionApi, { body: tx.chat.slash.commands.guide, language: lang, focus, viewedAt });
            setError(undefined);
        } catch (e) {
            setError(failure(e));
        } finally {
            setGuiding(false);
        }
    };

    const send = async (): Promise<void> => {
        const revision = latestRevision(session.state);
        if (!revision || !canSend) return;
        setSending(true);
        const body = messageBody({ value, revision: revision.id, ...(reply && { reply }), ...(viewedAt && { viewedAt }) });
        // Solo: shown at once, the text leaving the composer as it goes; put back if the server refuses it
        const local = outgoing && `local-${crypto.randomUUID()}`;
        if (outgoing && local) {
            const request = {
                id: local,
                session: session.state.session.id,
                author: session.me.participant.id,
                targets: body.targets,
                body: body.body,
                sentAt: new Date().toISOString(),
                mentions: body.mentions ?? [],
                ...(body.replyTo && { replyTo: body.replyTo }),
                state: 'Sent',
            } as RequestJson;
            outgoing.add({ local, request, known: new Set(session.state.requests.map((r) => r.id)) });
            void composer.clear();
            setChipsExpanded(false);
        }
        try {
            const sent = await sessionApi.sendRequest(body);
            if (local) outgoing?.settle(local, sent.request.id);
            else await composer.clear();
            onReplyDone();
            setChipsExpanded(false);
            setError(undefined);
            setNotice(undefined);
        } catch (e) {
            if (local) {
                outgoing?.drop(local);
                composer.setValue(value);
            }
            setError(failure(e));
        } finally {
            setSending(false);
        }
    };

    return (
        <div className="chat-composer">
            <ComposerResizer {...size} label={tx.chat.resizeInput} />
            {reply && (
                <div className="chat-reply-chip motion-pop motion-pop-up" role="status">
                    <span className="chat-reply-chip-text">↩ {replyingTo}</span>
                    <button className="chat-chip-remove" onClick={onReplyDone} aria-label={tx.chat.replies.cancel} data-tooltip={tx.chat.replies.cancel}>
                        <X size={12} aria-hidden />
                    </button>
                </div>
            )}
            <div className="chat-composer-input">
                {slashOpen && (
                    <ul className="chat-mentions chat-slash motion-pop motion-pop-up" role="listbox" aria-label={tx.chat.slash.hint} ref={list}>
                        {slashed.length === 0 && <li className="chat-mention-none muted">{tx.chat.slash.noMatch}</li>}
                        {slashed.map((c, i) => (
                            <li
                                key={`${c.kind}:${c.id}`}
                                data-index={i}
                                role="option"
                                aria-selected={i === active}
                                {...(c.kind === 'command' && c.disabled && { 'aria-disabled': true })}
                                className={`chat-mention-option chat-slash-option ${c.kind}${c.kind === 'command' && c.disabled ? ' disabled' : ''}${i === active ? ' active' : ''}`}
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    void pickSlash(c);
                                }}
                                onMouseEnter={() => {
                                    hovered.current = true;
                                    setActive(i);
                                }}
                            >
                                {c.kind === 'command' && <CommandIcon id={c.id} />}
                                {/* the guide's star in the name's cell: the option's grid keeps its columns */}
                                <span className="chat-mention-name">
                                    {c.name}
                                    {c.kind === 'command' && suggested.has(c.id) && <SuggestedMark label={tx.chat.slash.suggested} />}
                                </span>
                                {c.kind === 'command' && <span className="chat-slash-what muted">{tx.chat.slash.types[c.type]}</span>}
                                {c.kind === 'template' && c.template.team && <span className="chat-mention-kind">{tx.chat.slash.team}</span>}
                                <span className="chat-mention-where muted">/{c.id}</span>
                            </li>
                        ))}
                    </ul>
                )}
                {open && (
                    <ul className="chat-mentions motion-pop motion-pop-up" role="listbox" aria-label={tx.chat.mentionHint} ref={list}>
                        {matches.length === 0 && (
                            <li className="chat-mention-none muted">{query.sign === '#' ? tx.chat.mentionNoMatch : tx.chat.personNoMatch}</li>
                        )}
                        {matches.map((c, i) => (
                            <li
                                key={c.key}
                                data-index={i}
                                role="option"
                                aria-selected={i === active}
                                className={`chat-mention-option${c.kind === 'person' ? ' person' : ''}${i === active ? ' active' : ''}`}
                                onMouseDown={(e) => {
                                    // keeps the focus (and the caret) in the text
                                    e.preventDefault();
                                    pick(c);
                                }}
                                onMouseEnter={() => {
                                    hovered.current = true;
                                    setActive(i);
                                }}
                            >
                                {c.kind === 'element' ? (
                                    <>
                                        <span className="chat-mention-name">{c.element.name}</span>
                                        <span className={`chat-mention-kind lang-${c.element.kind.language}`}>{kindOf(c.element)}</span>
                                        <span className="chat-mention-where muted">
                                            {c.element.where ? `${c.element.where} · ${c.element.qualified}` : c.element.qualified}
                                        </span>
                                    </>
                                ) : (
                                    <PersonOption person={c.person} tx={tx} />
                                )}
                            </li>
                        ))}
                    </ul>
                )}
                <ComposerEditor
                    value={value}
                    onChange={(v) => composer.setValue(v)}
                    look={look}
                    onQuery={setQuery}
                    placeholder={isSolo(session.state) ? tx.chat.placeholderSolo : tx.chat.placeholder}
                    rows={size.rows}
                    input={input}
                    api={editor}
                    onBlur={() => setDismissed(slashOpen ? slashKey : queryKey)}
                    onFocus={() => setDismissed(undefined)}
                    onKeyDown={(e) => {
                        if (slashOpen) {
                            const action = composerKey(e, slashed.length > 0);
                            if (action === 'none') {
                                if (e.key === 'Escape') setDismissed(slashKey);
                                return false;
                            }
                            hovered.current = false;
                            if (action === 'next') setActive((a) => (a + 1) % slashed.length);
                            else if (action === 'previous') setActive((a) => (a - 1 + slashed.length) % slashed.length);
                            else if (action === 'pick' || action === 'send') void pickSlash(slashed[active]);
                            else if (action === 'close') setDismissed(slashKey);
                            return true;
                        }
                        const action = composerKey(e, open && matches.length > 0);
                        if (action === 'none') {
                            if (e.key === 'Escape' && open) setDismissed(queryKey);
                            // Esc on an empty text stops the reply
                            else if (e.key === 'Escape' && reply && value.text === '' && !e.isComposing) onReplyDone();
                            return false;
                        }
                        hovered.current = false;
                        if (action === 'next') setActive((a) => (a + 1) % matches.length);
                        else if (action === 'previous') setActive((a) => (a - 1 + matches.length) % matches.length);
                        else if (action === 'pick') pick(matches[active]);
                        else if (action === 'close') setDismissed(queryKey);
                        else void send();
                        return true;
                    }}
                />
            </div>
            <div className="chat-composer-bar">
                {guide !== 'hidden' && <GuideButton state={guide} busy={guiding} label={tx.chat.guide.button} onPress={() => void askGuide()} />}
                <ComposerChips
                    chips={value.chips}
                    expanded={chipsExpanded}
                    onExpanded={setChipsExpanded}
                    nameOf={nameOf}
                    shortOf={shortOf}
                    onRemove={(i) => composer.setValue(removeChip(value, i))}
                    tx={tx}
                />
                <div className="chat-composer-actions">
                    {/* in Collab, the AI's mark when the message will reach it (`@AI`, a reply to the AI); in Solo every message does */}
                    {!isSolo(session.state) && (willAddress(session.state, value.people, reply) || running?.startedBy === session.me.participant.id) && (
                        <span className="chat-composer-ai" role="img" aria-label={tx.chat.ai.willRead} data-tooltip={tx.chat.ai.willRead}>
                            <AiAvatar />
                        </span>
                    )}
                    {/* the shortcut is in the tooltip */}
                    <button
                        className="chat-send"
                        disabled={!canSend}
                        onClick={() => void send()}
                        aria-label={sending ? tx.chat.sending : tx.chat.send}
                        data-tooltip={tx.chat.sendHint(mac ? '⌘+Enter' : 'Ctrl+Enter')}
                    >
                        <SendHorizontal size={15} aria-hidden />
                    </button>
                </div>
            </div>
            {notice && <p className="session-note">{notice}</p>}
            {(error ?? composer.error) && <p className="session-note session-error">{tx.error(error ?? composer.error ?? '')}</p>}
        </div>
    );
}
