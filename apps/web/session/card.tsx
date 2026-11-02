// A card of the chat (ADR 0026, amendment): one change unit as an AI turn, updated in place — queued → running → done,
// a question, declined, failed or cancelled — with the runs that continue it one under the other (the question, the
// facilitator's answer or note, the result). At the top of each run, a quote of each message it applied (with what the
// reply says of each, ✓ ◐ – ?, when there are several); a click goes to the message, a hover marks it. The facilitator
// answers a question by choosing, picks another alternative of an assumption, cancels a run, and through the card's
// menu confirms its result, restores the workspace as it was before it or compares the two.
import { useRef, useState, type ReactNode } from 'react';
import { Bot, Circle, CircleDot, Reply, CircleX, Ellipsis, FileDiff, Pencil, RotateCcw, Square, SquareCheck, X } from 'lucide-react';
import { useDismiss } from '../shared/layout';
import { answerBody, type QuestionChoice } from './actions';
import { OtherDialog } from './answer-other';
import { cardRuns, quoteDisplay, type CardRun, type Quote, type QuoteDisplay } from './cards';
import { useChat, type Tx } from './chat-context';
import { pickedAlternative, questionsState, type Decider, type PickedAlternative, type QuestionsState } from './decisions';
import { changedPaths, cutList, unitName, type ChangeUnit } from './history';
import { isReplyable } from './replies';
import { AddReaction, ReactionRow, VoteMark } from './mark-controls';
import { bodyText } from './mentions';
import { ReplyText } from './reply';
import { elapsed, oneLine, revisionLookup, type AgentMessage, type ReplyView, type RequestProgress } from './stream';

type RunJson = CardRun['run'];

const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
/** The mark of a request's status: ✓ done, ◐ partly, – not done, ? a question. */
export const PROGRESS_MARK: Record<RequestProgress, string> = { Done: '✓', Partial: '◐', Skipped: '–', Question: '?' };

/** The state a card shows: its latest run's. */
function statusOf(m: AgentMessage): 'queued' | 'running' | 'clarification' | 'done' | 'declined' | 'failed' | 'cancelled' {
    return m.kind === 'completed' ? 'done' : m.kind;
}

/** Whether the card's name line shows its state: only where nothing else does (a question says so itself, done is the rule). */
const statusShown = (status: ReturnType<typeof statusOf>): boolean => status !== 'done' && status !== 'clarification';

