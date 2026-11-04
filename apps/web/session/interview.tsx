// A `/es` or `/model` interview in the chat (the plan's round 5): a bar above the composer while it runs — the command's
// name, whether the AI is thinking, and 中止 for its starter and the facilitator — and, once the AI wrote its brief, the
// brief as a card: where it goes (a new storming or journey, or that it replaces the journey's brief), how far the
// journey goes (the ES level and use; the pattern, goal and subject), its lines
// with their heads, and for the facilitator 確定 / 編集して確定 / 中止 (their own interview) or 承認 / 編集して承認 / 却下
// (a participant's, 却下 with an optional note); the others read it with 承認待ち (its starter can still stop it). A
// rejected brief tells its starter so, with the note, until closed. The questions themselves are the AI's
// messages in the stream; in Solo each sits under the answer it follows (`interviewSlot`). Under the question the
// interview awaits, its starter gets its choices as buttons (`InterviewChoices`): one pressed is sent as the answer at
// once, or — when several make one answer — checked and sent together; the last, その他, takes them to the composer.
import { useState, type ReactElement } from 'react';
import { Check, Flag, LoaderCircle, Pencil, Send, Sparkles, X } from 'lucide-react';
import { briefLines, commandId } from '@domaintrail/collaboration';
import type { SendRequestBody, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { useLang } from '../i18n';
import type { Lang } from '@domaintrail/visualization';
import { isAiAuthor, type AiSlot } from './ai';
import { sessionApi } from './api';
import { useChat } from './chat-context';
import { failure } from './parts';
import { ChoiceText } from './reply';
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
    // dt's note after the brief is confirmed is not a question: it stands on its own row, after a new storming's run
    const question = state.requests.find(
        (r) => isAiAuthor(r.author) && r.replyTo?.kind === 'Message' && r.replyTo.request === request.id && r.journeyNote === undefined,
    );
    if (question) return { kind: 'answer', answer: question.id };
    if (interview.state === 'Asking' && interview.awaiting === request.id) return { kind: 'pending' };
    return 'none';
}

/** Whether a message of the starter was sent while the interview ran (after its opening, before it ended). */
function heardBy(i: InterviewJson, id: string, state: Pick<SessionStateBody, 'requests'>): boolean {
    const r = state.requests.find((x) => x.id === id);
    if (!r || r.sentAt < i.startedAt) return false;
    const end = i.state === 'Confirmed' ? i.confirmedAt : i.state === 'Stopped' ? i.stoppedAt : i.state === 'Rejected' ? i.rejectedAt : undefined;
    return end === undefined || r.sentAt <= end;
}

/**
 * What a person does with an interview's brief: the facilitator confirms their own (確定) or approves a participant's
 * (承認, or 却下); the others wait for it.
 */
export function briefRole(
    interview: { readonly startedBy: string },
    me: { readonly id: string; readonly role: string },
    live: boolean,
): 'confirm' | 'approve' | 'wait' {
    if (!live || me.role !== 'facilitator') return 'wait';
    return interview.startedBy === me.id ? 'confirm' : 'approve';
}

/** My latest interview, when it ended with its brief rejected (its note shows until closed). */
export function rejectedOfMine(state: Pick<SessionStateBody, 'interviews'>, me: string): Extract<InterviewJson, { state: 'Rejected' }> | undefined {
    const latest = (state.interviews ?? []).at(-1);
    return latest?.state === 'Rejected' && latest.startedBy === me ? latest : undefined;
}

/** The running interview's bar and brief, above the composer; or my brief rejected. */
/** A brief's title: the storming's label and ID, or the journey's name. */
const briefTitle = (brief: NonNullable<Extract<InterviewJson, { state: 'Briefed' }>['brief']>): string => {
    const name = brief.journey?.journeyName ?? brief.label;
    return name ? `${name} · ${brief.name}` : brief.name;
};

/** How far the brief's journey goes, in one line: the ES level and use, or the pattern, goal and subject. */
function BriefHowFar({ journey: j }: { readonly journey: NonNullable<Extract<InterviewJson, { state: 'Briefed' }>['brief']['journey']> }): ReactElement {
    const { tx } = useChat();
    const g = tx.chat.guide;
    const parts =
        j.level !== undefined
            ? [g.levels[j.level] ?? j.level, j.use !== undefined ? tx.chat.journeys.uses[j.use === 'Modeling' ? 'modeling' : 'align'] : undefined]
            : [
                  j.pattern !== undefined ? (g.patterns[j.pattern] ?? j.pattern) : undefined,
                  j.goal !== undefined ? g.goal(g.steps[j.goal] ?? j.goal) : undefined,
                  j.stormings.length > 0 ? j.stormings.map((x) => `ES「${x}」`).join('、') : undefined,
                  j.context,
              ];
    return (
        <p className="chat-brief-howfar">
            <Flag size={12} aria-hidden />
            {parts.filter((x) => x !== undefined).join(' · ')}
        </p>
    );
}

