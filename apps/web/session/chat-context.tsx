// What the parts of the chat share (ADR 0026, amendment: messages and apply): the session, who is who, the facilitator's
// actions and revision tools, and the selection of messages to apply together. A message and its quote are not marked
// together on hover: each row reacts only to itself, and a link leads from one to the other.
import { createContext, useContext } from 'react';
import type { Messages } from '../i18n';
import type { ChatActions, QuestionChoice } from './actions';
import type { TriageJson } from './ai';
import type { MessageMark } from './cards';
import type { MarkIndex, MarkTargetData, Sign } from './marks';
import type { MessageReference, ReplyDraft, ReplyReference } from './replies';
import type { RevisionTools } from './revisions';
import type { ModelTarget } from './targets';
import type { SessionData } from './useSession';
import type { ViewTarget } from './views';
import type { JourneyAct, GuideWorkspace } from '@domaintrail/collaboration';
import type { JourneyBody } from '@domaintrail/collaboration/protocol';
import type { JourneyOverview } from './journey-view';

export type Tx = Messages['session'];

export interface ChatContextValue {
    readonly session: SessionData;
    readonly tx: Tx;
    readonly now: number;
    readonly nameOf: (id: string) => string;
    /** A participant's avatar URL, when their page tells one. */
    readonly avatarOf: (id: string) => string | undefined;
    readonly onNavigate: (target: ModelTarget) => void;
    /** Opens a view (a storming's stage, a context's structure): the guide's places. */
    readonly openView: (target: ViewTarget) => void;
    /** The facilitator, in an open session: the actions are offered. */
    readonly control: boolean;
    /** The session is `dt open`'s (one person, every message to the AI): what only makes sense with others is hidden. */
    readonly solo: boolean;
    /** The triage of each message addressed to the AI, by the message's ID (ADR 0030). */
    readonly triages: ReadonlyMap<string, TriageJson>;
    /** The messages whose answer or proposal the server gave up. */
    readonly givenUp: ReadonlySet<string>;
    /**
     * The open change proposals the facilitator chose to approve together (one run), and the option the facilitator
     * picked of each proposal with options (by its ID; none: the AI's recommendation).
     */
    readonly proposalPicks: {
        readonly ids: ReadonlySet<string>;
        toggle(id: string): void;
        clear(): void;
        readonly options: ReadonlyMap<string, number>;
        choose(id: string, option: number): void;
    };
    readonly actions: ChatActions;
    /** The facilitator cancels a unit's running or queued run (`ChangeUnit.key`): a dialog asks first. */
    readonly confirmCancel: (unit: string) => void;
    /**
     * The facilitator's answer being chosen to each run's questions (by run ID, then question ID), kept here so that the
     * chat's form and AI の作業's form of the same run show one answer.
     */
    readonly answers: {
        of(run: string): Readonly<Record<string, QuestionChoice>>;
        update(run: string, f: (choices: Readonly<Record<string, QuestionChoice>>) => Readonly<Record<string, QuestionChoice>>): void;
    };
    readonly revisions: RevisionTools;
    readonly marks: ReadonlyMap<string, MessageMark>;
    /** Votes and reactions: the session's placed marks counted, and setting one of mine (placed or taken off). */
    readonly marking: {
        readonly index: MarkIndex;
        set(target: MarkTargetData, sign: Sign, placed: boolean): void;
        /** A mark being set (its sign and target key): not clickable again until the server answered. */
        readonly pending: ReadonlySet<string>;
    };
    /** The messages chosen to apply together (selection mode while any is chosen or the mode was entered). */
    readonly selection: { readonly active: boolean; readonly ids: ReadonlySet<string>; toggle(id: string): void; start(id: string): void; clear(): void };
    /**
     * Whether a long text is clamped (by its key: `message:<id>`, `proposal:<id>`, `run:<id>`): only one there when the
     * page loaded and not opened yet; `open` keeps it open (`reveal.ts`).
     */
    readonly reveal: { clamps(key: string): boolean; open(key: string): void };
    /** Scrolls the stream to an item (`message:<id>`, `card:<key>`) and marks it for a moment. */
    readonly jump: (key: string) => void;
    /** Opens the participants at a person (a mention of them was clicked), their row marked for a moment. */
    readonly showPerson: (id: string) => void;
    /**
     * Puts a `/` command in the composer (`es:gaps`: the text `/es:gaps`, which opens `/`'s list on it) and gives it the
     * focus: the person starts it from there. What the composer held is replaced.
     */
    readonly putCommand: (id: string) => void;
    /** Gives the composer the focus (in the chat), what it holds kept: an interview's その他. */
    readonly focusComposer: () => void;
    /**
     * The journeys (the journey file the server sent, each journey's map as the files tell it now, the session's
     * current journey), the panel open or not, and the acts: done at once for the facilitator, a request for anyone
     * else (`notice` says which, or what failed).
     */
    readonly journeys: {
        readonly body: JourneyBody;
        readonly workspace: GuideWorkspace;
        readonly overview: JourneyOverview;
        readonly open: boolean;
        setOpen(open: boolean): void;
        act(act: JourneyAct): void;
        choose(journey: string | null): void;
        decide(id: string, decision: 'approve' | 'deny' | 'withdraw'): void;
        /** ガイドを見る: the latest guide shown, or a new one started. */
        seeGuide(): void;
        readonly notice: { readonly text: string; readonly error: boolean } | undefined;
    };
    /** Replies to runs and messages: the reply being written, starting one (from an AI turn or a message) and what a posted reply names. */
    readonly replies: {
        readonly draft: ReplyDraft | undefined;
        start(run: string): void;
        startMessage(request: string): void;
        cancel(): void;
        referenceOf(run: string): ReplyReference | undefined;
        messageReferenceOf(request: string): MessageReference | undefined;
    };
}

const ChatContext = createContext<ChatContextValue | undefined>(undefined);
export const ChatProvider = ChatContext.Provider;

export function useChat(): ChatContextValue {
    const c = useContext(ChatContext);
    if (!c) throw new Error('useChat outside the chat');
    return c;
}
