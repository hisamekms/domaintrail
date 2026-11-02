// What the parts of the chat share (ADR 0026, amendment: messages and apply): the session, who is who, the facilitator's
// actions and revision tools, and the selection of messages to apply together. A message and its quote are not marked
// together on hover: each row reacts only to itself, and a link leads from one to the other.
import { createContext, useContext } from 'react';
import type { Classification } from '@domaintrail/collaboration/protocol';
import type { Messages } from '../i18n';
import type { ChatActions, QuestionChoice } from './actions';
import type { MessageMark } from './cards';
import type { MarkIndex, MarkTargetData, Sign } from './marks';
import type { MessageReference, ReplyDraft, ReplyReference } from './replies';
import type { RevisionTools } from './revisions';
import type { ModelTarget } from './targets';
import type { SessionData } from './useSession';

export type Tx = Messages['session'];

export interface ChatContextValue {
    readonly session: SessionData;
    readonly tx: Tx;
    readonly now: number;
    readonly nameOf: (id: string) => string;
    /** A participant's avatar URL, when their page tells one. */
    readonly avatarOf: (id: string) => string | undefined;
    readonly onNavigate: (target: ModelTarget) => void;
    /** The facilitator, in an open session: the actions are offered. */
    readonly control: boolean;
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
    /** The facilitator's: how each message reads (undefined: not classified, every message applicable). */
    readonly classifications: Readonly<Record<string, Classification>> | undefined;
    /** The messages chosen to apply together (selection mode while any is chosen or the mode was entered). */
    readonly selection: { readonly active: boolean; readonly ids: ReadonlySet<string>; toggle(id: string): void; start(id: string): void; clear(): void };
    /** Scrolls the stream to an item (`message:<id>`, `card:<key>`) and marks it for a moment. */
    readonly jump: (key: string) => void;
    /** Opens the participants at a person (a mention of them was clicked), their row marked for a moment. */
    readonly showPerson: (id: string) => void;
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