export function InterviewPanel(props: { session: SessionData; live: boolean }) {
    const { tx } = useChat();
    const t = tx.chat.interview;
    const { session } = props;
    const me = session.me.participant;
    const interview = runningInterview(session.state);
    const [editing, setEditing] = useState<string | undefined>();
    const [rejecting, setRejecting] = useState<string | undefined>();
    const [closed, setClosed] = useState<string | undefined>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const rejected = props.live && !interview ? rejectedOfMine(session.state, me.id) : undefined;
    if (rejected && closed !== rejected.id)
        return (
            <div className="chat-interview motion-pop motion-pop-up" role="status">
                <div className="chat-interview-bar">
                    <Sparkles size={13} aria-hidden className="chat-slash-icon" />
                    <span className="chat-interview-name">{tx.chat.slash.commands[commandId(rejected.command)]}</span>
                    <span className="chat-interview-state muted">{t.rejected}</span>
                    <button className="chat-small" onClick={() => setClosed(rejected.id)}>
                        {t.close}
                    </button>
                </div>
                {rejected.note && (
                    <div className="chat-brief">
                        <p className="chat-brief-note">{rejected.note}</p>
                    </div>
                )}
            </div>
        );
    if (!interview) return null;
    // stops it: its starter, or the facilitator
    const mine = props.live && (interview.startedBy === me.id || me.role === 'facilitator');
    const role = briefRole(interview, me, props.live);
    const name = tx.chat.slash.commands[commandId(interview.command)];
    const act = async (work: () => Promise<unknown>): Promise<void> => {
        setBusy(true);
        try {
            await work();
            setEditing(undefined);
            setRejecting(undefined);
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
                        <span className="chat-brief-name">{briefTitle(brief)}</span>
                        {brief.isNew && <span className="chat-brief-flag">{interview.command === 'Es' ? t.newStorming : t.newJourney}</span>}
                        {brief.replaces && <span className="chat-brief-flag warn">{t.replaces}</span>}
                    </div>
                    {brief.journey && <BriefHowFar journey={brief.journey} />}
                    {editing === undefined ? (
                        <dl className="brief-lines chat-brief-lines">
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
                    {role === 'wait' ? (
                        <>
                            <p className="chat-brief-waiting muted">{t.waiting}</p>
                            {mine && <div className="chat-brief-actions">{stop}</div>}
                        </>
                    ) : rejecting !== undefined ? (
                        <form
                            className="chat-apply-note"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void act(() => sessionApi.rejectInterview(interview.id, rejecting.trim() || undefined));
                            }}
                        >
                            <input
                                className="session-text"
                                autoFocus
                                value={rejecting}
                                maxLength={2000}
                                placeholder={t.note}
                                aria-label={t.note}
                                onChange={(e) => setRejecting(e.target.value)}
                            />
                            <button type="submit" className="chat-small danger" disabled={busy}>
                                {t.reject}
                            </button>
                            <button type="button" className="icon-button" onClick={() => setRejecting(undefined)} aria-label={t.cancel}>
                                <X size={13} aria-hidden />
                            </button>
                        </form>
                    ) : (
                        <div className="chat-brief-actions">
                            {editing === undefined ? (
                                <>
                                    <button
                                        className="chat-small primary"
                                        disabled={busy}
                                        onClick={() => void act(() => sessionApi.confirmInterview(interview.id))}
                                    >
                                        <Check size={12} aria-hidden /> {role === 'approve' ? t.approve : t.confirm}
                                    </button>
                                    <button className="chat-small" disabled={busy} onClick={() => setEditing(brief.text)}>
                                        <Pencil size={12} aria-hidden /> {role === 'approve' ? t.editApprove : t.editConfirm}
                                    </button>
                                    {role === 'approve' ? (
                                        <button className="chat-small ghost" disabled={busy} onClick={() => setRejecting('')}>
                                            {t.reject}
                                        </button>
                                    ) : (
                                        stop
                                    )}
                                </>
                            ) : (
                                <>
                                    <button
                                        className="chat-small primary"
                                        disabled={busy || editing.trim() === ''}
                                        onClick={() => void act(() => sessionApi.confirmInterview(interview.id, editing))}
                                    >
                                        <Check size={12} aria-hidden /> {role === 'approve' ? t.approve : t.confirm}
                                    </button>
                                    <button className="chat-small" disabled={busy} onClick={() => setEditing(undefined)}>
                                        {t.cancel}
                                    </button>
                                </>
                            )}
                        </div>
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
 * 送る; always その他 last. Each choice is the AI's text shown as text, an element it names by its label as a message
 * names it (`ChoiceText`, no link); what is sent is the choice as written, its references whole.
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
                          <ChoiceText text={c} />
                      </label>
                  ))
                : choices.map((c, i) => (
                      <button key={i} type="button" className="interview-choice" disabled={busy} onClick={() => props.onSend(c)}>
                          <ChoiceText text={c} />
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
