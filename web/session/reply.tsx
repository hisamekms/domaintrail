// The agent's reply as the chat and the facilitator's panel show it (ADR 0026, appendix "Structured replies"): the
// measured facts first and small (the files the run changed), then what the AI says — its summary, a line per request
// with its status, the assumptions it made with their alternatives, its questions with their options — as plain
// text, never markup. Nothing here can be chosen yet: the options are shown as they will be offered, disabled.
import { CircleHelp, Lightbulb } from 'lucide-react';
import type { Messages } from '../i18n';
import { bodyText } from './mentions';
import { oneLine, type ReplyRequest, type ReplyView, type RequestProgress } from './stream';

type Tx = Messages['session'];

/** The mark of a request's status: ✓ done, ◐ partly, – not done, ? a question. */
const MARK: Record<RequestProgress, string> = { Done: '✓', Partial: '◐', Skipped: '–', Question: '?' };

/** The first characters of a request's body on one line. */
function head(r: ReplyRequest, max = 48): string {
    const text = oneLine(bodyText(r.request.body, r.request.targets.length));
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The measured facts of a run: how many files it changed (from its revisions), or none. */
export function ReplyFacts({ files, changed, tx }: { files: number | undefined; changed: boolean; tx: Tx }) {
    const r = tx.chat.reply;
    return (
        <p className="reply-facts" data-tooltip={r.appliedHint}>
            {changed ? r.applied(files) : r.unchanged}
        </p>
    );
}

/** Which requests something is about: each as its author and the head of its body. */
function RequestRefs({ requests, nameOf, tx }: { requests: readonly ReplyRequest[]; nameOf: (id: string) => string; tx: Tx }) {
    if (requests.length === 0) return null;
    return (
        <span className="reply-refs">
            {requests.map((r) => (
                <span
                    key={r.request.request}
                    className="reply-ref"
                    title={`${tx.chat.reply.request(r.number)} · ${nameOf(r.request.author)}\n${r.request.body}`}
                >
                    {nameOf(r.request.author)} · {head(r, 24)}
                </span>
            ))}
        </span>
    );
}

/** The summary (unless `summary` is false: shown otherwise), the requests' lines and the assumptions of a reply. */
export function ReplyDetails({ reply, summary = true, nameOf, tx }: { reply: ReplyView; summary?: boolean; nameOf: (id: string) => string; tx: Tx }) {
    const r = tx.chat.reply;
    return (
        <>
            {summary && <p className="chat-text reply-summary">{reply.summary}</p>}
            {reply.requests.length > 0 && (
                <ul className="reply-requests">
                    {reply.requests.map((line) => (
                        <li key={line.request.request.request} className={`reply-request status-${line.status}`} title={line.request.request.body}>
                            <span className="reply-mark" role="img" aria-label={r.status[line.status]} data-tooltip={r.status[line.status]}>
                                {MARK[line.status]}
                            </span>
                            <span className="reply-line">
                                <span className="reply-who">{nameOf(line.request.request.author)}</span>
                                <span className="reply-head">{head(line.request)}</span>
                                {line.note && <span className="reply-note">{line.note}</span>}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {reply.assumptions.length > 0 && (
                <ul className="reply-assumptions">
                    {reply.assumptions.map((a, i) => (
                        <li key={i} className="reply-assumption">
                            <Lightbulb size={13} className="reply-icon" aria-label={r.assumption} />
                            <span className="reply-line">
                                <span className="reply-text">{a.text}</span>
                                <RequestRefs requests={a.requests} nameOf={nameOf} tx={tx} />
                                {a.alternatives.length > 0 && (
                                    <span className="reply-alternatives" aria-label={r.alternatives}>
                                        {a.alternatives.map((alt) => (
                                            <span key={alt.id} className="reply-alternative">
                                                {alt.label}
                                            </span>
                                        ))}
                                    </span>
                                )}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </>
    );
}

/** The questions of a reply, each with its options as they will be offered (disabled), and "other" always last. */
export function ReplyQuestions({ reply, scope, nameOf, tx }: { reply: ReplyView; scope: string; nameOf: (id: string) => string; tx: Tx }) {
    const r = tx.chat.reply;
    return (
        <ol className="reply-questions">
            {reply.questions.map((q) => {
                const type = q.multiple ? 'checkbox' : 'radio';
                const name = `${scope}:${q.id}`;
                return (
                    <li key={q.id} className="reply-question">
                        <div className="chat-with-icon">
                            <CircleHelp size={16} className="chat-icon" aria-hidden />
                            <p className="chat-question">{q.text}</p>
                        </div>
                        <RequestRefs requests={q.requests} nameOf={nameOf} tx={tx} />
                        <ul className="reply-options" {...(q.multiple && { 'aria-label': r.multiple })}>
                            {q.options.map((o) => (
                                <li key={o.id}>
                                    <label className="reply-option">
                                        <input type={type} name={name} disabled />
                                        <span>
                                            <span className="reply-option-label">{o.label}</span>
                                            {o.detail && <span className="reply-option-detail">{o.detail}</span>}
                                        </span>
                                    </label>
                                </li>
                            ))}
                            <li>
                                <label className="reply-option reply-other">
                                    <input type={type} name={name} disabled />
                                    <span className="reply-option-label">{r.other}</span>
                                </label>
                            </li>
                        </ul>
                    </li>
                );
            })}
        </ol>
    );
}
