// A card of the chat (ADR 0026, amendment): one change unit as an AI turn, updated in place — queued → running → done,
// a question, declined, failed or cancelled — with the runs that continue it one under the other (the question, the
// facilitator's answer or note, the result). At the top of each run, a quote of each message it applied (with what the
// reply says of each, ✓ ◐ – ?, when there are several); a click goes to the message, a hover marks it. The facilitator
// answers a question by choosing, picks another alternative of an assumption, cancels a run, and through the card's
// menu confirms its result, restores the workspace as it was before it or compares the two.
import { Fragment, useRef, useState, type ReactNode } from 'react';
import { Bot, CircleX, Ellipsis, RotateCcw, X } from 'lucide-react';
import { useDismiss } from '../shared/layout';
import { laterRunOf } from '@domaintrail/collaboration/domain/marks';
import { answerBody, type QuestionChoice } from './actions';
import { cardRuns, quoteDisplay, type CardRun, type Quote, type QuoteDisplay } from './cards';
import { useChat, type Tx } from './chat-context';
import type { ChangeUnit } from './history';
import { AddReaction, ReactionRow, VoteMark } from './mark-controls';
import { assumptionVoteLines, questionVoteLines } from './marks';
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
    const queuedBy = nameOf(first.run.queuedBy);
    // an AI turn: the AI's avatar and name, the runs' numbers and time; the state only when it is not simply done
    return (
        <div className={`run-card status-${status}${compact ? ' compact' : ''}`} data-card={unit.key}>
            <span className="session-avatar chat-agent-avatar" aria-hidden>
                <Bot size={13} />
            </span>
            <div className="run-card-main">
                <div className="run-card-head">
                    <span className="chat-who">{tx.chat.agent}</span>
                    <span className="run-card-meta">
                        <span className="run-card-number">{first.number === last.number ? `#${first.number}` : `#${first.number}–${last.number}`}</span>
                        {' · '}
                        <time dateTime={first.run.queuedAt}>{time(first.run.queuedAt)}</time>
                        {' · '}
                        <span data-tooltip={tx.chat.queued(queuedBy)}>{queuedBy}</span>
                    </span>
                    {status !== 'done' && (
                        <span className={`run-card-status status-${status}`}>
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
                    )}
                    <span className="run-card-tools">
                        {!compact && <AddReaction target={{ kind: 'Turn', run: last.run.id }} />}
                        {control && !compact && <CardMenu last={last.run} />}
                        {actions}
                    </span>
                </div>
                {runs.map((r, i) => (
                    <RunSection
                        key={r.run.id}
                        run={r}
                        previous={runs[i - 1]?.run}
                        display={quoteDisplay(runs, i)}
                        first={i === 0}
                        last={i === runs.length - 1}
                        compact={compact}
                    />
                ))}
            </div>
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

function RunSection({
    run,
    previous,
    display,
    first,
    last,
    compact,
}: {
    run: CardRun;
    /** The run before it in the card: an alternative picked from its assumptions is this run's note. */
    previous: RunJson | undefined;
    display: QuoteDisplay;
    first: boolean;
    last: boolean;
    compact: boolean;
}) {
    const { tx, nameOf, control, session, marking } = useChat();
    const live = session.status === 'live' && session.state.session.state === 'Open';
    const reply = run.message.kind === 'clarification' ? run.message.reply : undefined;
    const asking = last && control && live && !compact && reply !== undefined && reply.questions.length > 0;
    // the questions with their votes, for whoever is not answering them, while no later run took over their requests
    const voting = !asking && !compact && reply !== undefined && reply.questions.length > 0 && (last || !laterRunOf(run.run, session.state.runs));
    // the votes on the assumptions of the run before, kept in the tooltip of the note that picked an alternative
    const noteVotes =
        run.note && previous?.state === 'Completed' && previous.reply
            ? previous.reply.assumptions.flatMap((a, i) => {
                  const lines = assumptionVoteLines(marking.index, previous.id, i, a.alternatives, tx.chat.votes.keep, nameOf, tx.chat.listSeparator);
                  return lines.length > 0 ? [`${tx.chat.reply.assumption}: ${a.text}`, ...lines] : [];
              })
            : [];
    return (
        <div className={`run-section${first ? '' : ' chained'}`}>
            {/* a run that continues the card: its number and time, quietly */}
            {!first && (
                <div className="run-section-number">
                    #{run.number} · <time dateTime={run.run.queuedAt}>{time(run.run.queuedAt)}</time>
                </div>
            )}
            {run.answer && <AnswerLine run={run} />}
            {run.note && (
                <p className="run-line" {...(noteVotes.length > 0 && { 'data-tooltip': noteVotes.join('\n') })}>
                    ↳ {tx.chat.note} {nameOf(run.run.queuedBy)}: <span className="run-line-text">{run.note}</span>
                </p>
            )}
            {display.quotes && (
                <ul className="run-quotes">
                    {run.quotes.map((q) => (
                        <QuoteLine key={q.request.request} quote={q} detailed={display.perRequest} />
                    ))}
                </ul>
            )}
            <div className="run-agent-body">
                <AgentBody message={run.message} asking={asking || voting} />
                {asking && reply && <AnswerForm run={run.run} reply={reply} />}
                {voting && reply && <QuestionVotes run={run.run} reply={reply} />}
                {run.message.kind === 'completed' && run.message.reply && run.message.reply.assumptions.length > 0 && (
                    <Assumptions run={run.run} reply={run.message.reply} offer={last && control && live && !compact} votes={!compact} />
                )}
                {!compact && <ReactionRow target={{ kind: 'Turn', run: run.run.id }} />}
            </div>
        </div>
    );
}

/**
 * A message the run applied, on one muted line (`↳ name: the head of its body`); with several messages, what the
 * reply says of each too (its mark and note). A click goes to the message, a hover marks it.
 */
function QuoteLine({ quote, detailed }: { quote: Quote; detailed: boolean }) {
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
                <span className="run-quote-who">↳ {nameOf(r.author)}:</span>
                <span className="run-quote-head">{head}</span>
            </button>
            {detailed && quote.progress && (
                <span className="reply-mark" role="img" aria-label={tx.chat.reply.status[quote.progress]} data-tooltip={tx.chat.reply.status[quote.progress]}>
                    {PROGRESS_MARK[quote.progress]}
                </span>
            )}
            {detailed && quote.note && (
                <span className="run-quote-note">
                    <ReplyText text={quote.note} onNavigate={onNavigate} />
                </span>
            )}
        </li>
    );
}

