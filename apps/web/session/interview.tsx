// A `/es` or `/model` interview in the chat (the plan's round 5): a bar above the composer while it runs — the command's
// name, whether the AI is thinking, and 中止 for its starter — and, once the AI wrote its brief, the brief as a card:
// where it goes (a new storming or context, or that it replaces the current description), its lines with their heads,
// and 確定 / 編集して確定 / 中止 for its starter (the others see it read-only). The questions themselves are the AI's
// messages in the stream; in Solo each sits under the answer it follows (`interviewSlot`). Under the question the
// interview awaits, its starter gets its choices as buttons (`InterviewChoices`): one pressed is sent as the answer at
// once, or — when several make one answer — checked and sent together; the last, その他, takes them to the composer.
import { useState, type ReactElement } from 'react';
import { Check, LoaderCircle, Pencil, Send, Sparkles, X } from 'lucide-react';
import { briefLines, commandId } from '@domaintrail/collaboration';
import type { SendRequestBody, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { useLang } from '../i18n';
import type { Lang } from '@domaintrail/visualization';
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

/** The choices of the question the interview awaits an answer to, for its starter. */
export interface AwaitedChoices {
    /** The AI's question (its message). */
    readonly question: string;
    readonly choices: readonly string[];
    /** Several make one answer: checked, then sent together. */
    readonly multiple: boolean;
}

/**
 * The choices to show under a message of the AI: only when it is the question the running interview awaits an answer
 * to (none once its starter answered, or the next question came), only for its starter on a live page, only when it
 * has any. The others in a Collab session do not see them: the starter's answer shows as a message.
 */
export function awaitedChoices(state: Pick<SessionStateBody, 'interviews'>, request: string, me: string, live: boolean): AwaitedChoices | undefined {
    if (!live) return undefined;
    const i = runningInterview(state);
    if (!i || i.state !== 'Asking' || i.startedBy !== me || i.awaiting !== undefined) return undefined;
    const asked = i.asked;
    if (!asked || asked.question !== request || asked.choices.length === 0) return undefined;
    return { question: asked.question, choices: asked.choices, multiple: asked.multiple };
}

/** Several choices as one answer, in their order: joined with 「、」 in Japanese, ", " in English. */
export const joinChoices = (picked: readonly string[], lang: Lang): string => picked.join(lang === 'ja' ? '、' : ', ');

/** The answer of a choice (or several, joined) as a message: a reply to the question, as the composer would send it. */
export const choiceAnswerBody = (question: string, text: string): SendRequestBody => ({
    targets: [],
    body: text,
    replyTo: { kind: 'Message', request: question },
});

/** What the choices' buttons do: the state is the caller's (`InterviewChoices`), so this renders the same each time. */
export interface ChoiceListProps {
    readonly choices: readonly string[];
    readonly multiple: boolean;
    /** The choices checked (multiple), by index. */
    readonly checked: ReadonlySet<number>;
    readonly busy: boolean;
    readonly lang: Lang;
    readonly tx: ReturnType<typeof useChat>['tx']['chat']['interview']['choices'];
    readonly onToggle: (index: number) => void;
    /** An answer to send: the choice pressed (single), or the checked ones joined (multiple). */
    readonly onSend: (text: string) => void;
    /** その他: the person writes the answer in the composer. */
    readonly onOther: () => void;
}

/**
 * The choices under the question: buttons in the action colour that send one at once, or (multiple) checkboxes and
 * 送る; always その他 last. Each choice is the AI's text shown as text.
 */
export function ChoiceList(props: ChoiceListProps): ReactElement {
    const { choices, multiple, checked, busy, tx } = props;
    const picked = choices.filter((_, i) => checked.has(i));
    return (
        <div className="interview-choices" role="group" aria-label={tx.label}>
            {multiple
                ? choices.map((c, i) => (
                      <label key={i} className={checked.has(i) ? 'interview-choice checked' : 'interview-choice'}>
                          <input type="checkbox" checked={checked.has(i)} disabled={busy} onChange={() => props.onToggle(i)} />
                          {c}
                      </label>
                  ))
                : choices.map((c, i) => (
                      <button key={i} type="button" className="interview-choice" disabled={busy} onClick={() => props.onSend(c)}>
                          {c}
                      </button>
                  ))}
            {multiple && (
                <button
                    type="button"
                    className="interview-choice send"
                    disabled={busy || picked.length === 0}
                    onClick={() => props.onSend(joinChoices(picked, props.lang))}
                >
                    <Send size={12} aria-hidden /> {tx.send}
                </button>
            )}
            <button type="button" className="interview-choice other" disabled={busy} onClick={props.onOther}>
                {tx.other}
            </button>
        </div>
    );
}

/** The choices of the question the interview awaits, under the AI's message, for its starter (nothing otherwise). */
export function InterviewChoices({ request }: { request: string }) {
    const { session, tx, focusComposer } = useChat();
    const lang = useLang();
    const live = session.status === 'live' && session.state.session.state === 'Open';
    const awaited = awaitedChoices(session.state, request, session.me.participant.id, live);
    const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
    const [busy, setBusy] = useState(false);
    // sent: hidden at once, before the state says the interview heard it
    const [sent, setSent] = useState(false);
    const [error, setError] = useState<string | undefined>();
    if (!awaited || sent) return null;
    const send = async (text: string): Promise<void> => {
        setBusy(true);
        try {
            await sessionApi.sendRequest(choiceAnswerBody(awaited.question, text));
            setSent(true);
            setError(undefined);
        } catch (e) {
            setError(failure(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <>
            <ChoiceList
                choices={awaited.choices}
                multiple={awaited.multiple}
                checked={checked}
                busy={busy}
                lang={lang}
                tx={tx.chat.interview.choices}
                onToggle={(i) =>
                    setChecked((s) => {
                        const next = new Set(s);
                        if (next.has(i)) next.delete(i);
                        else next.add(i);
                        return next;
                    })
                }
                onSend={(text) => void send(text)}
                onOther={focusComposer}
            />
            {error && <p className="session-note session-error">{tx.error(error)}</p>}
        </>
    );
}
