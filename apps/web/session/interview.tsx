// A `/es` or `/model` interview in the chat (the plan's round 5): a bar above the composer while it runs — the command's
// name, whether the AI is thinking, and 中止 for its starter — and, once the AI wrote its brief, the brief as a card:
// where it goes (a new storming or context, or that it replaces the current description), its lines with their heads,
// and 確定 / 編集して確定 / 中止 for its starter (the others see it read-only). The questions themselves are the AI's
// messages in the stream; in Solo each sits under the answer it follows (`interviewSlot`).
import { useState } from 'react';
import { Check, LoaderCircle, Pencil, Sparkles, X } from 'lucide-react';
import { briefLines, commandId } from '@domaintrail/collaboration';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { isAiAuthor, type AiSlot } from './ai';
import { sessionApi } from './api';
import { useChat } from './chat-context';
import { failure } from './parts';
import { runningInterview, type InterviewJson } from './slash';
import type { SessionData } from './useSession';

type RequestJson = SessionStateBody['requests'][number];

/**
 * The AI's card under a message of a running or ended interview (Solo): the AI's question that replies to it, pending
 * while the interviewer is to answer it, or `none` (the brief answered it, or the interview ended). Undefined for any
 * other message (its triage decides).
 */
export function interviewSlot(
    state: Pick<SessionStateBody, 'interviews' | 'requests'>,
    request: Pick<RequestJson, 'id' | 'author'>,
): AiSlot | 'none' | undefined {
    if (isAiAuthor(request.author)) return undefined;
    const interview = (state.interviews ?? []).find((i) => i.startedBy === request.author && (i.opening === request.id || heardBy(i, request.id, state)));
    if (!interview) return undefined;
    const question = state.requests.find((r) => isAiAuthor(r.author) && r.replyTo?.kind === 'Message' && r.replyTo.request === request.id);
    if (question) return { kind: 'answer', answer: question.id };
    if (interview.state === 'Asking' && interview.awaiting === request.id) return { kind: 'pending' };
    return 'none';
}

/** Whether a message of the starter was sent while the interview ran (after its opening, before it ended). */
function heardBy(i: InterviewJson, id: string, state: Pick<SessionStateBody, 'requests'>): boolean {
    const r = state.requests.find((x) => x.id === id);
    if (!r || r.sentAt < i.startedAt) return false;
    const end = i.state === 'Confirmed' ? i.confirmedAt : i.state === 'Stopped' ? i.stoppedAt : undefined;
    return end === undefined || r.sentAt <= end;
}

/** The running interview's bar and brief, above the composer. */
export function InterviewPanel(props: { session: SessionData; live: boolean }) {
    const { tx } = useChat();
    const t = tx.chat.interview;
    const { session } = props;
    const interview = runningInterview(session.state);
    const [editing, setEditing] = useState<string | undefined>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    if (!interview) return null;
    const mine = props.live && interview.startedBy === session.me.participant.id;
    const name = tx.chat.slash.commands[commandId(interview.command)];
    const act = async (work: () => Promise<unknown>): Promise<void> => {
        setBusy(true);
        try {
            await work();
            setEditing(undefined);
            setError(undefined);
        } catch (e) {
            setError(failure(e));
        } finally {
            setBusy(false);
        }
    };
    const stop = (
        <button className="chat-small" disabled={busy} onClick={() => void act(() => sessionApi.stopInterview(interview.id))}>
            <X size={12} aria-hidden /> {t.stop}
        </button>
    );
    const brief = interview.state === 'Briefed' ? interview.brief : undefined;
    return (
        <div className="chat-interview motion-pop motion-pop-up" role="status" aria-label={`${t.running}: ${name}`}>
            <div className="chat-interview-bar">
                <Sparkles size={13} aria-hidden className="chat-slash-icon" />
                <span className="chat-interview-name">{name}</span>
                <span className="chat-interview-state muted">
                    {interview.state === 'Asking' && interview.awaiting ? (
                        <>
                            <LoaderCircle size={12} aria-hidden className="spin" /> {t.thinking}
                        </>
                    ) : brief ? (
                        t.brief
                    ) : (
                        t.running
                    )}
                </span>
                {mine && !brief && stop}
            </div>
            {brief && (
                <div className="chat-brief">
                    <div className="chat-brief-target">
                        <span className="chat-brief-name">{brief.label ? `${brief.label} · ${brief.name}` : brief.name}</span>
                        {brief.isNew && <span className="chat-brief-flag">{interview.command === 'Es' ? t.newStorming : t.newContext}</span>}
                        {brief.replaces && <span className="chat-brief-flag warn">{t.replaces}</span>}
                    </div>
                    {editing === undefined ? (
                        <dl className="chat-brief-lines">
                            {briefLines(brief.text).map((l, i) => (
                                <div key={i} className="chat-brief-line">
                                    {l.head !== undefined && <dt>{l.head}</dt>}
                                    <dd>{l.text}</dd>
                                </div>
                            ))}
                        </dl>
                    ) : (
                        <textarea
                            className="chat-brief-edit"
                            aria-label={t.text}
                            value={editing}
                            rows={Math.min(8, editing.split('\n').length + 1)}
                            onChange={(e) => setEditing(e.target.value)}
                            autoFocus
                        />
                    )}
                    {mine ? (
                        <div className="chat-brief-actions">
                            {editing === undefined ? (
                                <>
                                    <button
                                        className="chat-small primary"
                                        disabled={busy}
                                        onClick={() => void act(() => sessionApi.confirmInterview(interview.id))}
                                    >
                                        <Check size={12} aria-hidden /> {t.confirm}
                                    </button>
                                    <button className="chat-small" disabled={busy} onClick={() => setEditing(brief.text)}>
                                        <Pencil size={12} aria-hidden /> {t.editConfirm}
                                    </button>
                                    {stop}
                                </>
                            ) : (
                                <>
                                    <button
                                        className="chat-small primary"
                                        disabled={busy || editing.trim() === ''}
                                        onClick={() => void act(() => sessionApi.confirmInterview(interview.id, editing))}
                                    >
                                        <Check size={12} aria-hidden /> {t.confirm}
                                    </button>
                                    <button className="chat-small" disabled={busy} onClick={() => setEditing(undefined)}>
                                        {t.cancel}
                                    </button>
                                </>
                            )}
                        </div>
                    ) : (
                        <p className="chat-brief-waiting muted">{t.waiting}</p>
                    )}
                </div>
            )}
            {error && <p className="session-note session-error">{tx.error(error)}</p>}
        </div>
    );
}
