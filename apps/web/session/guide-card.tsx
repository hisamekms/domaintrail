// The guide's card in the chat (the plan's "ガイド (`/guide`)"): under the compass and 「ガイド」, the map of where the
// person is — the steps, each done (✓), here (📍) or to do, ending at the goal (🏁), the steps past it faint, the BC
// rows under the modeling's "each BC in depth" step — then what is known at once (each with where to go), both shown as
// soon as the command starts (the server kept them on the command); then the AI's advice: a spinner while it thinks,
// then a status and one to three steps with their reasons and actions — the command (into the composer), the places
// (shown on the canvas), 「聞くことをメモ」 (a message asking the AI for a hotspot: a participant's is approved by the
// facilitator). With several modeling journeys, a picker (each viewer's choice remembered). The latest card lays the
// person's ✓ marks as they are now over its map, and the facilitator sets them there; a card in history keeps its map
// as it was, with a note.
import { useState, type ReactElement } from 'react';
import {
    Box,
    Check,
    CircleX,
    CornerDownLeft,
    Eye,
    FileText,
    Flag,
    GitBranch,
    LoaderCircle,
    MapPin,
    MessageCircleQuestionMark,
    NotebookPen,
    ShieldCheck,
    TriangleAlert,
    type LucideIcon,
} from 'lucide-react';
import { suggestedCommandId } from '@domaintrail/collaboration';
import { useT } from '../i18n';
import { AI_NAME } from './ai';
import { sessionApi } from './api';
import { Bubble } from './bubble';
import { useChat } from './chat-context';
import { GuideMark } from './guide';
import {
    askBody,
    latestGuide,
    pageGuideMarks,
    viewTargetOfShown,
    withMarks,
    type GuideAdviceJson,
    type GuideFindingJson,
    type GuideMapJson,
    type GuideStepJson,
} from './guide-view';
import { useTargetNaming } from './naming';
import { commandButton } from './next-steps';
import { failure } from './parts';
import { AiAvatar } from './proposal';
import { targetLabel } from './proposal-view';
import { ReplyText } from './reply';
import type { SlashCommandJson } from './slash';
import { latestRevision } from './state';
import { targetKey, type ModelTarget } from './targets';

/** Where each viewer's choice of journey is remembered. */
const JOURNEY_KEY = 'domaintrail.guide.journey';

const remembered = (): string | undefined => {
    try {
        return localStorage.getItem(JOURNEY_KEY) ?? undefined;
    } catch {
        return undefined;
    }
};
const remember = (id: string): void => {
    try {
        localStorage.setItem(JOURNEY_KEY, id);
    } catch {
        // not kept: the first journey next time
    }
};

/** The icon of each kind of finding. */
const FINDING_ICONS: Readonly<Record<string, LucideIcon>> = {
    StormingWithoutBrief: FileText,
    StageWithoutExceptions: GitBranch,
    FlowWithoutExceptions: GitBranch,
    OpenHotspots: MessageCircleQuestionMark,
    LongLabels: TriangleAlert,
    Errors: CircleX,
    Warnings: TriangleAlert,
    ContextWithoutAggregates: Box,
    AggregatesWithoutCommands: Box,
    AggregatesWithoutInvariants: ShieldCheck,
};

export function GuideCard({ command: c, continues }: { readonly command: SlashCommandJson; readonly continues: boolean }): ReactElement {
    const { tx, session } = useChat();
    const t = tx.chat.guide;
    const live = session.status === 'live' && session.state.session.state === 'Open';
    const latest = latestGuide(session.state)?.id === c.id;
    const maps = c.guide?.maps ?? [];
    const [chosen, setChosen] = useState<string | undefined>(remembered);
    const map = maps.find((m) => m.journey === chosen) ?? maps[0];
    const choose = (id: string): void => {
        setChosen(id);
        remember(id);
    };
    return (
        <div className={`chat-row guide-row state-${c.state}`}>
            <Bubble
                avatar={<AiAvatar />}
                who={t.answer}
                badge={<GuideMark label={t.answer} />}
                at={c.startedAt}
                continues={continues}
                className="chat-bubble-ai"
            >
                <section className="guide-card" aria-label={t.answer}>
                    {!latest && <p className="guide-older muted">{t.older}</p>}
                    {maps.length > 1 && (
                        <select className="guide-journeys" aria-label={t.journey} value={map?.journey ?? ''} onChange={(e) => choose(e.target.value)}>
                            {maps.map((m) => (
                                <option key={m.journey ?? ''} value={m.journey ?? ''}>
                                    {m.journeyName ?? m.journey}
                                </option>
                            ))}
                        </select>
                    )}
                    {map && <GuideMapView map={map} live={live && latest} />}
                    {c.guide && c.guide.findings.length > 0 && <AtOnce findings={c.guide.findings} />}
                    <Advice command={c} live={live} />
                </section>
            </Bubble>
        </div>
    );
}

