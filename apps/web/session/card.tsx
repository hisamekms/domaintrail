// A card of the chat (ADR 0026, amendment): one change unit as an AI turn, updated in place — queued → running → done,
// a question, declined, failed or cancelled — with the runs that continue it one under the other (the question, the
// facilitator's answer or note, the result). Its state sits in the chat's status slot, at its header's right end; its actions float over its top right. At the top of each run (not in Solo), a quote of each message it applied (with what the
// reply says of each, ✓ 対応 ◐ 一部 – 未対応 ? 確認); a click goes to the message, a hover marks it. The AI's question
// and what it assumed sit on surfaces of their own, their options and alternatives as cards with ♡ at the right. The
// facilitator answers a question by choosing, approves an assumption or sends the requests again with an alternative,
// cancels a run (asked first), and through the card's menu reverts what it changed (asked first) or shows what it
// changed. A revert is a card like any other, the AI's turn whether the server reverted it mechanically or the AI did:
// queued (behind how many), done, nothing left to revert, stopped or failed. What a run changed is a line of model
// elements under its text (`ChangedElements`), shared with AI の作業.
import { useRef, useState, type ReactNode } from 'react';
import { Bot, Check, Circle, CircleDot, Reply, CircleX, Ellipsis, Eye, FileDiff, Hourglass, Pencil, Square, SquareCheck } from 'lucide-react';
import { revertableChanges, revertStatus } from '@domaintrail/collaboration';
import type { ElementChange } from '@domaintrail/collaboration/protocol';
import { useDismiss } from '../shared/layout';
import { MarkdownText } from '../shared/markdown-text';
import { useClipped } from '../view/toolbar';
import { answerBody, type QuestionChoice } from './actions';
import { Clamped } from './bubble';
import { ActivityLine } from './activity';
import { OtherDialog } from './answer-other';
import { cardMenuItems, cardRuns, obstacleText, queueAhead, quoteDisplay, type CardRun, type Quote, type QuoteDisplay } from './cards';
import { changeFullName, changeKey, changeShortName, changeTarget, useModelChanges } from './changes';
import { useChat, type Tx } from './chat-context';
import { assumptionDecision, questionsState, type QuestionsState } from './decisions';
import { changedPaths, cutList, requestersOf, unitName, type ChangeUnit } from './history';
import { isReplyable } from './replies';
import { AddReaction, ReactionRow, VoteMark } from './mark-controls';
import { bodyText } from './mentions';
import { useTargetNaming } from './naming';
import { ReplyText } from './reply';
import { runningLabel, turnState } from './status';
import { CancelButton, RowActions, StateLabel, StatusSlot } from './status-slot';
import { elapsed, oneLine, revisionLookup, type AgentMessage, type ReplyView, type RequestProgress } from './stream';
import { Act } from '../shared/act';
import { useT } from '../i18n';
import { hasMarks, stormingChangeMarks } from '../view/change-marks';

type RunJson = CardRun['run'];

const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
/** The mark of a request's status: ✓ done, ◐ partly, – not done, ? a question, ↩ answered as a question. */
export const PROGRESS_MARK: Record<RequestProgress, string> = { Done: '✓', Partial: '◐', Skipped: '–', Question: '?', Answered: '↩' };

