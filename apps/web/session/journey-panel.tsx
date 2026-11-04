// The current journey in the app bar, and the journeys panel (the plan's "The current journey, and how journeys
// begin", option A of the preview): a chip after the world switch — 🧭 the journey · 📍 the step here → 🏁 the goal,
// narrowed to 🧭 and the journey, then 🧭 alone, by the app bar's container queries; 「ゴールを決める」 when there is
// none, which offers `/es:start` and `/model:start`. Pressed, the panel: the current journey's brief, its map and its
// actions (ガイドを見る, ゴールを変える, ブリーフを見直す, 完了にする, しまう); the other journeys with where they stand
// (choosing one makes it current); the new journeys; the archived ones, counted and opened on demand. Everyone reads
// it; a participant's choose, goal, done or archive is a request the facilitator approves here.
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, Check, ChevronDown, ChevronRight, CircleCheck, Compass, Flag, MapPin, Plus, TriangleAlert, X } from 'lucide-react';
import type { JourneyAct } from '@domaintrail/collaboration';
import type { JourneyRequestBody } from '@domaintrail/collaboration/protocol';
import { Act } from '../shared/act';
import { useChat } from './chat-context';
import { GuideMapView } from './guide-card';
import { goalChoices, type JourneyItem } from './journey-view';
import { commandButton } from './next-steps';

/** A step's or a goal's name: an ES level, a step of the map. */
export function useStepName(): (key: string | undefined, kind?: 'es' | 'model') => string {
    const { tx } = useChat();
    const t = tx.chat.guide;
    return (key, kind) => {
        if (key === undefined) return '';
        if (kind === 'es' || key === 'BigPicture' || key === 'DesignLevel') return t.levels[key] ?? t.esGoals[key] ?? t.steps[key] ?? key;
        return t.steps[key] ?? key;
    };
}

/** The chip in the app bar (put in `slot`), with the panel it opens under it. */
export function JourneyChip({ slot }: { readonly slot: HTMLElement | null }): ReactElement | null {
    const { journeys } = useChat();
    const wrap = useRef<HTMLDivElement>(null);
    const open = journeys.open;
    const setOpen = useCallback((v: boolean): void => journeys.setOpen(v), [journeys]);
    useEffect(() => {
        if (!open) return;
        const away = (e: PointerEvent): void => {
            if (wrap.current && e.target instanceof Node && !wrap.current.contains(e.target)) setOpen(false);
        };
        const esc = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', away);
        document.addEventListener('keydown', esc);
        return () => {
            document.removeEventListener('pointerdown', away);
            document.removeEventListener('keydown', esc);
        };
    }, [open, setOpen]);
    if (!slot) return null;
    return createPortal(
        <div className="journey-chip-wrap session-chat" ref={wrap}>
            <JourneyChipButton />
            {open && <JourneysPanel onClose={() => setOpen(false)} />}
        </div>,
        slot,
    );
}

/** The chip itself: the current journey, where it is, its goal; 「ゴールを決める」 without one; the requests waiting (the facilitator's). */
export function JourneyChipButton(): ReactElement {
    const { tx, journeys, session } = useChat();
    const t = tx.chat.journeys;
    const name = useStepName();
    const open = journeys.open;
    const current = journeys.overview.current;
    const waiting = session.me.participant.role === 'facilitator' ? journeys.body.requests.length : 0;
    const goalName = current && name(current.goal, current.summary.kind);
    const label = current ? t.chipLabel(current.summary.name, current.reached ? t.reached : name(current.here), goalName ?? '') : t.setGoal;
    return (
        <button
            type="button"
            className={`journey-chip${current ? '' : ' journey-chip-empty'}${current?.missing ? ' journey-chip-missing' : ''}`}
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label={label}
            data-tooltip={label}
            onClick={() => journeys.setOpen(!open)}
        >
            <Compass size={14} aria-hidden className="journey-chip-compass" />
            {current ? (
                <>
                    <span className="journey-chip-name">{current.summary.name}</span>
                    <span className="journey-chip-where">
                        <span className="journey-chip-sep" aria-hidden>
                            ·
                        </span>
                        {current.reached ? (
                            <span className="journey-chip-here">
                                <CircleCheck size={12} aria-hidden />
                                {t.reached}
                            </span>
                        ) : (
                            <span className="journey-chip-here">
                                <MapPin size={12} aria-hidden />
                                {name(current.here)}
                            </span>
                        )}
                        <span className="journey-chip-sep" aria-hidden>
                            →
                        </span>
                        <span className="journey-chip-goal">
                            <Flag size={12} aria-hidden />
                            {goalName}
                        </span>
                    </span>
                </>
            ) : (
                <span className="journey-chip-name">{t.setGoal}</span>
            )}
            {waiting > 0 && (
                <span className="journey-chip-badge" aria-label={t.waitingCount(waiting)}>
                    {waiting}
                </span>
            )}
        </button>
    );
}