export function RunCard({ unit, compact = false, actions }: { unit: ChangeUnit; compact?: boolean; actions?: ReactNode }) {
    const chat = useChat();
    const { session, tx, nameOf, control } = chat;
    const runs = cardRuns(unit, revisionLookup(session.state));
    const first = runs[0];
    const last = runs[runs.length - 1];
    const status = statusOf(last.message);
    const cancellable = control && (last.run.state === 'Queued' || last.run.state === 'Running');
    const queuedBy = nameOf(first.run.queuedBy);
    // the chunk's title, once the AI gave one: the quotes under it already say what the messages were
    const title = unitName(unit);
    // an AI turn: the AI's avatar and name, the chunk's title and when it started (who queued it in the tooltip); the
    // state only where nothing else shows it (queued, running with its time, declined, failed, cancelled)
    return (
        <div className={`run-card status-${status}${compact ? ' compact' : ''}`} data-card={unit.key}>
            <span className="session-avatar chat-agent-avatar" aria-hidden>
                <Bot size={13} />
            </span>
            <div className="run-card-main">
                <div className="run-card-head">
                    <span className="chat-who">{tx.chat.agent}</span>
                    <span className="run-card-meta">
                        {/* in 履歴, the heading above already names it */}
                        {title.kind === 'title' && !compact && (
                            <>
                                <span className="run-card-title">{title.text}</span>
                                {' · '}
                            </>
                        )}
                        <time dateTime={first.run.queuedAt} data-tooltip={tx.chat.queued(queuedBy)}>
                            {time(first.run.queuedAt)}
                        </time>
                    </span>
                    {statusShown(status) && (
                        <span className={`run-card-status status-${status}`}>
                            {status === 'running' && <span className="chat-pulse" aria-hidden />}
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
                        {control && !compact && <CardMenu last={last.run} />}
                        {actions}
                        {!compact && <ReplyButton to={{ kind: 'Run', run: last.run }} />}
                        {/* last: ☺+ at the right end of every row, messages and turns alike */}
                        {!compact && <AddReaction target={{ kind: 'Turn', run: last.run.id }} />}
                    </span>
                </div>
                {runs.map((r, i) => (
                    <RunSection key={r.run.id} run={r} display={quoteDisplay(runs, i)} first={i === 0} last={i === runs.length - 1} compact={compact} />
                ))}
            </div>
        </div>
    );
}

/**
 * ↩ just before ☺+: at the right end of an AI turn whose latest run ended (completed, failed, declined, cancelled; not a
 * question, which has its form), and of every message. Anyone starts a reply to it, shown on hover or focus (always,
 * faint, on touch).
 */
export function ReplyButton({ to }: { to: { readonly kind: 'Run'; readonly run: RunJson } | { readonly kind: 'Message'; readonly request: string } }) {
    const { tx, session, replies } = useChat();
    const live = session.status === 'live' && session.state.session.state === 'Open';
    if (!live || (to.kind === 'Run' && !isReplyable(to.run))) return null;
    const r = tx.chat.replies;
    const draft = replies.draft;
    const active = to.kind === 'Run' ? draft?.kind === 'Run' && draft.run === to.run.id : draft?.kind === 'Message' && draft.request === to.request;
    return (
        <button
            type="button"
            className={`icon-button run-card-reply${active ? ' active' : ''}`}
            aria-label={r.reply}
            aria-pressed={active}
            data-tooltip={to.kind === 'Run' ? r.replyHint : r.messageReplyHint}
            onClick={() => (to.kind === 'Run' ? replies.start(to.run.id) : replies.startMessage(to.request))}
        >
            <Reply size={14} aria-hidden />
        </button>
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

function RunSection({ run, display, first, last, compact }: { run: CardRun; display: QuoteDisplay; first: boolean; last: boolean; compact: boolean }) {
    const { tx, nameOf, control, session } = useChat();
    const runs = session.state.runs;
    const live = session.status === 'live' && session.state.session.state === 'Open';
    const reply = run.message.kind === 'clarification' ? run.message.reply : undefined;
    const questions = reply !== undefined && reply.questions.length > 0 ? questionsState(run.run, runs) : undefined;
    // open: the facilitator answers them; whoever is not answering sees them with their votes; once a later run took
    // over the requests, they stay as they were asked, with what was answered (or nothing) and the votes frozen
    const asking = last && control && live && !compact && questions?.kind === 'open';
    const voting = !asking && !compact && questions?.kind === 'open';
    const decided = questions !== undefined && questions.kind !== 'open';
    // the answer this run gave is shown with the questions it answered; one shown nowhere else keeps its line
    const asked = run.answer && runs.find((r) => r.id === run.answer?.answerTo);
    const answerShown = asked !== undefined && answeredBy(asked, runs) === run.run.id;
    const done = run.message.kind === 'completed' ? run.message.reply : undefined;
    const picked = done && done.assumptions.length > 0 ? pickedAlternative(run.run, runs) : undefined;
    return (
        <div className={`run-section${first ? '' : ' chained'}`} data-item={`run:${run.run.id}`}>
            {/* a run that continues the card: its time, quietly (its number, for precision, in the tooltip) */}
            {!first && (
                <div className="run-section-number">
                    <time dateTime={run.run.queuedAt} data-tooltip={`${tx.chat.run(run.number)} · ${tx.chat.queued(nameOf(run.run.queuedBy))}`}>
                        {time(run.run.queuedAt)}
                    </time>
                </div>
            )}
            {run.answer && !answerShown && <AnswerLine run={run} />}
            {run.note && (
                <p className="run-line">
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
                <AgentBody message={run.message} asking={asking || voting || decided} />
                <RunFiles run={run.run} />
                {asking && reply && <AnswerForm run={run.run} reply={reply} />}
                {voting && reply && <QuestionVotes run={run.run} reply={reply} />}
                {decided && reply && questions && <AnsweredQuestions run={run.run} reply={reply} state={questions} />}
                {done && done.assumptions.length > 0 && (
                    <Assumptions
                        run={run.run}
                        reply={done}
                        offer={last && control && live && !compact}
                        votes={!compact || picked !== undefined}
                        picked={picked}
                    />
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

/** The run that answered a run's questions, if one did (its ID). */
function answeredBy(asked: RunJson, runs: readonly RunJson[]): string | undefined {
    if (asked.state !== 'NeedsClarification' || !asked.reply || asked.reply.questions.length === 0) return undefined;
    const state = questionsState(asked, runs);
    return state.kind === 'answered' ? state.by.run : undefined;
}

/**
 * An answer frozen into a run that is not shown with its questions (the run was cancelled before it started, so the
 * questions are open again), on one muted line: what was chosen and written (the questions in the tooltip).
 */
function AnswerLine({ run }: { run: CardRun }) {
    const { tx, nameOf } = useChat();
    const answers = run.answer?.answers ?? [];
    const said = (a: (typeof answers)[number]): string => [...a.chosen.map((o) => o.label), ...(a.freeText ? [a.freeText] : [])].join(' / ');
    return (
        <p className="run-line run-answer" data-tooltip={answers.map((a) => `${a.text} → ${said(a)}`).join('\n')}>
            ↳ {tx.chat.answered} {nameOf(run.run.queuedBy)}: <span className="run-line-text">{answers.map(said).join(tx.chat.listSeparator)}</span>
        </p>
    );
}

/**
 * What the agent says of a run, as the chat said it (the reply's per-request lines are the quotes above); nothing while
 * it waits or runs, which the name line says. A question it asks has the one amber mark: a bar beside it — on its
 * summary, unless the questions themselves are offered below (`asking`).
 */
function AgentBody({ message: m, asking }: { message: AgentMessage; asking: boolean }) {
    const { tx, nameOf, onNavigate } = useChat();
    const says = tx.chat.agentSays;
    switch (m.kind) {
        case 'queued':
        case 'running':
            return null;
        case 'clarification':
            return m.reply ? (
                <p className={`chat-text reply-summary${asking ? '' : ' run-question'}`}>
                    <ReplyText text={m.reply.summary} onNavigate={onNavigate} />
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
                </p>
            ) : (
                <p className="chat-text">{m.changed ? says.completedChanged(m.result) : says.completedUnchanged}</p>
            );
        case 'declined':
            return (
                <p className="chat-text" aria-label={tx.chat.reply.declined}>
                    <ReplyText text={m.reply.summary} onNavigate={onNavigate} />
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
 * The files a run changed, on a small line of their own under what the AI says; nothing when none changed, or while
 * it has no result.
 */
function RunFiles({ run }: { run: RunJson }) {
    const { session, tx } = useChat();
    if (run.state !== 'Completed' && run.state !== 'NeedsClarification' && run.state !== 'Declined') return null;
    const lookup = revisionLookup(session.state);
    const paths = changedPaths(lookup.revision(run.baseRevision), lookup.revision(run.resultRevision));
    // the revisions not known (yet): that it changed files, without which
    if (paths === undefined)
        return run.resultRevision === run.baseRevision ? null : (
            <p className="run-files">
                <FileDiff size={12} className="run-files-icon" aria-hidden />
                {tx.chat.reply.applied(undefined)}
            </p>
        );
    if (paths.size === 0) return null;
    return <ChangedFiles kind="run" paths={[...paths].sort()} base={run.baseRevision} result={run.resultRevision} />;
}

/** A path's last segment (`billing.dt` of `src/billing.dt`). */
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * Changed files, on one small line: a file-diff icon, then the first files (their last segments; all of them in the
 * tooltip) as one link comparing the revisions before and after. Under a run's text (`run`), and under a unit's heading
 * in 履歴 (`unit`).
 */
export function ChangedFiles({ kind, paths, base, result }: { kind: 'run' | 'unit'; paths: readonly string[]; base: string; result: string }) {
    const { tx, revisions } = useChat();
    const h = tx.chat.history;
    const changed = cutList(paths, 3);
    const c = kind === 'run' ? 'run-files' : 'chat-unit-changes';
    const hint = kind === 'run' ? tx.chat.reply.appliedHint : h.changedFilesHint;
    return (
        <p className={c} aria-label={h.changedFiles}>
            <FileDiff size={kind === 'run' ? 12 : 13} className={`${c}-icon`} aria-hidden />
            <button type="button" className={`${c}-link`} onClick={() => revisions.compare(base, result)} data-tooltip={`${hint}: ${paths.join(', ')}`}>
                {changed.shown.map(baseName).join(h.separator)}
            </button>
            {changed.more > 0 && <span className={`${c}-more`}> {h.more(changed.more)}</span>}
        </p>
    );
}

/**
 * The run's questions: for the facilitator, each with its options to choose (one, or several when it says so) and
 * その他 — a row like the options, its own words written in a dialog (✎, or choosing it while it has none) —, then
 * 答えて再実行, which queues the run's requests again with the answer at once. In a single-choice question その他 is one
 * of the group: choosing an option deselects it but keeps its words, which come back when it is chosen again.
 */
function AnswerForm({ run, reply }: { run: RunJson; reply: ReplyView }) {
    const { tx, actions, onNavigate } = useChat();
    const r = tx.chat.reply;
    const [choices, setChoices] = useState<Record<string, QuestionChoice>>({});
    // the question whose その他 is being written; kept as the dialog closes, so that it fades out with its question
    const [writing, setWriting] = useState<{ question: string; open: boolean } | undefined>();
    const answer = answerBody(reply.questions, choices);
    type Question = ReplyView['questions'][number];
    const update = (q: string, f: (c: QuestionChoice) => QuestionChoice): void => setChoices((all) => ({ ...all, [q]: f(all[q] ?? { options: [] }) }));
    const choose = (q: Question, option: string, on: boolean): void =>
        update(q.id, (c) =>
            q.multiple
                ? { ...c, options: on ? [...c.options, option] : c.options.filter((o) => o !== option) }
                : { ...c, options: on ? [option] : [], other: false },
        );
    const write = (q: Question): void => setWriting({ question: q.id, open: true });
    // その他 chosen or not; without words yet, choosing it opens the dialog instead (it is chosen once they are decided)
    const chooseOther = (q: Question, on: boolean): void => {
        if (on && !choices[q.id]?.text) write(q);
        else update(q.id, (c) => (q.multiple || !on ? { ...c, other: on } : { ...c, options: [], other: true }));
    };
    // the words decided in the dialog: その他 chosen with them; none: その他 cleared
    const decide = (q: Question, text: string): void =>
        update(q.id, (c) => (!text ? { options: c.options } : q.multiple ? { ...c, other: true, text } : { options: [], other: true, text }));
    const asked = reply.questions.find((q) => q.id === writing?.question);
    return (
        <>
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
                        const c = choices[q.id];
                        const chosen = c?.options ?? [];
                        const text = c?.text ?? '';
                        const other = c?.other === true && text !== '';
                        return (
                            <li key={q.id} className="reply-question">
                                <p className="chat-text run-question">
                                    <ReplyText text={q.text} onNavigate={onNavigate} />
                                </p>
                                <ul className="reply-options" {...(q.multiple && { 'aria-label': r.multiple })}>
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
                                    {/* その他: 「その他: <the words>」 on one line (all of them on hover), ✎ where the others have ♡ */}
                                    <li className={`vote-row reply-other-row${other ? ' chosen' : ''}${text ? ' written' : ''}`}>
                                        <label className="reply-option reply-other" data-tooltip={text || undefined}>
                                            <input
                                                type={type}
                                                name={name}
                                                checked={other}
                                                aria-haspopup={text ? undefined : 'dialog'}
                                                onChange={(e) => chooseOther(q, e.target.checked)}
                                                onKeyDown={(e) => {
                                                    // Enter writes the words while there are none (Space does it by choosing)
                                                    if (e.key === 'Enter' && !text) {
                                                        e.preventDefault();
                                                        write(q);
                                                    }
                                                }}
                                            />
                                            <span className="reply-other-line">
                                                <span className="reply-option-label">{r.other}</span>
                                                {text && <span className="reply-other-text">: {oneLine(text)}</span>}
                                            </span>
                                        </label>
                                        <button
                                            type="button"
                                            className="icon-button reply-other-write"
                                            aria-haspopup="dialog"
                                            aria-label={text ? r.otherEdit : r.otherWrite}
                                            data-tooltip={text ? r.otherEdit : r.otherWrite}
                                            onClick={() => write(q)}
                                        >
                                            <Pencil size={12} aria-hidden />
                                        </button>
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
            <OtherDialog
                open={writing?.open === true && asked !== undefined}
                question={asked?.text ?? ''}
                text={(asked && choices[asked.id]?.text) ?? ''}
                onDecide={(text) => asked && decide(asked, text)}
                onClose={() => setWriting((w) => w && { ...w, open: false })}
            />
        </>
    );
}

/**
 * The mark at the start of a row of choices, the shape of what the facilitator answers with: a circle for one of a
 * group (a single-choice question's option, an assumption kept or one of its alternatives), a square for a
 * multiple-choice question's option. Outline while nothing was decided (or nothing in the group was chosen), filled for
 * what was chosen; never violet (it is not clickable). The icon is hidden from screen readers, which hear 選択 / 未選択
 * once something was decided.
 */
function ChoiceMark({ multiple = false, state, size = 13 }: { multiple?: boolean; state: 'open' | 'chosen' | 'unchosen'; size?: number }) {
    const { tx } = useChat();
    const chosen = state === 'chosen';
    const Icon = multiple ? (chosen ? SquareCheck : Square) : chosen ? CircleDot : Circle;
    return (
        <span className="choice-mark">
            <Icon size={size} aria-hidden />
            {state !== 'open' && <span className="visually-hidden">{chosen ? tx.chat.choice.chosen : tx.chat.choice.unchosen}</span>}
        </span>
    );
}

/**
 * The assumptions of a reply, each as a group of rows one of which is taken — 「前提: …」 (kept as it is) and each
 * 「別案: …」 — with ○ at their start and the votes at their right; the facilitator picks an alternative (a link) to
 * run the requests again with it. Once picked, the alternative has ◉ and the rest are muted.
 */
function Assumptions({
    run,
    reply,
    offer,
    votes,
    picked,
}: {
    run: RunJson;
    reply: ReplyView;
    offer: boolean;
    votes: boolean;
    /** The alternative the facilitator picked: ◉ on it, the others muted, and who picked it under the assumption. */
    picked: PickedAlternative | undefined;
}) {
    const { tx, actions, onNavigate } = useChat();
    const r = tx.chat.reply;
    return (
        <ul className="reply-assumptions">
            {reply.assumptions.map((a, i) => {
                const decided = picked?.assumption === i;
                const state = (alternative: string | undefined): 'open' | 'chosen' | 'unchosen' =>
                    !decided ? 'open' : picked.alternative === alternative ? 'chosen' : 'unchosen';
                const kept = state(undefined);
                return (
                    <li key={i} className={`reply-assumption${decided ? ' decided' : ''}`}>
                        <ul className="reply-choices">
                            {/* ♡ on the assumption itself: keep it as it is */}
                            <li className={`reply-choice vote-row ${kept}`}>
                                <ChoiceMark state={kept} size={12} />
                                <span className="reply-text">
                                    <span className="reply-label">{r.assumption}: </span>
                                    <ReplyText text={a.text} onNavigate={onNavigate} />
                                </span>
                                {votes && <VoteMark target={{ kind: 'AssumptionChoice', run: run.id, assumption: i }} />}
                            </li>
                            {a.alternatives.map((alt) => {
                                const s = state(alt.id);
                                return (
                                    <li key={alt.id} className={`reply-choice vote-row ${s}`}>
                                        <ChoiceMark state={s} size={12} />
                                        <span className="reply-text">
                                            <span className="reply-label">{r.alternative}: </span>
                                            {offer ? (
                                                <button
                                                    className="reply-alternative pickable"
                                                    disabled={actions.busy}
                                                    data-tooltip={tx.chat.pickAlternative}
                                                    onClick={() => void actions.pick(run, i, alt.id, tx.chat.alternativeNote(a.text, alt.label))}
                                                >
                                                    <ReplyText text={alt.label} onNavigate={onNavigate} />
                                                </button>
                                            ) : (
                                                <span className="reply-alternative">
                                                    <ReplyText text={alt.label} onNavigate={onNavigate} />
                                                </span>
                                            )}
                                        </span>
                                        {votes && <VoteMark target={{ kind: 'AssumptionChoice', run: run.id, assumption: i, alternative: alt.id }} />}
                                    </li>
                                );
                            })}
                        </ul>
                        {decided && <DecidedLine label={tx.chat.picked} by={picked.by} run />}
                    </li>
                );
            })}
        </ul>
    );
}

/**
 * Who decided and when, small and muted under what was decided (`回答 ooyama_F · 23:47`); for a pick, its time is a
 * link to the run it queued (that run continues the same card, so it has no number to show).
 */
function DecidedLine({ label, by, run = false }: { label: string; by: Decider; run?: boolean }) {
    const { tx, nameOf, jump } = useChat();
    return (
        <p className="decided-line">
            {label} {nameOf(by.by)} ·{' '}
            {run ? (
                <button type="button" className="decided-run" onClick={() => jump(`run:${by.run}`)} data-tooltip={tx.chat.goToRun}>
                    <time dateTime={by.at}>{time(by.at)}</time>
                </button>
            ) : (
                <time dateTime={by.at}>{time(by.at)}</time>
            )}
        </p>
    );
}

/**
 * A run's questions once a later run took over their requests, as they were asked — the same options in the same
 * order, without anything to choose —: the filled mark (◉ or ☑) on what was answered (and その他 with the own words as a
 * last row), the other options muted with the outline mark, the votes frozen at the right, and who answered and when
 * after the last question. Left unanswered, nothing filled and no line.
 */
function AnsweredQuestions({ run, reply, state }: { run: RunJson; reply: ReplyView; state: Exclude<QuestionsState, { kind: 'open' }> }) {
    const { tx, onNavigate } = useChat();
    const answers = state.kind === 'answered' ? state.answers : undefined;
    // the own words being read in full; kept as the dialog closes, so that it fades out with them
    const [reading, setReading] = useState<{ question: string; text: string; open: boolean } | undefined>();
    return (
        <div className="decided-questions">
            <ol className="reply-questions">
                {reply.questions.map((q) => {
                    const answer = answers?.get(q.id);
                    return (
                        <li key={q.id} className="reply-question">
                            <p className="chat-text">
                                <ReplyText text={q.text} onNavigate={onNavigate} />
                            </p>
                            <ul className="reply-options" {...(q.multiple && { 'aria-label': tx.chat.reply.multiple })}>
                                {q.options.map((o) => {
                                    const state = !answers ? 'open' : answer?.chosen.includes(o.id) ? 'chosen' : 'unchosen';
                                    return (
                                        <li key={o.id} className={`reply-option vote-row decided-option ${state}`}>
                                            <ChoiceMark multiple={q.multiple} state={state} />
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
                                    );
                                })}
                                {answer?.text !== undefined && (
                                    <li className="reply-option vote-row decided-option chosen">
                                        <ChoiceMark multiple={q.multiple} state="chosen" />
                                        {/* on one line, all of it on hover, or in a dialog on a click */}
                                        <button
                                            type="button"
                                            className="decided-other"
                                            aria-haspopup="dialog"
                                            data-tooltip={answer.text}
                                            onClick={() => setReading({ question: q.text, text: answer.text ?? '', open: true })}
                                        >
                                            {tx.chat.answeredOther}: {oneLine(answer.text)}
                                        </button>
                                    </li>
                                )}
                            </ul>
                        </li>
                    );
                })}
            </ol>
            {state.kind === 'answered' && <DecidedLine label={tx.chat.answered} by={state.by} />}
            {reading && (
                <OtherDialog
                    open={reading.open}
                    question={reading.question}
                    text={reading.text}
                    readOnly
                    onClose={() => setReading((r) => r && { ...r, open: false })}
                />
            )}
        </div>
    );
}

/**
 * A run's questions for whoever is not answering them (the participants, and everyone once the session closed): each
 * with its options as rows with the outline mark of their kind (○ one, ☐ several: filled once answered) and the votes
 * at their right — a participant's ♡ while the run waits for the answer.
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
                                <ChoiceMark multiple={q.multiple} state="open" />
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
