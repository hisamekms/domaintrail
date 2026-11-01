// What the parts of the chat share (ADR 0026, amendment: messages and apply): the session, who is who, the facilitator's
// actions and revision tools, the selection of messages to apply together, and the pairing of a message with its quote
// (hovered on either side, both are marked; no line is drawn between them).
import { createContext, useContext } from 'react';
import type { Classification } from '@domaintrail/collaboration/protocol';
import type { Messages } from '../i18n';
import type { ChatActions } from './actions';
import type { MessageMark } from './cards';
import type { MarkIndex, MarkTargetData, Sign } from './marks';
import type { ReplyDraft, ReplyReference } from './replies';
import type { RevisionTools } from './revisions';
import type { ModelTarget } from './targets';
import type { SessionData } from './useSession';

export type Tx = Messages['session'];

export interface ChatContextValue {
    readonly session: SessionData;
    readonly tx: Tx;
    readonly now: number;
    readonly nameOf: (id: string) => string;
    readonly onNavigate: (target: ModelTarget) => void;
    /** The facilitator, in an open session: the actions are offered. */
    readonly control: boolean;
    readonly actions: ChatActions;
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
    /** The message hovered on either side (its ID), for the pairing of a quote with its message. */
    readonly hovered: string | undefined;
    readonly hover: (id: string | undefined) => void;
    /** Scrolls the stream to an item (`message:<id>`, `card:<key>`) and marks it for a moment. */
    readonly jump: (key: string) => void;
    /** Opens the participants at a person (a mention of them was clicked), their row marked for a moment. */
    readonly showPerson: (id: string) => void;
    /** Replies to runs: the reply being written, starting one (from an AI turn) and what a posted reply names. */
    readonly replies: {
        readonly draft: ReplyDraft | undefined;
        start(run: string): void;
        cancel(): void;
        referenceOf(run: string): ReplyReference | undefined;
    };
}

const ChatContext = createContext<ChatContextValue | undefined>(undefined);
export const ChatProvider = ChatContext.Provider;

export function useChat(): ChatContextValue {
    const c = useContext(ChatContext);
    if (!c) throw new Error('useChat outside the chat');
    return c;
}
