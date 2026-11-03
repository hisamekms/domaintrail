// `/es:next`'s answer in the chat (the plan's "Built-in ES commands, phase 2"): the AI's message shows its status on
// one line and its one to three steps as a numbered list, each its text, its reason muted and — when an ES command does
// that step — a button with the command's ID in the brand's colour, which puts the command in the composer (`/`'s list
// opens on it): the person sends it, nothing runs by itself. A command the person may not start (the facilitator's) has
// no button; one of a kind already running is disabled. The message's text (Markdown, the same list) is what the
// session so far and any other reader see.
import { CornerDownLeft } from 'lucide-react';
import { suggestedCommandId, type SuggestedCommandId } from '@domaintrail/collaboration';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { useChat } from './chat-context';
import type { ComposerValue } from './mentions';
import { ReplyText } from './reply';
import { canStartCommand, isCommandAllowed, type SlashCommandJson } from './slash';

/** `/es:next`'s answer as the page reads it. */
export type NextAnswerJson = NonNullable<Extract<SlashCommandJson, { state: 'Answered' }>['next']>;

/** The next steps of the `/es:next` answered with this message of the AI, if it is one. */
export function nextAnswerOf(state: Pick<SessionStateBody, 'slashCommands'>, request: string): NextAnswerJson | undefined {
    const c = (state.slashCommands ?? []).find((x) => x.state === 'Answered' && x.answer === request);
    return c?.state === 'Answered' ? c.next : undefined;
}

/** The composer holding a command: `/` and its ID, nothing else (`/`'s list opens on it). */
export const commandComposerValue = (id: string): ComposerValue => ({ text: `/${id}`, chips: [], people: [] });

/** A step's command button: shown when the person may start it at all, enabled when they may now. */
export function commandButton(
    state: Pick<SessionStateBody, 'interviews' | 'slashCommands'>,
    facilitator: boolean,
    id: SuggestedCommandId,
): 'enabled' | 'disabled' | 'hidden' {
    if (!isCommandAllowed(facilitator, id)) return 'hidden';
    return canStartCommand(state, facilitator, id) ? 'enabled' : 'disabled';
}

export function NextSteps({ next }: { next: NextAnswerJson }) {
    const { tx, session, onNavigate, putCommand } = useChat();
    const live = session.status === 'live' && session.state.session.state === 'Open';
    const facilitator = session.me.participant.role === 'facilitator';
    return (
        <div className="next-answer">
            <p className="next-status">
                <ReplyText text={next.status} onNavigate={onNavigate} />
            </p>
            <ol className="next-steps">
                {next.steps.map((s, i) => {
                    const id = s.command && suggestedCommandId(s.command);
                    const button = id && live ? commandButton(session.state, facilitator, id) : 'hidden';
                    return (
                        <li key={i} className="next-step">
                            <span className="next-step-head">
                                <span className="next-step-text">
                                    <ReplyText text={s.text} onNavigate={onNavigate} />
                                </span>
                                {id && button !== 'hidden' && (
                                    <button
                                        type="button"
                                        className="chat-small primary next-command"
                                        disabled={button === 'disabled'}
                                        data-tooltip={tx.chat.candidates.putCommand}
                                        aria-label={`/${id}: ${tx.chat.candidates.putCommand}`}
                                        onClick={() => putCommand(id)}
                                    >
                                        <CornerDownLeft size={12} aria-hidden />/{id}
                                    </button>
                                )}
                            </span>
                            <span className="next-step-reason muted">
                                <ReplyText text={s.reason} onNavigate={onNavigate} />
                            </span>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}