export function RunCard({ unit, compact = false, actions }: { unit: ChangeUnit; compact?: boolean; actions?: ReactNode }) {
    const chat = useChat();
    const { session, tx, nameOf, control } = chat;
    const runs = cardRuns(unit, revisionLookup(session.state));
    const first = runs[0];
    const last = runs[runs.length - 1];
    const state = turnState(last.message);
    const cancellable = control && (last.run.state === 'Queued' || last.run.state === 'Running');
    const queuedBy = nameOf(first.run.queuedBy);
    // the chunk's title, once the AI gave one: the quotes under it already say what the messages were
    const title = unitName(unit);
    const about = useUnitAbout(unit);
    // queued: how many runs it waits behind; a revert left to the AI says why in the state's tooltip
    const ahead = queueAhead(last.run.id, session.state.runs);
    const obstacle = last.message.kind === 'queued' ? last.message.revertObstacle : undefined;
    // an AI turn: the AI's avatar and name, the chunk's title and when it started (who queued it in the tooltip); at the
    // right end, in the status slot, the state only where nothing else shows it (queued, running with its time, declined,
    // failed, cancelled), then the facilitator's ✕ on a run not finished
    const status = state && (
        <span className={`chat-state state-${state}`} {...(obstacle && { 'data-tooltip': obstacleText(obstacle, tx.chat.revertObstacle) })}>
            <StateLabel
                state={state}
                label={last.message.kind === 'running' ? runningLabel(tx.chat.marks, elapsed(last.message.since, chat.now)) : tx.chat.marks[state]}
            />
        </span>
    );
    return (
        <div className={`run-card status-${last.message.kind}${compact ? ' compact' : ''}`} data-card={unit.key}>
            <span className="session-avatar chat-agent-avatar" aria-hidden>
                <Bot size={13} />
            </span>
            <div className="run-card-main">
                <div className="run-card-head">
                    <span className="chat-who">{tx.chat.agent}</span>
                    <span className="run-card-meta">
                        {/* in AI の作業, the row above already names it */}
                        {title.kind === 'title' && !compact && (
                            <>
                                <RunCardTitle text={title.text} />
                                {' · '}
                            </>
                        )}
                        <time dateTime={first.run.queuedAt} data-tooltip={tx.chat.queued(queuedBy)}>
                            {time(first.run.queuedAt)}
                        </time>
                    </span>
                    {/* in AI の作業, the row above has the ✕ and the card only its link to the chat */}
                    {(status || (cancellable && !compact) || (compact && actions)) && (
                        <span className="run-card-tools">
                            {ahead !== undefined && ahead > 0 && <span className="run-card-ahead">{tx.chat.ahead(ahead)}</span>}
                            <StatusSlot>{status}</StatusSlot>
                            {compact ? actions : cancellable && <CancelButton unit={unit} />}
                        </span>
                    )}
                </div>
                {!compact && (
                    <RowActions>
                        {control && <CardMenu last={last.run} about={about} name={title.text} />}
                        <ReplyButton to={{ kind: 'Run', run: last.run }} />
                        {/* last: ☺+ at the right end of every row, messages and turns alike; alone in Solo, no one else reacts */}
                        {!chat.solo && <AddReaction target={{ kind: 'Turn', run: last.run.id }} />}
                    </RowActions>
                )}
                {runs.map((r, i) => (
                    <RunSection
                        key={r.run.id}
                        run={r}
                        display={quoteDisplay(runs, i, chat.solo)}
                        first={i === 0}
                        last={i === runs.length - 1}
                        compact={compact}
                        about={about}
                        name={title.text}
                    />
                ))}
            </div>
        </div>
    );
}

/** The chunk's title beside the AI's name: cut with … when the row is too narrow, then whole in its tooltip. */
function RunCardTitle({ text }: { text: string }): ReactNode {
    const ref = useRef<HTMLSpanElement>(null);
    const clipped = useClipped(ref, text);
    return (
        <span ref={ref} className="run-card-title" {...(clipped && { 'data-tooltip': text })}>
            {text}
        </span>
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

/**
 * A unit as the changes' dialog names it, small under its title: its name, whose messages and when
 * (`返品の受付期限 · 田中 の依頼 · 15:09`).
 */
export function useUnitAbout(unit: ChangeUnit): string {
    const { tx, nameOf } = useChat();
    const h = tx.chat.history;
    const asked = requestersOf(unit.requesters.map(nameOf));
    const who =
        asked.kind === 'names' ? h.requesters(asked.names.join(h.separator)) : asked.kind === 'more' ? h.requestersMore(asked.first, asked.others) : undefined;
    return [unitName(unit).text, who, time(unit.start)].filter((x) => x !== undefined && x !== '').join(' · ');
}

/**
 * The card's menu (the facilitator's), worded by the unit of work: its changes reverted (asked first; only while it has
 * changes not reverted yet, nor being reverted), its changes shown. Only for a unit whose latest run changed files. The
 * revisions behind each are in the tooltips. Restoring an earlier state of the whole workspace is the collab menu's.
 */
function CardMenu({ last, about, name }: { last: RunJson; about: string; name: string }) {
    const { tx, revisions, session } = useChat();
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    useDismiss(open, root, () => setOpen(false));
    const live = session.status === 'live' && session.state.session.state === 'Open';
    const items = cardMenuItems(last, session.state.runs, live);
    const changes = revertableChanges(last);
    if (!changes || items.length === 0) return null;
    const revertable = items.includes('revert');
    const { base, result } = changes;
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
                    {revertable && (
                        <>
                            <button role="menuitem" data-item="revert" onClick={pick(() => revisions.revert({ run: last.id, name }))}>
                                {tx.chat.revertWork}
                            </button>
                            <div className="pane-menu-separator" role="separator" />
                        </>
                    )}
                    <button
                        role="menuitem"
                        data-item="changes"
                        onClick={pick(() => revisions.showChanges({ base, result, about }))}
                        data-tooltip={tx.chat.revisionsHint(revisions.number(base), revisions.number(result))}
                    >
                        {tx.chat.showChanges}
                    </button>
                </div>
            )}
        </div>
    );
}

