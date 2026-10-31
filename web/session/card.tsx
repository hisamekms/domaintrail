// A card of the chat (ADR 0026, amendment): one change unit, updated in place — queued → running → done, a question,
// declined, failed or cancelled — with the runs that continue it one under the other (the question, the facilitator's
// answer or note, the result). At the top of each run, a quote of each message it applied with what the reply says of
// it (✓ ◐ – ?); a click goes to the message, a hover marks it. The facilitator answers a question by choosing, picks
// another alternative of an assumption, cancels a run, and through the card's menu confirms its result, restores the
// workspace as it was before it or compares the two.
import { useRef, useState, type ReactNode } from 'react';
import { Ban, Bot, CircleHelp, CircleX, Ellipsis, Lightbulb, Play, Quote as QuoteIcon, Reply, RotateCcw, X } from 'lucide-react';
import { useDismiss } from '../shared/layout';
import { answerBody, type QuestionChoice } from './actions';
import { cardRuns, type CardRun, type Quote } from './cards';
import { useChat, type Tx } from './chat-context';
import type { ChangeUnit } from './history';
import { bodyText } from './mentions';
import { ReplyFacts, ReplyText } from './reply';
import { elapsed, oneLine, revisionLookup, type AgentMessage, type ReplyView, type RequestProgress } from './stream';

type RunJson = CardRun['run'];

const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
/** The mark of a request's status: ✓ done, ◐ partly, – not done, ? a question. */
export const PROGRESS_MARK: Record<RequestProgress, string> = { Done: '✓', Partial: '◐', Skipped: '–', Question: '?' };

/** The state a card shows: its latest run's. */
function statusOf(m: AgentMessage): 'queued' | 'running' | 'clarification' | 'done' | 'declined' | 'failed' | 'cancelled' {
    return m.kind === 'completed' ? 'done' : m.kind;
}

export function RunCard({ unit, compact = false, actions }: { unit: ChangeUnit; compact?: boolean; actions?: ReactNode }) {
    const chat = useChat();
    const { session, tx, nameOf, control } = chat;
    const runs = cardRuns(unit, revisionLookup(session.state));
    const first = runs[0];
    const last = runs[runs.length - 1];
    const status = statusOf(last.message);
    const cancellable = control && (last.run.state === 'Queued' || last.run.state === 'Running');
    return (
        <div className={`run-card status-${status}${compact ? ' compact' : ''}`} data-card={unit.key}>
            <div className="run-card-head">
                <Play size={10} className="chat-run-play" aria-hidden />
                <span className="run-card-number">{first.number === last.number ? `#${first.number}` : `#${first.number}–${last.number}`}</span>
                <span className="muted">· {nameOf(first.run.queuedBy)}</span>
                <time className="chat-time" dateTime={first.run.queuedAt}>
                    {time(first.run.queuedAt)}
                </time>
                <span className={`chat-status status-${status === 'done' ? 'idle' : status}`}>
                    {status === 'running' && last.message.kind === 'running'
                        ? tx.chat.status.running(elapsed(last.message.since, chat.now))
                        : tx.chat.marks[status]}
                    {cancellable && (
                        <button
                            className="run-card-cancel"
                            onClick={() => void chat.actions.cancel(last.run.id)}
                            aria-label={tx.chat.cancelRun}
                            data-tooltip={tx.chat.cancelRun}
                        >
                            <X size={11} aria-hidden />
                        </button>
                    )}
                </span>
                {control && !compact && <CardMenu last={last.run} />}
                {actions}
            </div>
            {runs.map((r, i) => (
                <RunSection key={r.run.id} run={r} first={i === 0} last={i === runs.length - 1} compact={compact} />
            ))}
        </div>
    );
}