/** The panel: requests waiting, the current journey, the others, the new ones, the archived. */
export function JourneysPanel({ onClose }: { readonly onClose: () => void }): ReactElement {
    const { tx, journeys, session, putCommand } = useChat();
    const t = tx.chat.journeys;
    const { overview, body } = journeys;
    const [archivedOpen, setArchivedOpen] = useState(false);
    const live = session.status === 'live' && session.state.session.state === 'Open';
    const start = (id: 'es:start' | 'model:start'): void => {
        putCommand(id);
        onClose();
    };
    return (
        <section className="journeys-panel" role="dialog" aria-label={t.title}>
            <header className="journeys-head">
                <Compass size={14} aria-hidden />
                <strong>{t.title}</strong>
                <span className="journeys-who muted">{session.me.participant.role === 'facilitator' ? '' : t.facilitatorDecides}</span>
                <button type="button" className="icon-button journeys-close" aria-label={t.close} onClick={onClose}>
                    <X size={14} aria-hidden />
                </button>
            </header>
            {body.problems.length > 0 && (
                <p className="journeys-problem">
                    <TriangleAlert size={12} aria-hidden /> {t.invalid(body.problems[0]?.path || '—', body.problems[0]?.message ?? '')}
                </p>
            )}
            {body.requests.length > 0 && <Requests requests={body.requests} />}
            {overview.current ? <Current item={overview.current} onClose={onClose} /> : <p className="journeys-none muted">{t.none}</p>}
            {overview.others.length > 0 && (
                <div className="journeys-others">
                    <p className="journeys-subhead">{t.others}</p>
                    <ul>
                        {overview.others.map((j) => (
                            <OtherRow key={j.summary.key} item={j} />
                        ))}
                    </ul>
                </div>
            )}
            {live && (
                <p className="journeys-new">
                    <Plus size={12} aria-hidden />
                    <span>{t.newJourney}</span>
                    {(['es:start', 'model:start'] as const).map((id) => (
                        <Act
                            key={id}
                            kind="insert"
                            disabled={commandButton(session.state, id) === 'disabled'}
                            aria-label={`/${id}: ${tx.chat.candidates.putCommand}`}
                            data-tooltip={tx.chat.candidates.putCommand}
                            onClick={() => start(id)}
                        >
                            /{id}
                        </Act>
                    ))}
                </p>
            )}
            {overview.archived.length > 0 && (
                <div className="journeys-archived">
                    <Act
                        kind="open"
                        icon={archivedOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
                        aria-expanded={archivedOpen}
                        onClick={() => setArchivedOpen(!archivedOpen)}
                    >
                        {t.archived(overview.archived.length)}
                    </Act>
                    {archivedOpen && (
                        <ul>
                            {overview.archived.map((j) => (
                                <OtherRow key={j.summary.key} item={j} archived />
                            ))}
                        </ul>
                    )}
                </div>
            )}
            {journeys.notice && <p className={`journeys-notice${journeys.notice.error ? ' chat-error' : ' muted'}`}>{journeys.notice.text}</p>}
        </section>
    );
}

/** A journey's kind and pattern, in a few words. */
function KindTag({ item }: { readonly item: JourneyItem }): ReactElement {
    const { tx } = useChat();
    const t = tx.chat;
    const s = item.summary;
    return <span className="journey-kind">{s.kind === 'es' ? t.journeys.es : `${t.journeys.model} · ${t.guide.patterns[s.pattern ?? ''] ?? s.pattern}`}</span>;
}

/** The current journey: its brief, its map, its actions. */
function Current({ item, onClose }: { readonly item: JourneyItem; readonly onClose: () => void }): ReactElement {
    const { tx, journeys, putCommand, session } = useChat();
    const t = tx.chat.journeys;
    const s = item.summary;
    const [goalOpen, setGoalOpen] = useState(false);
    const live = session.status === 'live' && session.state.session.state === 'Open';
    // the storming by its label, as the detail and the navigator name it
    const stormingLabel = (id: string): string => journeys.workspace.stormings.find((x) => x.id === id)?.label ?? id;
    const source = s.kind === 'model' ? (s.stormings?.length ? s.stormings.map((x) => `ES「${stormingLabel(x)}」`).join(t.separator) : s.context) : undefined;
    const act = (a: JourneyAct): void => journeys.act(a);
    return (
        <div className="journeys-current">
            <div className="journeys-current-head">
                <strong>{s.name}</strong>
                <KindTag item={item} />
                {item.missing && (
                    <span className="journey-missing">
                        <TriangleAlert size={12} aria-hidden /> {t.missing}
                    </span>
                )}
            </div>
            <dl className="brief-lines journeys-brief">
                <dt>{t.brief.purpose}</dt>
                <dd>{s.purpose}</dd>
                {s.scope !== undefined && (
                    <>
                        <dt>{t.brief.scope}</dt>
                        <dd>{s.scope}</dd>
                    </>
                )}
                {s.constraints !== undefined && (
                    <>
                        <dt>{t.brief.constraints}</dt>
                        <dd>{s.constraints}</dd>
                    </>
                )}
                {s.participants.length > 0 && (
                    <>
                        <dt>{t.brief.participants}</dt>
                        <dd>{s.participants.join(t.separator)}</dd>
                    </>
                )}
                {s.kind === 'es' && s.use && (
                    <>
                        <dt>{t.brief.use}</dt>
                        <dd>{t.uses[s.use]}</dd>
                    </>
                )}
                {source && (
                    <>
                        <dt>{t.brief.source}</dt>
                        <dd>{source}</dd>
                    </>
                )}
            </dl>
            {item.map && <GuideMapView map={item.map} live={live} named={false} />}
            {item.reached && s.kind === 'es' && s.use === 'modeling' && live && (
                <p className="journeys-next">
                    <CircleCheck size={12} aria-hidden /> {t.toModeling}
                    <Act
                        kind="insert"
                        aria-label={`/model:start: ${tx.chat.candidates.putCommand}`}
                        data-tooltip={tx.chat.candidates.putCommand}
                        onClick={() => {
                            putCommand('model:start');
                            onClose();
                        }}
                    >
                        /model:start
                    </Act>
                </p>
            )}
            {live && (
                <p className="journeys-actions">
                    {s.state !== 'done' && (
                        <Act kind="decide" icon={<Check size={12} aria-hidden />} onClick={() => act({ kind: 'state', journey: s.key, state: 'done' })}>
                            {t.markDone}
                        </Act>
                    )}
                    <Act kind="open" icon={<Flag size={12} aria-hidden />} aria-expanded={goalOpen} onClick={() => setGoalOpen(!goalOpen)}>
                        {t.changeGoal}
                        <ChevronDown size={12} aria-hidden />
                    </Act>
                    <Act
                        kind="insert"
                        data-tooltip={tx.chat.candidates.putCommand}
                        onClick={() => {
                            putCommand(s.kind === 'es' ? 'es:start' : 'model:start');
                            onClose();
                        }}
                    >
                        {t.reviseBrief}
                    </Act>
                    <Act kind="decide-sub" icon={<Archive size={12} aria-hidden />} onClick={() => act({ kind: 'state', journey: s.key, state: 'archived' })}>
                        {t.archive}
                    </Act>
                    <Act kind="see" icon={<Compass size={12} aria-hidden />} onClick={() => (journeys.seeGuide(), onClose())}>
                        {t.seeGuide}
                    </Act>
                </p>
            )}
            {goalOpen && <GoalMenu item={item} onDone={() => setGoalOpen(false)} />}
        </div>
    );
}

/** ゴールを変える: the pattern's goals (or the ES levels), the current one checked. */
export function GoalMenu({ item, onDone }: { readonly item: JourneyItem; readonly onDone: () => void }): ReactElement {
    const { tx, journeys } = useChat();
    const name = useStepName();
    const t = tx.chat.journeys;
    const s = item.summary;
    const choices = goalChoices(s);
    return (
        <div className="journeys-goals" role="radiogroup" aria-label={t.changeGoal}>
            {choices.map((g) => (
                <Act
                    key={g}
                    kind={g === s.goal ? 'decide' : 'decide-sub'}
                    role="radio"
                    aria-checked={g === s.goal}
                    icon={<Flag size={12} aria-hidden />}
                    onClick={() => {
                        if (g !== s.goal) journeys.act({ kind: 'goal', journey: s.key, goal: g });
                        onDone();
                    }}
                >
                    {name(g, s.kind)}
                </Act>
            ))}
        </div>
    );
}

/** Another journey: where it stands; choosing it makes it current (an archived one: brought back). */
function OtherRow({ item, archived = false }: { readonly item: JourneyItem; readonly archived?: boolean }): ReactElement {
    const { tx, journeys, session } = useChat();
    const t = tx.chat.journeys;
    const name = useStepName();
    const s = item.summary;
    const live = session.status === 'live' && session.state.session.state === 'Open';
    const where = item.missing ? t.missing : item.reached ? `${name(item.goal, s.kind)} · ${t.reached}` : `${name(item.here)} → ${name(item.goal, s.kind)}`;
    return (
        <li className={`journeys-row${s.state === 'done' ? ' done' : ''}`}>
            <span className="journey-kind">{s.kind === 'es' ? 'ES' : t.modelShort}</span>
            <span className="journeys-row-name">{s.name}</span>
            <span className="journeys-row-where muted">
                {item.reached ? <CircleCheck size={11} aria-hidden /> : <MapPin size={11} aria-hidden />}
                {where}
            </span>
            {live &&
                (archived ? (
                    <Act
                        kind="decide-sub"
                        icon={<ArchiveRestore size={12} aria-hidden />}
                        onClick={() => journeys.act({ kind: 'state', journey: s.key, state: 'active' })}
                    >
                        {t.restore}
                    </Act>
                ) : (
                    <Act kind="decide-sub" onClick={() => journeys.choose(s.key)}>
                        {t.choose}
                    </Act>
                ))}
        </li>
    );
}

/** What a request asks, in a line. */
function useRequestText(): (r: JourneyRequestBody) => string {
    const { tx, journeys } = useChat();
    const t = tx.chat.journeys;
    const name = useStepName();
    const all = [journeys.overview.current, ...journeys.overview.others, ...journeys.overview.archived].flatMap((j) => (j ? [j] : []));
    const journeyName = (key: string | null): string => (key === null ? t.defaultJourney : (all.find((j) => j.summary.key === key)?.summary.name ?? key));
    return (r) => {
        const a = r.act;
        switch (a.kind) {
            case 'choose':
                return t.requests.choose(journeyName(a.journey));
            case 'goal':
                return t.requests.goal(journeyName(a.journey), name(a.goal, a.journey.startsWith('es:') ? 'es' : 'model'));
            case 'state':
                return t.requests.state(journeyName(a.journey), t.states[a.state]);
            case 'mark':
                return t.requests.mark(journeyName(a.journey), a.context ?? name(a.step), a.done);
        }
    };
}

/** The participants' requests: the facilitator approves or denies; their requester may withdraw. */
function Requests({ requests }: { readonly requests: readonly JourneyRequestBody[] }): ReactElement {
    const { tx, journeys, session } = useChat();
    const t = tx.chat.journeys;
    const text = useRequestText();
    const facilitator = session.me.participant.role === 'facilitator';
    const mine = (r: JourneyRequestBody): boolean => r.by === session.me.participant.id;
    const shown = facilitator ? requests : requests.filter(mine);
    if (shown.length === 0) return <></>;
    return (
        <ul className="journeys-requests" aria-label={t.requestsLabel}>
            {shown.map((r) => (
                <li key={r.id} className="journeys-request">
                    <span className="journeys-request-text">
                        <strong>{facilitator ? r.byName : t.you}</strong> {text(r)}
                    </span>
                    {facilitator ? (
                        <span className="journeys-request-actions">
                            <Act kind="decide" icon={<Check size={12} aria-hidden />} onClick={() => journeys.decide(r.id, 'approve')}>
                                {t.approve}
                            </Act>
                            <Act kind="danger" onClick={() => journeys.decide(r.id, 'deny')}>
                                {t.deny}
                            </Act>
                        </span>
                    ) : (
                        <span className="journeys-request-actions">
                            <span className="muted">{t.waiting}</span>
                            <Act kind="stop" onClick={() => journeys.decide(r.id, 'withdraw')}>
                                {t.withdraw}
                            </Act>
                        </span>
                    )}
                </li>
            ))}
        </ul>
    );
}