function RunSection({
    run,
    display,
    first,
    last,
    compact,
    about,
    name,
}: {
    run: CardRun;
    display: QuoteDisplay;
    first: boolean;
    last: boolean;
    compact: boolean;
    about: string;
    /** The card's name, as the canvas's bar names the changes 図で見る shows. */
    name: string;
}) {
    const { tx, nameOf, control, session, jump } = useChat();
    const runs = session.state.runs;
    const live = session.status === 'live' && session.state.session.state === 'Open';
    const reply = run.message.kind === 'clarification' ? run.message.reply : undefined;
    const questions = reply !== undefined && reply.questions.length > 0 ? questionsState(run.run, runs) : undefined;
    // open: the facilitator answers them; whoever is not answering sees them with their votes; once a later run took
    // over the requests, they stay as they were asked, with what was answered (or nothing) and the votes frozen. The
    // compact card of AI の作業 asks them as the chat does: a waiting unit is answered from there too
    const asking = last && control && live && questions?.kind === 'open';
    const voting = !asking && questions?.kind === 'open';
    const decided = questions !== undefined && questions.kind !== 'open';
    // the answer this run gave is shown with the questions it answered; one shown nowhere else keeps its line
    const asked = run.answer && runs.find((r) => r.id === run.answer?.answerTo);
    const answerShown = asked !== undefined && answeredBy(asked, runs) === run.run.id;
    const done = run.message.kind === 'completed' ? run.message.reply : undefined;
    // its changes reverted since: by which revert, who asked and when (the time a link to that revert's card)
    const revert = revertStatus(run.run, runs);
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
            {/* the option of each approved proposal the facilitator chose (ADR 0030): what the run was asked to do */}
            {(run.run.input.proposals?.approved ?? []).map(
                (a) =>
                    a.instruction.label !== undefined && (
                        <p key={a.proposal} className="run-line">
                            ↳ {tx.chat.proposal.chosen}: <span className="run-line-text">{a.instruction.label}</span>
                        </p>
                    ),
            )}
            {/* the candidates of a `/` command its starter applied: a link back to the command's card */}
            {run.run.input.candidates && (
                <p className="run-line">
                    ↳{' '}
                    <button
                        type="button"
                        className="decided-run"
                        onClick={() => jump(`command:${run.run.input.candidates?.command}`)}
                        data-tooltip={tx.chat.candidates.toCard}
                    >
                        {tx.chat.candidates.chosen}
                    </button>
                    : <span className="run-line-text">{run.run.input.candidates.chosen.map((c) => c.label).join(' · ')}</span>
                </p>
            )}
            {display.quotes && (
                <ul className="run-quotes">
                    {run.quotes.map((q) => (
                        <QuoteLine key={q.request.request} quote={q} detailed={display.perRequest} />
                    ))}
                </ul>
            )}
            {/* what the running run is doing now (in AI の作業, the unit's row above shows it) */}
            {!compact && run.message.kind === 'running' && <ActivityLine run={run.run.id} />}
            <div className="run-agent-body">
                <AgentBody run={run.run.id} message={run.message} />
                {/* in AI の作業, the unit's own line above already lists what it changed */}
                {!compact && <RunFiles run={run.run} about={about} name={name} />}
                {revert.kind === 'reverted' && (
                    <DecidedLine label={tx.chat.reverted} by={revert.by.queuedBy} at={revert.by.queuedAt} run={revert.by.id} hint={tx.chat.revertedHint} />
                )}
                {(asking || voting || decided) && reply && questions && (
                    <ReplySection kind="ask">
                        {asking && <AnswerForm run={run.run} reply={reply} />}
                        {voting && <QuestionVotes run={run.run} reply={reply} />}
                        {decided && <AnsweredQuestions run={run.run} reply={reply} state={questions} />}
                    </ReplySection>
                )}
                {done && done.assumptions.length > 0 && (
                    <Assumptions run={run.run} reply={done} offer={last && control && live && !compact} compact={compact} />
                )}
                {!compact && <ReactionRow target={{ kind: 'Turn', run: run.run.id }} />}
            </div>
        </div>
    );
}