/** The card's menu (the facilitator's): the result confirmed, the workspace restored as before the run, the two compared. */
function CardMenu({ last }: { last: RunJson }) {
    const { tx, revisions } = useChat();
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    useDismiss(open, root, () => setOpen(false));
    const ended = last.state === 'Completed' || last.state === 'NeedsClarification' || last.state === 'Declined';
    if (!ended) return null;
    const base = last.baseRevision;
    const result = last.resultRevision;
    const pick = (f: () => void) => (): void => {
        f();
        setOpen(false);
    };
    return (
        <div className="pane-menu run-card-menu" ref={root}>
            <button
                className="icon-button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={tx.chat.cardMenu}
                data-tooltip={tx.chat.cardMenu}
                onClick={() => setOpen(!open)}
            >
                <Ellipsis size={15} aria-hidden />
            </button>
            {open && (
                <div className="pane-menu-list" role="menu">
                    {result !== base && (
                        <button role="menuitem" onClick={pick(() => revisions.confirm(result))}>
                            {tx.chat.confirmResult(revisions.number(result))}
                        </button>
                    )}
                    <button role="menuitem" onClick={pick(() => revisions.restore(base))}>
                        {tx.chat.restoreBefore(revisions.number(base))}
                    </button>
                    {result !== base && (
                        <button role="menuitem" onClick={pick(() => revisions.compare(base, result))}>
                            {tx.chat.compareRun(revisions.number(base), revisions.number(result))}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

function RunSection({ run, first, last, compact }: { run: CardRun; first: boolean; last: boolean; compact: boolean }) {
    const { tx, nameOf, control, session } = useChat();
    const live = session.status === 'live' && session.state.session.state === 'Open';
    return (
        <div className="run-section">
            {!first && (
                <div className="run-section-divider">
                    <Play size={9} className="chat-run-play" aria-hidden /> #{run.number}
                </div>
            )}
            {run.answer && <AnswerLine run={run} />}
            {run.note && (
                <div className="run-note">
                    <Reply size={13} aria-label={tx.chat.note} />
                    <span className="chat-text">{run.note}</span>
                    <span className="muted small">{nameOf(run.run.queuedBy)}</span>
                </div>
            )}
            <ul className="run-quotes">
                {run.quotes.map((q) => (
                    <QuoteLine key={q.request.request} quote={q} />
                ))}
            </ul>
            <div className="run-agent">
                <span className="session-avatar chat-agent-avatar" aria-hidden>
                    <Bot size={13} />
                </span>
                <div className="run-agent-body">
                    <AgentBody message={run.message} />
                    {last &&
                        control &&
                        live &&
                        !compact &&
                        run.message.kind === 'clarification' &&
                        run.message.reply &&
                        run.message.reply.questions.length > 0 && <AnswerForm run={run.run} reply={run.message.reply} />}
                    {run.message.kind === 'completed' && run.message.reply && run.message.reply.assumptions.length > 0 && (
                        <Assumptions run={run.run} reply={run.message.reply} offer={last && control && live && !compact} />
                    )}
                </div>
            </div>
        </div>
    );
}

/** A message the run applied: its author and the head of its body, with what the reply says of it. */
function QuoteLine({ quote }: { quote: Quote }) {
    const { tx, nameOf, hovered, hover, jump, onNavigate } = useChat();
    const r = quote.request;
    const head = oneLine(bodyText(r.body, r.targets.length));
    return (
        <li
            className={`run-quote${hovered === r.request ? ' paired' : ''}${quote.progress ? ` status-${quote.progress}` : ''}`}
            onMouseEnter={() => hover(r.request)}
            onMouseLeave={() => hover(undefined)}
        >
            <button className="run-quote-main" onClick={() => jump(`message:${r.request}`)} data-tooltip={tx.chat.quoteHint}>
                <QuoteIcon size={11} className="run-quote-icon" aria-hidden />
                <span className="run-quote-who">{nameOf(r.author)}</span>
                <span className="run-quote-head">{head}</span>
            </button>
            {quote.progress && (
                <span className="reply-mark" role="img" aria-label={tx.chat.reply.status[quote.progress]} data-tooltip={tx.chat.reply.status[quote.progress]}>
                    {PROGRESS_MARK[quote.progress]}
                </span>
            )}
            {quote.note && (
                <span className="run-quote-note">
                    <ReplyText text={quote.note} onNavigate={onNavigate} />
                </span>
            )}
        </li>
    );
}

/** The facilitator's answer frozen into a run: each question with what was chosen and written. */
function AnswerLine({ run }: { run: CardRun }) {
    const { tx, nameOf } = useChat();
    const answers = run.answer?.answers ?? [];
    return (
        <div className="run-note run-answer">
            <Reply size={13} aria-label={tx.chat.answered} />
            <span className="chat-text">
                {answers.map((a, i) => (
                    <span key={i} className="run-answer-line">
                        <span className="muted">{a.text}</span> → {[...a.chosen.map((o) => o.label), ...(a.freeText ? [a.freeText] : [])].join(' / ')}
                    </span>
                ))}
            </span>
            <span className="muted small">{nameOf(run.run.queuedBy)}</span>
        </div>
    );
}

/** What the agent says of a run, as the chat said it (the reply's per-request lines are the quotes above). */
function AgentBody({ message: m }: { message: AgentMessage }) {
    const { tx, nameOf, onNavigate, now } = useChat();
    const says = tx.chat.agentSays;
    switch (m.kind) {
        case 'queued':
            return <p className="chat-text muted">{says.queued}</p>;
        case 'running':
            return (
                <p className="chat-text">
                    <span className="chat-pulse" aria-hidden />
                    {says.running(elapsed(m.since, now))}
                </p>
            );
        case 'clarification':
            return m.reply ? (
                <>
                    {m.files !== undefined && m.files > 0 && <p className="reply-facts">{tx.chat.reply.applied(m.files)}</p>}
                    <p className="chat-text reply-summary">
                        <ReplyText text={m.reply.summary} onNavigate={onNavigate} />
                    </p>
                </>
            ) : (
                <div className="chat-with-icon">
                    <CircleHelp size={16} className="chat-icon" aria-label={says.clarification} />
                    <p className="chat-question">{m.question}</p>
                </div>
            );
        case 'completed':
            return m.reply ? (
                <>
                    <ReplyFacts files={m.files} changed={m.changed} tx={tx} />
                    <p className="chat-text reply-summary">
                        <ReplyText text={m.reply.summary} onNavigate={onNavigate} />
                    </p>
                </>
            ) : (
                <p className="chat-text">{m.changed ? says.completedChanged(m.result) : says.completedUnchanged}</p>
            );
        case 'declined':
            return (
                <>
                    {m.files !== undefined && m.files > 0 && <p className="reply-facts">{tx.chat.reply.applied(m.files)}</p>}
                    <div className="chat-with-icon">
                        <Ban size={14} className="chat-icon" aria-label={tx.chat.reply.declined} />
                        <p className="chat-text">
                            <ReplyText text={m.reply.summary} onNavigate={onNavigate} />
                        </p>
                    </div>
                </>
            );
        case 'failed':
            return (
                <div className="chat-with-icon session-error">
                    <CircleX size={14} className="chat-icon" aria-label={says.failedLabel} />
                    <p className="chat-text">{tx.failureReasons[m.reason]}</p>
                </div>
            );
        case 'cancelled':
            return <p className="chat-text muted">{says.cancelled(nameOf(m.by))}</p>;
    }
}

/**
 * The run's questions: for the facilitator, each with its options to choose (one, or several when it says so) and
 * "other" in own words, then 答えて再実行, which queues the run's requests again with the answer at once.
 */
function AnswerForm({ run, reply }: { run: RunJson; reply: ReplyView }) {
    const { tx, actions, onNavigate } = useChat();
    const [choices, setChoices] = useState<Record<string, QuestionChoice>>({});
    const answer = answerBody(reply.questions, choices);
    const choose = (q: ReplyView['questions'][number], option: string, on: boolean): void => {
        const c = choices[q.id] ?? { options: [] };
        const options = q.multiple ? (on ? [...c.options, option] : c.options.filter((o) => o !== option)) : on ? [option] : [];
        setChoices({ ...choices, [q.id]: { ...c, options } });
    };
    const write = (q: string, text: string): void => setChoices({ ...choices, [q]: { ...(choices[q] ?? { options: [] }), text } });
    return (
        <form
            className="run-answer-form"
            onSubmit={(e) => {
                e.preventDefault();
                if (answer) void actions.answer(run, answer);
            }}
        >
            <ol className="reply-questions">
                {reply.questions.map((q) => {
                    const type = q.multiple ? 'checkbox' : 'radio';
                    const name = `answer:${run.id}:${q.id}`;
                    const chosen = choices[q.id]?.options ?? [];
                    return (
                        <li key={q.id} className="reply-question">
                            <div className="chat-with-icon">
                                <CircleHelp size={16} className="chat-icon" aria-hidden />
                                <p className="chat-question">
                                    <ReplyText text={q.text} onNavigate={onNavigate} />
                                </p>
                            </div>
                            <ul className="reply-options" {...(q.multiple && { 'aria-label': tx.chat.reply.multiple })}>
                                {q.options.map((o) => (
                                    <li key={o.id}>
                                        <label className="reply-option">
                                            <input
                                                type={type}
                                                name={name}
                                                checked={chosen.includes(o.id)}
                                                onChange={(e) => choose(q, o.id, e.target.checked)}
                                            />
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
                                        <span className="reply-option-label">{tx.chat.reply.other}</span>
                                        <input
                                            className="session-text run-answer-text"
                                            value={choices[q.id]?.text ?? ''}
                                            maxLength={2000}
                                            onChange={(e) => write(q.id, e.target.value)}
                                            aria-label={tx.chat.reply.other}
                                        />
                                    </label>
                                </li>
                            </ul>
                        </li>
                    );
                })}
            </ol>
            <div className="run-answer-actions">
                <button
                    type="submit"
                    className="chat-small primary"
                    disabled={!answer || actions.busy}
                    data-tooltip={answer ? undefined : tx.chat.answerNeeded}
                >
                    <RotateCcw size={12} aria-hidden /> {tx.chat.answerAndRerun}
                </button>
            </div>
        </form>
    );
}

/** The assumptions of a reply with their alternatives; the facilitator picks one to run the requests again with it. */
function Assumptions({ run, reply, offer }: { run: RunJson; reply: ReplyView; offer: boolean }) {
    const { tx, actions, onNavigate } = useChat();
    return (
        <ul className="reply-assumptions">
            {reply.assumptions.map((a, i) => (
                <li key={i} className="reply-assumption">
                    <Lightbulb size={13} className="reply-icon" aria-label={tx.chat.reply.assumption} />
                    <span className="reply-line">
                        <span className="reply-text">
                            <ReplyText text={a.text} onNavigate={onNavigate} />
                        </span>
                        {a.alternatives.length > 0 && (
                            <span className="reply-alternatives" aria-label={tx.chat.reply.alternatives}>
                                {a.alternatives.map((alt) =>
                                    offer ? (
                                        <button
                                            key={alt.id}
                                            className="reply-alternative pickable"
                                            disabled={actions.busy}
                                            data-tooltip={tx.chat.pickAlternative}
                                            onClick={() => void actions.requeue(run, tx.chat.alternativeNote(a.text, alt.label))}
                                        >
                                            <RotateCcw size={10} aria-hidden /> <ReplyText text={alt.label} onNavigate={onNavigate} />
                                        </button>
                                    ) : (
                                        <span key={alt.id} className="reply-alternative">
                                            <ReplyText text={alt.label} onNavigate={onNavigate} />
                                        </span>
                                    ),
                                )}
                            </span>
                        )}
                    </span>
                </li>
            ))}
        </ul>
    );
}

export type { Tx };