/** The facilitator's answer frozen into a run, on one muted line: what was chosen and written (the questions in the tooltip). */
function AnswerLine({ run }: { run: CardRun }) {
    const { tx, nameOf, session, marking } = useChat();
    const answers = run.answer?.answers ?? [];
    const said = (a: (typeof answers)[number]): string => [...a.chosen.map((o) => o.label), ...(a.freeText ? [a.freeText] : [])].join(' / ');
    // the participants' votes on the options, frozen when the answer was given
    const asked = session.state.runs.find((r) => r.id === run.answer?.answerTo);
    const questions = asked?.state === 'NeedsClarification' ? (asked.reply?.questions ?? []) : [];
    const votes = (question: string): string[] => {
        const q = questions.find((x) => x.id === question);
        return q && asked ? questionVoteLines(marking.index, asked.id, q, nameOf, tx.chat.listSeparator).map((l) => `  ${l}`) : [];
    };
    return (
        <p className="run-line run-answer" data-tooltip={answers.flatMap((a) => [`${a.text} → ${said(a)}`, ...votes(a.question)]).join('\n')}>
            ↳ {tx.chat.answered} {nameOf(run.run.queuedBy)}: <span className="run-line-text">{answers.map(said).join(tx.chat.listSeparator)}</span>
        </p>
    );
}

/**
 * What the agent says of a run, as the chat said it, then the files it changed, small; nothing when none changed (the
 * reply's per-request lines are the quotes above). A question it asks has the one amber mark: a bar beside it — on its
 * summary, unless the questions themselves are offered below (`asking`).
 */