/**
 * A message the run applied, on one muted line (`↳ name: the head of its body`), then what the reply says of it once
 * there is a reply (`✓ 対応`, in its color: a message shows no state of its own; not for a message the run asks about,
 * whose question is right below); with several messages, the reply's note on each too. A click goes to the message.
 */
function QuoteLine({ quote, detailed }: { quote: Quote; detailed: boolean }) {
    const { tx, nameOf, jump, onNavigate } = useChat();
    const r = quote.request;
    const head = oneLine(bodyText(r.body, r.targets));
    return (
        <li className={`run-quote${quote.progress ? ` status-${quote.progress}` : ''}`}>
            {/* the quote, cut with an ellipsis, then what the run did of it, never cut */}
            <span className="run-quote-line">
                <button className="run-quote-main" onClick={() => jump(`message:${r.request}`)} data-tooltip={tx.chat.quoteHint}>
                    <span className="run-quote-who">↳ {nameOf(r.author)}:</span>
                    <span className="run-quote-head">{head}</span>
                </button>
                {quote.progress && quote.progress !== 'Question' && (
                    <span className="run-quote-outcome">
                        <span aria-hidden>{PROGRESS_MARK[quote.progress]}</span>
                        {tx.chat.reply.status[quote.progress]}
                    </span>
                )}
            </span>
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
 * What the AI wrote of a run (its summary, its answer, a question asked without the structured form) as the chat shows
 * an answer of the AI (ADR 0030): Markdown with element links, its blocks in a `<div>` (never a `<p>`: a list or a
 * table cannot sit in one).
 */
function AiText({ text, className, label }: { text: string; className?: string; label?: string }) {
    const { onNavigate } = useChat();
    return (
        <div className={`chat-text markdown${className ? ` ${className}` : ''}`} {...(label && { 'aria-label': label })}>
            <MarkdownText text={text} renderText={(t) => <ReplyText text={t} onNavigate={onNavigate} />} />
        </div>
    );
}

/**
 * What the agent says of a run, as the chat said it; the files it changed are a line of their own below
 * (`RunFiles`). A question asked without the structured form is shown on the question's surface. What the AI wrote is
 * Markdown (`AiText`); an answer instead of an edit is clamped as the AI's answers are (`Clamped`: when it was there at
 * the page's load).
 */
export function AgentBody({ run, message: m }: { run: string; message: AgentMessage }) {
    const { tx, nameOf, onNavigate } = useChat();
    const says = tx.chat.agentSays;
    switch (m.kind) {
        case 'queued':
        case 'running':
            return null;
        case 'clarification':
            return m.reply ? (
                <AiText text={m.reply.summary} className="reply-summary" />
            ) : (
                <ReplySection kind="ask">
                    <AiText text={m.question} className="reply-question-text" />
                </ReplySection>
            );
        case 'completed':
            // a run that answered a question instead of editing (ADR 0030): its answer is what it says; its summary too
            // when it changed files after all, which is flagged
            if (m.reply?.answer !== undefined) {
                const changed = (m.files ?? (m.changed ? 1 : 0)) > 0;
                return (
                    <>
                        {changed && <AiText text={m.reply.summary} className="reply-summary" />}
                        <Clamped tx={tx} revealKey={`run:${run}`} className="reply-answer" blocks>
                            <MarkdownText text={m.reply.answer} renderText={(t) => <ReplyText text={t} onNavigate={onNavigate} />} />
                        </Clamped>
                        {changed && <p className="chat-text reply-answered-changed">{tx.chat.ai.answeredChanged}</p>}
                    </>
                );
            }
            return m.reply ? (
                <AiText text={m.reply.summary} className="reply-summary" />
            ) : (
                <p className="chat-text">{m.changed ? says.completedChanged : says.completedUnchanged}</p>
            );
        case 'declined':
            return <AiText text={m.reply.summary} label={tx.chat.reply.declined} />;
        case 'failed':
            return (
                <div className="chat-with-icon session-error">
                    <CircleX size={14} className="chat-icon" aria-label={says.failedLabel} />
                    <p className="chat-text">{tx.failureReasons[m.reason]}</p>
                </div>
            );
        case 'cancelled':
            return <p className="chat-text muted">{says.cancelled(nameOf(m.by))}</p>;
        case 'reverted':
            // reverted mechanically: what it changed says it, below; else that nothing was left
            return m.changed ? null : <p className="chat-text">{says.revertedNothing}</p>;
    }
}

/**
 * What a run changed, on a small line of their own under what the AI says (`ChangedElements`); nothing when it changed no
 * file, or while it has no result.
 */
function RunFiles({ run, about, name }: { run: RunJson; about: string; name: string }) {
    const { session, tx } = useChat();
    if (run.state !== 'Completed' && run.state !== 'NeedsClarification' && run.state !== 'Declined' && run.state !== 'Reverted') return null;
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
    return <ChangedElements kind="run" base={run.baseRevision} result={run.resultRevision} about={about} name={name} />;
}

/** The mark of a change: ＋ added, ✎ changed (as text, never the emoji), − removed. */
const CHANGE_MARK: Record<ElementChange['change'], string> = { added: '＋', changed: '✎\uFE0E', removed: '−' };

/**
 * An element a unit changed as a chip: its kind of change (＋ ✎ −, in green, amber, red on a faint wash) and `#` its own
 * name, its whole name in the tooltip, as the target chips name them. A click goes to it (`onPick` first: the dialog
 * closes); a removed one is muted, struck through and goes nowhere.
 */
export function ChangeChip({ change, onPick }: { change: ElementChange; onPick?: () => void }) {
    const { tx, onNavigate } = useChat();
    const naming = useTargetNaming();
    const mark = (
        <span className="change-mark" role="img" aria-label={tx.chat.history.changeMarks[change.change]}>
            {CHANGE_MARK[change.change]}
        </span>
    );
    const name = <span className="change-name">#{changeShortName(change, naming)}</span>;
    const className = `change-chip change-${change.change}`;
    const tooltip = changeFullName(change, naming);
    if (change.change === 'removed')
        return (
            <span className={className} data-tooltip={tooltip}>
                {mark}
                {name}
            </span>
        );
    return (
        <button
            type="button"
            className={className}
            data-tooltip={tooltip}
            onClick={() => {
                onPick?.();
                onNavigate(changeTarget(change));
            }}
        >
            {mark}
            {name}
        </button>
    );
}

/**
 * What a unit changed, on one small line: the first three elements as chips (`ChangeChip`), 「ほか n」 for the rest, then
 * 図で見る while it changed stickies (their marks on the storming canvas, `session/turn-marks.tsx`; `name` is what the
 * canvas's bar calls them) and 変更を見る, opening the changes' dialog. Under a run's text (`run`), and under a unit's
 * heading in AI の作業 (`unit`). Until the server answered, and when no element changed (a comment, the layout) or the
 * model could not be compared, 変更を見る alone.
 */
export function ChangedElements({ kind, base, result, about, name }: { kind: 'run' | 'unit'; base: string; result: string; about: string; name: string }) {
    const { tx, revisions, onSeeChanges } = useChat();
    const t = useT().turnMarks;
    const naming = useTargetNaming();
    const h = tx.chat.history;
    const changes = useModelChanges(base, result);
    const listed = changes.kind === 'loaded' ? changes.body.changes : [];
    const shown = cutList(listed, 3);
    const marks = onSeeChanges !== undefined && hasMarks(stormingChangeMarks(listed, naming?.mode ?? 'name'));
    return (
        <p className={`changed-elements ${kind}`} aria-label={h.changedElements}>
            {shown.shown.map((c) => (
                <ChangeChip key={changeKey(c)} change={c} />
            ))}
            {shown.more > 0 && <span className="changed-elements-more">{h.more(shown.more)}</span>}
            {marks && (
                <Act
                    kind="see"
                    className="changed-elements-on-canvas"
                    icon={<Eye size={12} aria-hidden />}
                    data-tooltip={t.seeHint}
                    onClick={() => onSeeChanges({ base, result, name })}
                >
                    {t.see}
                </Act>
            )}
            <Act kind="open" className="changed-elements-see" aria-haspopup="dialog" onClick={() => revisions.showChanges({ base, result, about })}>
                {tx.chat.showChanges}
            </Act>
        </p>
    );
}

/**
 * A section of an AI reply on a faint surface, headed small and strong in its colour: the AI's question (amber) or what
 * it assumed without asking (violet). The question's surface is the one mark that the AI is waiting.
 */
function ReplySection({ kind, children }: { kind: 'ask' | 'assumed'; children: ReactNode }) {
    const { tx } = useChat();
    const label = kind === 'ask' ? tx.chat.reply.asks : tx.chat.reply.assumed;
    return (
        <section className={`reply-section ${kind}`} aria-label={label}>
            <p className="reply-section-label" aria-hidden>
                {label}
            </p>
            {children}
        </section>
    );
}

/**
 * The run's questions for the facilitator: each option a card to choose (one, or several when it says so) — the whole
 * card is the click target, the one chosen in the accent colour — and a last その他 card whose own words are written
 * in a dialog (✎, or choosing it while it has none); then 回答を送る, which queues the run's requests again with the
 * answer at once. In a single-choice question その他 is one of the group: choosing an option deselects it but keeps its
 * words, which come back when it is chosen again.
 */
function AnswerForm({ run, reply }: { run: RunJson; reply: ReplyView }) {
    const { tx, actions, answers, onNavigate } = useChat();
    const r = tx.chat.reply;
    // shared with the other form of the run (the chat's, AI の作業's): both show the one answer being chosen
    const choices = answers.of(run.id);
    // the question whose その他 is being written; kept as the dialog closes, so that it fades out with its question
    const [writing, setWriting] = useState<{ question: string; open: boolean } | undefined>();
    const answer = answerBody(reply.questions, choices);
    type Question = ReplyView['questions'][number];
    const update = (q: string, f: (c: QuestionChoice) => QuestionChoice): void =>
        answers.update(run.id, (all) => ({ ...all, [q]: f(all[q] ?? { options: [] }) }));
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
                                <p className="reply-question-text">
                                    <ReplyText text={q.text} onNavigate={onNavigate} />
                                </p>
                                <ul className="reply-cards" {...(q.multiple && { 'aria-label': r.multiple })}>
                                    {q.options.map((o) => (
                                        <li key={o.id} className={`reply-card pickable${chosen.includes(o.id) ? ' chosen' : ''}`}>
                                            <label className="reply-card-main">
                                                <input
                                                    type={type}
                                                    name={name}
                                                    checked={chosen.includes(o.id)}
                                                    onChange={(e) => choose(q, o.id, e.target.checked)}
                                                />
                                                <OptionText label={o.label} detail={o.detail} />
                                            </label>
                                            <VoteMark target={{ kind: 'QuestionOption', run: run.id, question: q.id, option: o.id }} />
                                        </li>
                                    ))}
                                    {/* その他: 「その他: <the words>」 on one line (all of them on hover), ✎ where the others have ♡ */}
                                    <li className={`reply-card pickable reply-other-row${other ? ' chosen' : ''}${text ? ' written' : ''}`}>
                                        <label className="reply-card-main reply-other" data-tooltip={text || undefined}>
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
                <div className="reply-actions">
                    <Act
                        kind="send"
                        type="submit"
                        icon={<Bot size={12} aria-hidden />}
                        disabled={!answer || actions.busy}
                        data-tooltip={answer ? undefined : tx.chat.answerNeeded}
                    >
                        {tx.chat.answerAndRerun}
                    </Act>
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

/** An option's label and, under it, its detail, muted. */
function OptionText({ label, detail }: { label: string; detail?: string }) {
    const { onNavigate } = useChat();
    return (
        <span className="reply-card-text">
            <span className="reply-option-label">
                <ReplyText text={label} onNavigate={onNavigate} />
            </span>
            {detail && (
                <span className="reply-option-detail">
                    <ReplyText text={detail} onNavigate={onNavigate} />
                </span>
            )}
        </span>
    );
}

/**
 * The mark at the start of a card or row once something was decided, the shape of what the facilitator decided with: a
 * circle for one of a group (a single-choice question's option, an assumption or one of its alternatives), a square for
 * a multiple-choice question's option. Filled and in the accent colour for what was chosen, an outline and muted for
 * the rest; not clickable. The icon is hidden from screen readers, which hear 選択 / 未選択.
 */
function ChoiceMark({ multiple = false, state, size = 14 }: { multiple?: boolean; state: 'chosen' | 'unchosen'; size?: number }) {
    const { tx } = useChat();
    const chosen = state === 'chosen';
    const Icon = multiple ? (chosen ? SquareCheck : Square) : chosen ? CircleDot : Circle;
    return (
        <span className="choice-mark">
            <Icon size={size} aria-hidden />
            <span className="visually-hidden">{chosen ? tx.chat.choice.chosen : tx.chat.choice.unchosen}</span>
        </span>
    );
}

/**
 * What the AI assumed without asking, on its surface: each assumption as the AI's text over the whole width, its ♡ on a
 * row under it, then, under 別の案, each alternative as a card. The facilitator decides each assumption once (while its
 * run is the latest of its requests): ✓ 承認 under it keeps it as it is (recorded, nothing sent), 送り直す in an
 * alternative's card sends the requests to the AI again with that alternative. Decided: ◉ on what was chosen (at the
 * start of an assumption's text), the rest muted, and who decided and when under it. Participants see the same cards
 * with their ♡, without buttons.
 */
function Assumptions({ run, reply, offer, compact }: { run: RunJson; reply: ReplyView; offer: boolean; compact: boolean }) {
    const { tx, actions, onNavigate, session } = useChat();
    const r = tx.chat.reply;
    return (
        <ReplySection kind="assumed">
            {reply.assumptions.map((a, i) => {
                const decision = assumptionDecision(run, i, session.state.runs, session.state.approvals);
                // the facilitator's buttons while the assumption is not decided; the votes, in AI の作業, only once frozen
                const deciding = offer && decision.kind === 'open';
                const votes = !compact || decision.kind !== 'open';
                const approved = decision.kind === 'approved';
                const picked = decision.kind === 'picked' ? decision.alternative : undefined;
                // closed as reverted: muted, nothing chosen, who reverted the run under it
                const reverted = decision.kind === 'reverted';
                const keptVote = votes && <VoteMark target={{ kind: 'AssumptionChoice', run: run.id, assumption: i }} />;
                // not decided yet: 承認待ち at the start of its row (a human decision, apart from the run's state), for
                // those who cannot decide it; the facilitator sees the 承認 button there instead
                const awaiting = decision.kind === 'open' && !deciding && (
                    <span className="reply-awaiting">
                        <Hourglass size={12} aria-hidden />
                        {r.awaitingApproval}
                    </span>
                );
                const chosen = approved ? 'chosen' : picked !== undefined ? 'unchosen' : undefined;
                // the text takes the whole width, ◉ / ○ at its start once decided; ♡ on a row of its own under it
                const text = (
                    <p className={`reply-assumption-text${chosen ? ` ${chosen}` : ''}${reverted ? ' reverted' : ''}`}>
                        {chosen && <ChoiceMark state={chosen} />}
                        <ReplyText text={a.text} onNavigate={onNavigate} />
                    </p>
                );
                return (
                    <div key={i} className="reply-assumption">
                        {deciding ? (
                            <>
                                {text}
                                <div className="reply-row-actions">
                                    <span className="reply-row-start">
                                        <Act
                                            kind="decide"
                                            icon={<Check size={12} aria-hidden />}
                                            disabled={actions.busy}
                                            onClick={() => void actions.approve(run, i)}
                                        >
                                            {tx.chat.approve}
                                        </Act>
                                    </span>
                                    {keptVote}
                                </div>
                            </>
                        ) : (
                            <>
                                {text}
                                {awaiting ? (
                                    <div className="reply-row-actions">
                                        {awaiting}
                                        {keptVote}
                                    </div>
                                ) : (
                                    keptVote && <div className="reply-row-actions end">{keptVote}</div>
                                )}
                            </>
                        )}
                        {a.alternatives.length > 0 && (
                            <>
                                <p className="reply-sublabel">{r.otherOptions}</p>
                                <ul className="reply-cards">
                                    {a.alternatives.map((alt) => {
                                        const state =
                                            approved || reverted ? 'unchosen' : picked === undefined ? undefined : picked === alt.id ? 'chosen' : 'unchosen';
                                        const vote = votes && (
                                            <VoteMark target={{ kind: 'AssumptionChoice', run: run.id, assumption: i, alternative: alt.id }} />
                                        );
                                        const label = (
                                            <span className="reply-card-text">
                                                <ReplyText text={alt.label} onNavigate={onNavigate} />
                                            </span>
                                        );
                                        return deciding ? (
                                            <li key={alt.id} className="reply-card stack">
                                                {label}
                                                <div className="reply-row-actions">
                                                    <Act
                                                        kind="send"
                                                        icon={<Bot size={12} aria-hidden />}
                                                        disabled={actions.busy}
                                                        data-tooltip={tx.chat.pickAlternative}
                                                        onClick={() => void actions.pick(run, i, alt.id, tx.chat.alternativeNote(a.text, alt.label))}
                                                    >
                                                        {tx.chat.resend}
                                                    </Act>
                                                    {vote}
                                                </div>
                                            </li>
                                        ) : (
                                            <li key={alt.id} className={`reply-card${state ? ` ${state}` : ''}`}>
                                                {state && <ChoiceMark state={state} />}
                                                {label}
                                                {vote}
                                            </li>
                                        );
                                    })}
                                </ul>
                            </>
                        )}
                        {decision.kind === 'approved' && <DecidedLine label={tx.chat.approved} by={decision.by} at={decision.at} />}
                        {decision.kind === 'picked' && <DecidedLine label={tx.chat.picked} by={decision.by.by} at={decision.by.at} run={decision.by.run} />}
                        {decision.kind === 'reverted' && (
                            <DecidedLine label={tx.chat.reverted} by={decision.by.by} at={decision.by.at} run={decision.by.run} hint={tx.chat.revertedHint} />
                        )}
                    </div>
                );
            })}
        </ReplySection>
    );
}

/**
 * Who decided and when, small and muted under what was decided (`回答 ooyama_F · 23:47`); when the decision queued a
 * run (a pick), its time is a link to that run (it continues the same card, so it has no number to show).
 */
export function DecidedLine({ label, by, at, run, hint }: { label: string; by: string; at: string; run?: string; hint?: string }) {
    const { tx, nameOf, jump } = useChat();
    return (
        <p className="decided-line">
            {label} {nameOf(by)} ·{' '}
            {run !== undefined ? (
                <button type="button" className="decided-run" onClick={() => jump(`run:${run}`)} data-tooltip={hint ?? tx.chat.goToRun}>
                    <time dateTime={at}>{time(at)}</time>
                </button>
            ) : (
                <time dateTime={at}>{time(at)}</time>
            )}
        </p>
    );
}

/**
 * A run's questions once a later run took over their requests, as they were asked — the same cards in the same order,
 * without anything to choose —: the filled mark (◉ or ☑) and the accent on what was answered (and その他 with the own
 * words as a last card), the other options muted with the outline mark, the votes frozen at the right, and who answered
 * and when after the last question. Left unanswered, no mark and no line.
 */
function AnsweredQuestions({ run, reply, state }: { run: RunJson; reply: ReplyView; state: Exclude<QuestionsState, { kind: 'open' }> }) {
    const { tx, onNavigate } = useChat();
    const answers = state.kind === 'answered' ? state.answers : undefined;
    // the own words being read in full; kept as the dialog closes, so that it fades out with them
    const [reading, setReading] = useState<{ question: string; text: string; open: boolean } | undefined>();
    return (
        <>
            <ol className="reply-questions">
                {reply.questions.map((q) => {
                    const answer = answers?.get(q.id);
                    return (
                        <li key={q.id} className="reply-question">
                            <p className="reply-question-text">
                                <ReplyText text={q.text} onNavigate={onNavigate} />
                            </p>
                            <ul className="reply-cards" {...(q.multiple && { 'aria-label': tx.chat.reply.multiple })}>
                                {q.options.map((o) => {
                                    const mark = !answers ? undefined : answer?.chosen.includes(o.id) ? 'chosen' : 'unchosen';
                                    return (
                                        <li key={o.id} className={`reply-card${mark ? ` ${mark}` : ''}`}>
                                            {mark && <ChoiceMark multiple={q.multiple} state={mark} />}
                                            <OptionText label={o.label} detail={o.detail} />
                                            <VoteMark target={{ kind: 'QuestionOption', run: run.id, question: q.id, option: o.id }} />
                                        </li>
                                    );
                                })}
                                {answer?.text !== undefined && (
                                    <li className="reply-card chosen">
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
            {state.kind === 'answered' && <DecidedLine label={tx.chat.answered} by={state.by.by} at={state.by.at} />}
            {reading && (
                <OtherDialog
                    open={reading.open}
                    question={reading.question}
                    text={reading.text}
                    readOnly
                    onClose={() => setReading((r) => r && { ...r, open: false })}
                />
            )}
        </>
    );
}

/**
 * A run's questions for whoever is not answering them (the participants, and everyone once the session closed): each
 * option a card with the votes at its right — a participant's ♡ while the run waits for the answer. Choosing is the
 * facilitator's (the answer form); その他 is not offered here (participants write in the chat).
 */
function QuestionVotes({ run, reply }: { run: RunJson; reply: ReplyView }) {
    const { tx, onNavigate } = useChat();
    return (
        <ol className="reply-questions">
            {reply.questions.map((q) => (
                <li key={q.id} className="reply-question">
                    <p className="reply-question-text">
                        <ReplyText text={q.text} onNavigate={onNavigate} />
                    </p>
                    <ul className="reply-cards" {...(q.multiple && { 'aria-label': tx.chat.reply.multiple })}>
                        {q.options.map((o) => (
                            <li key={o.id} className="reply-card">
                                <OptionText label={o.label} detail={o.detail} />
                                <VoteMark target={{ kind: 'QuestionOption', run: run.id, question: q.id, option: o.id }} />
                            </li>
                        ))}
                    </ul>
                </li>
            ))}
        </ol>
    );
}

export type { Tx };