/** A step's dot: ✓ done, 📍 here, 🏁 the goal to reach, else empty. */
function StepDot({ step }: { readonly step: GuideStepJson }): ReactElement {
    const Icon = step.state === 'Done' ? Check : step.state === 'Here' ? MapPin : step.goal ? Flag : undefined;
    return <span className="guide-dot">{Icon && <Icon size={12} aria-hidden />}</span>;
}

/** The goal's name: the event storming's level, or the modeling step it ends at. */
function goalName(map: GuideMapJson, t: ReturnType<typeof useChat>['tx']['chat']['guide']): string | undefined {
    const goal = map.steps.find((s) => s.goal);
    if (!goal) return undefined;
    const step = t.steps[goal.key] ?? goal.key;
    if (map.world === 'Storming') return t.esGoals[goal.key] ?? step;
    const pattern = map.pattern && t.patterns[map.pattern];
    return pattern ? `${step}（${pattern}）` : step;
}

/** The map: the steps on a wrapping line, the goal, the BC rows; the facilitator marks the steps the files cannot tell. */
export function GuideMapView({ map: kept, live }: { readonly map: GuideMapJson; readonly live: boolean }): ReactElement {
    const { tx, session, marking, putCommand } = useChat();
    const t = tx.chat.guide;
    const store = pageGuideMarks(session.state, (target, sign, placed) => marking.set(target, sign, placed));
    // the latest card: the marks as they are now
    const map = live ? withMarks(kept, store.read()) : kept;
    const facilitator = live && session.me.participant.role === 'facilitator';
    const journey = map.journey;
    const toggle = (step: string, on: boolean, context?: string): void => {
        if (journey === undefined) return;
        const key = { journey, step, ...(context !== undefined && { context }) };
        void (on ? store.set(key) : store.clear(key));
    };
    const setGoal = map.steps.length === 1 && map.steps[0]?.key === 'setGoal';
    const goal = goalName(map, t);
    const starts =
        map.world === 'Storming' ? (['es:start'] as const) : map.world === 'Model' ? (['model:start'] as const) : (['es:start', 'model:start'] as const);
    return (
        <div className="guide-map">
            <ol className="guide-path">
                {map.steps.map((s) => {
                    const label = t.steps[s.key] ?? s.key;
                    const state = s.state === 'Done' ? t.done : s.state === 'Here' ? t.here : undefined;
                    return (
                        <li
                            key={s.key}
                            className={`guide-step ${s.state.toLowerCase()}${s.goal ? ' goal' : ''}${s.after ? ' after' : ''}`}
                            {...(s.state === 'Here' && { 'aria-current': 'step' as const })}
                        >
                            <StepDot step={s} />
                            <span className="guide-step-label">{label}</span>
                            {state && <span className="visually-hidden">{state}</span>}
                            {s.markable && facilitator && (
                                <button
                                    type="button"
                                    className={`guide-mark${s.marked ? ' on' : ''}`}
                                    aria-pressed={s.marked}
                                    aria-label={`${label}: ${s.marked ? t.unmark : t.mark}`}
                                    data-tooltip={s.marked ? t.unmark : t.mark}
                                    onClick={() => toggle(s.key, !s.marked)}
                                >
                                    <Check size={10} aria-hidden />
                                </button>
                            )}
                            {s.markable && !facilitator && s.marked && (
                                <span className="guide-mark on" role="img" aria-label={t.marked} data-tooltip={t.marked}>
                                    <Check size={10} aria-hidden />
                                </span>
                            )}
                        </li>
                    );
                })}
                {setGoal && (
                    <li className="guide-step todo after" aria-hidden>
                        <span className="guide-dot" />
                        <span className="guide-step-label">…</span>
                    </li>
                )}
            </ol>
            <p className="guide-goal">
                <Flag size={12} aria-hidden />
                {goal ? t.goal(goal) : t.noGoal}
                {map.journeyName && <span className="guide-journey muted"> · {map.journeyName}</span>}
            </p>
            {setGoal && live && (
                <p className="guide-actions">
                    {starts.map((id) => (
                        <button
                            key={id}
                            type="button"
                            className="chat-small primary guide-command"
                            disabled={commandButton(session.state, id) === 'disabled'}
                            data-tooltip={tx.chat.candidates.putCommand}
                            aria-label={`/${id}: ${tx.chat.candidates.putCommand}`}
                            onClick={() => putCommand(id)}
                        >
                            <CornerDownLeft size={12} aria-hidden />/{id}
                        </button>
                    ))}
                </p>
            )}
            {map.contexts.length > 0 && (
                <table className="guide-rows">
                    <thead>
                        <tr>
                            <th scope="col">{t.steps[map.contextsAt ?? ''] ?? ''}</th>
                            <th scope="col">{t.rows.aggregates}</th>
                            <th scope="col">{t.rows.commands}</th>
                            <th scope="col">{t.rows.invariants}</th>
                            <th scope="col" className="visually-hidden">
                                {t.done}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {map.contexts.map((r) => (
                            <tr key={r.context} className={`guide-row-${r.state.toLowerCase()}`}>
                                <th scope="row">
                                    {r.context}
                                    {r.shared && <span className="muted"> · {t.rows.shared}</span>}
                                </th>
                                <td>{r.aggregates}</td>
                                <td>{r.commands}</td>
                                <td>{r.invariants}</td>
                                <td>
                                    {facilitator && map.contextsAt !== undefined ? (
                                        <button
                                            type="button"
                                            className={`guide-mark${r.state === 'Done' ? ' on' : ''}`}
                                            aria-pressed={r.marked}
                                            aria-label={`${r.context}: ${r.marked ? t.unmark : t.mark}`}
                                            data-tooltip={r.marked ? t.unmark : r.state === 'Done' ? t.done : t.mark}
                                            disabled={r.state === 'Done' && !r.marked}
                                            onClick={() => toggle(map.contextsAt ?? '', !r.marked, r.context)}
                                        >
                                            <Check size={10} aria-hidden />
                                        </button>
                                    ) : (
                                        <StepDot step={{ key: r.context, state: r.state, goal: false, after: false, markable: false, marked: r.marked }} />
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}

/** A finding's line: its icon, what it says, where to go. */
function AtOnce({ findings }: { readonly findings: readonly GuideFindingJson[] }): ReactElement {
    const { tx, onNavigate, openView } = useChat();
    const t = tx.chat.guide;
    return (
        <div className="guide-at-once">
            <p className="guide-at-once-head">{t.atOnce}</p>
            <ul>
                {findings.map((f, i) => {
                    const Icon = FINDING_ICONS[f.kind] ?? TriangleAlert;
                    const say = t.findings[f.kind];
                    const text = say ? say(f.subject ?? '', f.count) : `${f.kind} ${f.count}`;
                    const { view, target } = f;
                    const go = view ? () => openView(viewTargetOfShown(view)) : target ? () => onNavigate(target) : undefined;
                    const label = f.view ? t.showOnCanvas : t.show;
                    return (
                        <li key={i} className="guide-finding">
                            <Icon size={13} aria-hidden className="guide-finding-icon" />
                            <span className="guide-finding-text">{text}</span>
                            {go && (
                                <button type="button" className="chat-small guide-go" aria-label={`${text}: ${label}`} onClick={go}>
                                    <Eye size={12} aria-hidden />
                                    {label}
                                </button>
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

/** The AI's part: thinking, its advice, or stopped. */
function Advice({ command: c, live }: { readonly command: SlashCommandJson; readonly live: boolean }): ReactElement | null {
    const { tx, session } = useChat();
    const t = tx.chat.guide;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const mine = live && (session.me.participant.role === 'facilitator' || c.startedBy === session.me.participant.id);
    if (c.state === 'Working')
        return (
            <p className="guide-thinking muted">
                <LoaderCircle size={12} aria-hidden className="spin" /> {t.thinking}
                {mine && (
                    <button
                        type="button"
                        className="chat-small ghost"
                        disabled={busy}
                        onClick={() => {
                            setBusy(true);
                            sessionApi
                                .stopCommand(c.id)
                                .catch((e: unknown) => setError(failure(e)))
                                .finally(() => setBusy(false));
                        }}
                    >
                        {t.stop}
                    </button>
                )}
                {error && <span className="chat-error"> {error}</span>}
            </p>
        );
    if (c.state === 'Stopped') return <p className="guide-thinking muted">{t.stopped}</p>;
    if (c.state === 'Answered' && c.next) return <GuideAdvice next={c.next} live={live} />;
    return null;
}

/** The advice: the status, then the steps with their reasons and actions. */
export function GuideAdvice({ next, live }: { readonly next: GuideAdviceJson; readonly live: boolean }): ReactElement {
    const { tx, session, onNavigate, putCommand } = useChat();
    const t = tx.chat.guide;
    const all = useT();
    const naming = useTargetNaming();
    const [asked, setAsked] = useState<ReadonlySet<number>>(new Set());
    const [error, setError] = useState<string | undefined>();
    const ask = async (i: number, question: string, at: ModelTarget | undefined): Promise<void> => {
        const revision = latestRevision(session.state);
        if (!revision) return;
        try {
            const name = at && targetLabel(at, naming, all).name;
            await sessionApi.sendRequest(
                askBody({ ask: question, ...(at && name && { at: { target: at, name } }), revision: revision.id, texts: t, aiName: AI_NAME }),
            );
            setAsked((s) => new Set([...s, i]));
            setError(undefined);
        } catch (e) {
            setError(failure(e));
        }
    };
    return (
        <div className="guide-advice">
            <p className="guide-status">
                <ReplyText text={next.status} onNavigate={onNavigate} />
            </p>
            <ol className="guide-steps">
                {next.steps.map((s, i) => {
                    const id = s.command && suggestedCommandId(s.command);
                    const button = id && live ? commandButton(session.state, id) : 'hidden';
                    const places = s.targets ?? [];
                    return (
                        <li key={i} className="guide-advice-step">
                            <span className="guide-step-text">
                                <ReplyText text={s.text} onNavigate={onNavigate} />
                            </span>
                            <span className="guide-step-reason muted">
                                <ReplyText text={s.reason} onNavigate={onNavigate} />
                            </span>
                            {(button !== 'hidden' || places.length > 0 || (s.ask !== undefined && live)) && (
                                <span className="guide-actions">
                                    {id && button !== 'hidden' && (
                                        <button
                                            type="button"
                                            className="chat-small primary guide-command"
                                            disabled={button === 'disabled'}
                                            data-tooltip={tx.chat.candidates.putCommand}
                                            aria-label={`/${id}: ${tx.chat.candidates.putCommand}`}
                                            onClick={() => putCommand(id)}
                                        >
                                            <CornerDownLeft size={12} aria-hidden />/{id}
                                        </button>
                                    )}
                                    {places.map((p) => {
                                        const name = targetLabel(p, naming, all).name;
                                        return (
                                            <button
                                                key={targetKey(p)}
                                                type="button"
                                                className="chat-small guide-go"
                                                aria-label={t.goTo(name)}
                                                onClick={() => onNavigate(p)}
                                            >
                                                <Eye size={12} aria-hidden />
                                                <span className="guide-go-name">{name}</span>
                                            </button>
                                        );
                                    })}
                                    {s.ask !== undefined && live && (
                                        <button
                                            type="button"
                                            className="chat-small guide-ask"
                                            disabled={asked.has(i)}
                                            data-tooltip={t.askHint}
                                            aria-label={`${t.ask}: ${s.ask}`}
                                            onClick={() => void ask(i, s.ask ?? '', places[0])}
                                        >
                                            {asked.has(i) ? <Check size={12} aria-hidden /> : <NotebookPen size={12} aria-hidden />}
                                            {t.ask}
                                        </button>
                                    )}
                                </span>
                            )}
                            {s.ask !== undefined && <span className="guide-question muted">「{s.ask}」</span>}
                        </li>
                    );
                })}
            </ol>
            {error && <p className="chat-error">{error}</p>}
        </div>
    );
}