function AgentBody({ message: m, asking }: { message: AgentMessage; asking: boolean }) {
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
                <p className={`chat-text reply-summary${asking ? '' : ' run-question'}`}>
                    <ReplyText text={m.reply.summary} onNavigate={onNavigate} />
                    <ReplyFacts files={m.files} changed={m.files !== undefined && m.files > 0} tx={tx} />
                </p>
            ) : (
                <p className="chat-text run-question" aria-label={says.clarification}>
                    {m.question}
                </p>
            );
        case 'completed':
            return m.reply ? (
                <p className="chat-text reply-summary">
                    <ReplyText text={m.reply.summary} onNavigate={onNavigate} />
                    <ReplyFacts files={m.files} changed={m.changed} tx={tx} />
                </p>
            ) : (
                <p className="chat-text">{m.changed ? says.completedChanged(m.result) : says.completedUnchanged}</p>
            );
        case 'declined':
            return (
                <p className="chat-text" aria-label={tx.chat.reply.declined}>
                    <ReplyText text={m.reply.summary} onNavigate={onNavigate} />
                    <ReplyFacts files={m.files} changed={m.files !== undefined && m.files > 0} tx={tx} />
                </p>
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
                            <p className="chat-text run-question">
                                <ReplyText text={q.text} onNavigate={onNavigate} />
                            </p>
                            <ul className="reply-options" {...(q.multiple && { 'aria-label': tx.chat.reply.multiple })}>
                                {q.options.map((o) => (
                                    <li key={o.id} className="vote-row">
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
                                        <VoteMark target={{ kind: 'QuestionOption', run: run.id, question: q.id, option: o.id }} />
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

/**
 * The assumptions of a reply as text — 「前提: …」 and 「別案: A / B」 —; the facilitator picks an alternative (a link) to
 * run the requests again with it.
 */
function Assumptions({ run, reply, offer, votes }: { run: RunJson; reply: ReplyView; offer: boolean; votes: boolean }) {
    const { tx, actions, onNavigate } = useChat();
    const r = tx.chat.reply;
    return (
        <ul className="reply-assumptions">
            {reply.assumptions.map((a, i) => (
                <li key={i} className="reply-assumption">
                    <span className="reply-assumption-line">
                        <span className="reply-text">
                            <span className="reply-label">{r.assumption}: </span>
                            <ReplyText text={a.text} onNavigate={onNavigate} />
                        </span>
                        {/* ♡ on the assumption itself: keep it as it is */}
                        {votes && <VoteMark target={{ kind: 'AssumptionChoice', run: run.id, assumption: i }} />}
                    </span>
                    {a.alternatives.length > 0 && (
                        <span className="reply-alternatives">
                            <span className="reply-label">{r.alternatives}: </span>
                            {a.alternatives.map((alt, j) => (
                                <Fragment key={alt.id}>
                                    {j > 0 && ' / '}
                                    {offer ? (
                                        <button
                                            className="reply-alternative pickable"
                                            disabled={actions.busy}
                                            data-tooltip={tx.chat.pickAlternative}
                                            onClick={() => void actions.requeue(run, tx.chat.alternativeNote(a.text, alt.label))}
                                        >
                                            <ReplyText text={alt.label} onNavigate={onNavigate} />
                                        </button>
                                    ) : (
                                        <span className="reply-alternative">
                                            <ReplyText text={alt.label} onNavigate={onNavigate} />
                                        </span>
                                    )}
                                    {votes && <VoteMark target={{ kind: 'AssumptionChoice', run: run.id, assumption: i, alternative: alt.id }} />}
                                </Fragment>
                            ))}
                        </span>
                    )}
                </li>
            ))}
        </ul>
    );
}

/**
 * A run's questions for whoever is not answering them (the participants, and everyone once the session closed): each
 * with its options as plain rows and the votes at their right — a participant's ♡ while the run waits for the answer.
 * Choosing is the facilitator's (the answer form); "other" is not offered here (participants write in the chat).
 */
function QuestionVotes({ run, reply }: { run: RunJson; reply: ReplyView }) {
    const { tx, onNavigate } = useChat();
    return (
        <ol className="reply-questions">
            {reply.questions.map((q) => (
                <li key={q.id} className="reply-question">
                    <p className="chat-text run-question">
                        <ReplyText text={q.text} onNavigate={onNavigate} />
                    </p>
                    <ul className="reply-options" {...(q.multiple && { 'aria-label': tx.chat.reply.multiple })}>
                        {q.options.map((o) => (
                            <li key={o.id} className="reply-option vote-row">
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
                                <VoteMark target={{ kind: 'QuestionOption', run: run.id, question: q.id, option: o.id }} />
                            </li>
                        ))}
                    </ul>
                    {q.multiple && <p className="reply-option-detail vote-hint">{tx.chat.reply.multiple}</p>}
                </li>
            ))}
        </ol>
    );
}

export type { Tx };
