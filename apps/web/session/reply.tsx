// The agent's reply as the chat and the facilitator's panel show it (ADR 0026, appendix "Structured replies"): what
// the AI says — its summary, a line per request with its status, the assumptions it made with their alternatives, its
// questions with their options — as plain text, never markup; element references in it (`references.ts`) are named in
// the display setting and link to the element. Nothing here can be chosen yet: the options are shown as they will be
// offered, disabled.
import { Fragment } from 'react';
import type { Messages } from '../i18n';
import { bodyText } from './mentions';
import { useTargetNaming } from './naming';
import { parseReplyText, referenceText } from './references';
import { oneLine, type ReplyRequest, type ReplyView, type RequestProgress } from './stream';
import type { ModelTarget } from './targets';

type Tx = Messages['session'];
type Navigate = (target: ModelTarget) => void;

/**
 * Text of the reply: its element references as links by their own name in the display setting (the whole path in the
 * tooltip), unresolved ones as their identifier.
 */
export function ReplyText({ text, onNavigate }: { text: string; onNavigate: Navigate }) {
    const naming = useTargetNaming();
    return (
        <>
            {parseReplyText(text).map((seg, i) => {
                if (seg.kind === 'text') return <Fragment key={i}>{seg.text}</Fragment>;
                const shown = referenceText(seg, naming);
                return shown.resolved ? (
                    <a key={i} className="reply-element" onClick={() => onNavigate(seg.target)} {...(shown.path && { 'data-tooltip': shown.path })}>
                        {shown.text}
                    </a>
                ) : (
                    <span key={i} className="reply-element unresolved">
                        {shown.text}
                    </span>
                );
            })}
        </>
    );
}

/** The mark of a request's status: ✓ done, ◐ partly, – not done, ? a question. */
const MARK: Record<RequestProgress, string> = { Done: '✓', Partial: '◐', Skipped: '–', Question: '?' };

/** The first characters of a request's body on one line. */
function head(r: ReplyRequest, max = 48): string {
    const text = oneLine(bodyText(r.request.body, r.request.targets));
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
export function ReplyDetails({
    reply,
    summary = true,
    nameOf,
    onNavigate,
    tx,
}: {
    reply: ReplyView;
    summary?: boolean;
    nameOf: (id: string) => string;
    onNavigate: Navigate;
    tx: Tx;
}) {
    const r = tx.chat.reply;
    return (
        <>
            {summary && (
                <p className="chat-text reply-summary">
                    <ReplyText text={reply.summary} onNavigate={onNavigate} />
                </p>
            )}
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
                                {line.note && (
                                    <span className="reply-note">
                                        <ReplyText text={line.note} onNavigate={onNavigate} />
                                    </span>
                                )}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {reply.assumptions.length > 0 && (
                <ul className="reply-assumptions">
                    {reply.assumptions.map((a, i) => (
                        <li key={i} className="reply-assumption">
                            <span className="reply-line">
                                <span className="reply-text">
                                    <span className="reply-label">{r.assumption}: </span>
                                    <ReplyText text={a.text} onNavigate={onNavigate} />
                                </span>
                                <RequestRefs requests={a.requests} nameOf={nameOf} tx={tx} />
                                {a.alternatives.length > 0 && (
                                    <span className="reply-alternatives">
                                        <span className="reply-label">{r.alternatives}: </span>
                                        {a.alternatives.map((alt, j) => (
                                            <Fragment key={alt.id}>
                                                {j > 0 && ' / '}
                                                <span className="reply-alternative">
                                                    <ReplyText text={alt.label} onNavigate={onNavigate} />
                                                </span>
                                            </Fragment>
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
export function ReplyQuestions({
    reply,
    scope,
    nameOf,
    onNavigate,
    tx,
}: {
    reply: ReplyView;
    scope: string;
    nameOf: (id: string) => string;
    onNavigate: Navigate;
    tx: Tx;
}) {
    const r = tx.chat.reply;
    return (
        <ol className="reply-questions">
            {reply.questions.map((q) => {
                const type = q.multiple ? 'checkbox' : 'radio';
                const name = `${scope}:${q.id}`;
                return (
                    <li key={q.id} className="reply-question">
                        <p className="chat-text run-question">
                            <ReplyText text={q.text} onNavigate={onNavigate} />
                        </p>
                        <RequestRefs requests={q.requests} nameOf={nameOf} tx={tx} />
                        <ul className="reply-options" {...(q.multiple && { 'aria-label': r.multiple })}>
                            {q.options.map((o) => (
                                <li key={o.id}>
                                    <label className="reply-option">
                                        <input type={type} name={name} disabled />
                                        <span>
                                            <span className="reply-option-label">
                                                <ReplyText text={o.label} onNavigate={onNavigate} />
                                            </span>
                                            {o.detail && (
                                                <span className="reply-option-detail">
                                                    <ReplyText text={o.detail} onNavigate={onNavigate} />
                                                </span>
                                            )}
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
