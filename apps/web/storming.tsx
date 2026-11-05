import {
    ArrowLeft,
    Blocks,
    Bot,
    ChevronRight,
    CircleCheck,
    CirclePlus,
    CornerDownRight,
    Eye,
    EyeOff,
    Layers,
    ListOrdered,
    MapPin,
    MessageCircleQuestionMark,
    MessageSquare,
    Microscope,
    MoveRight,
    PencilLine,
    Sparkles,
    Telescope,
    TriangleAlert,
    Undo2,
    Wrench,
    type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { commandsOf, elementOf, type DomainModel } from '@domaintrail/modeling';
import { type AnyDeclaration, firstDeclarations, isDesignLevelOnly, type NodeElement, type Stage, type Storming, type Timeline } from '@domaintrail/storming';
import { type Diagnostic } from '@domaintrail/kernel';
import {
    type DisplayMode,
    type LaidOutGraph,
    type RenderGraph,
    stormingViewKey,
    VIEW_LEVELS,
    type ViewLevel,
    type ViewOptions,
} from '@domaintrail/visualization';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { useT } from './i18n';
import { labelOrName, nameIn, shownLabel, type Select } from './model-utils';
import type { ElementActivity, StormingElementRef } from './session/element-activity';
import { beginActions, hiddenConnections, otherPlaces, problemText, type BeginAction, type OtherPlace } from './storming-detail';
import { TOOLTIP_ATTR } from './tooltip';
import type { SourceFocus } from './source';
import { activeFilterCount } from './view/filters';
import { FilterPopover, FilterSection, LevelSwitch, SubjectPicker, ToolbarSubject } from './view/toolbar';

/** What the Event Storming view shows: a storming, a level and a timeline filter, all of them the page's state only. */
export interface StormingChoice {
    stormingId: string | undefined;
    level: ViewLevel;
    /** By storming ID: the selected timeline, or `@<stage ID>` for a stage (none: the integrated canvas). */
    timelines: Record<string, string>;
    /** 「例外を表示」: false hides the exceptions on the integrated canvas and a stage (absent: shown). */
    exceptions?: boolean;
}

/** Whether a storming has exceptions (the 絞り込み's 「例外を表示」 is then shown). */
export const hasExceptionTimelines = (storming: StormingView): boolean => storming.timelines.some((t) => t.exception);

/** The picker's value of a stage's view (a timeline's is its ID: an ID never starts with `@`). */
export const stageChoice = (stageId: string): string => `@${stageId}`;

/**
 * The choice showing `scope` of a storming — '' the integrated canvas, `@<stage ID>` a stage, else a timeline's ID —
 * the storming shown with it. The view bar's pickers and the storming navigator both choose through it.
 */
export function chooseScope(choice: StormingChoice, stormingId: string, scope: string): StormingChoice {
    const { [stormingId]: _, ...others } = choice.timelines;
    return { ...choice, stormingId, timelines: scope ? { ...others, [stormingId]: scope } : others };
}

/** The scope of the view shown (see `chooseScope`), in the storming shown. */
export function shownScope(stormings: readonly StormingView[], choice: StormingChoice): { stormingId: string; scope: string } | undefined {
    const shown = shownStorming(stormings, choice);
    if (!shown) return undefined;
    const { timelineId, stageId } = shown.options;
    return { stormingId: shown.storming.id, scope: timelineId ?? (stageId !== undefined ? stageChoice(stageId) : '') };
}

/** The storming shown (the chosen one, or the first) and the view of it, as the payload keys it. */
export function shownStorming(stormings: readonly StormingView[], choice: StormingChoice): { storming: StormingView; options: ViewOptions } | undefined {
    const storming = stormings.find((s) => s.id === choice.stormingId) ?? stormings[0];
    if (!storming) return undefined;
    const level = VIEW_LEVELS.includes(choice.level) ? choice.level : 'big-picture';
    const scope = choice.timelines[storming.id];
    const stage = scope?.startsWith('@') ? storming.stages?.find((st) => stageChoice(st.id) === scope) : undefined;
    // an exception's own timeline is shown as it is; the integrated canvas and a stage, without the exceptions if asked
    const hide = choice.exceptions === false && hasExceptionTimelines(storming) ? { hideExceptions: true as const } : {};
    if (stage) return { storming, options: { level, stageId: stage.id, ...hide } };
    return { storming, options: scope !== undefined && storming.timelines.some((t) => t.id === scope) ? { level, timelineId: scope } : { level, ...hide } };
}

/** The drawing and the render graph of the shown view. */
export function stormingGraph(stormings: readonly StormingView[], choice: StormingChoice): { graph: LaidOutGraph; render: RenderGraph } | undefined {
    const shown = shownStorming(stormings, choice);
    return shown && shown.storming.views[stormingViewKey(shown.options)];
}

/** Selection IDs of storming elements: `es/<Storming>/<Local>` (`esElementId`). */
export const isStormingSelection = (id: string | undefined): id is string => !!id?.startsWith('es/');

function parseSelection(id: string): { stormingId: string; localId?: string } {
    const [, stormingId, localId] = id.split('/');
    return localId === undefined ? { stormingId } : { stormingId, localId };
}

/** The storming and the declaration a selection ID names, if they still exist. */
function lookup(stormings: readonly StormingView[], id: string): { view: StormingView; declaration?: AnyDeclaration } | undefined {
    const { stormingId, localId } = parseSelection(id);
    const view = stormings.find((s) => s.id === stormingId);
    if (!view) return undefined;
    if (localId === undefined) return { view };
    const declaration = firstDeclarations(view.storming).get(localId);
    return declaration && { view, declaration };
}

/** A storming selection's name as the detail heads it (its label or ID, by the display mode); its ID when it is not found. */
export function stormingSelectionTitle(stormings: readonly StormingView[], id: string, mode: DisplayMode): string {
    const found = lookup(stormings, id);
    if (!found) return stormingSelectionName(id);
    const item = found.declaration ?? found.view.storming;
    return nameIn(mode, item.id, item.label);
}

export const stormingExists = (stormings: readonly StormingView[], id: string): boolean => !!lookup(stormings, id);

/** Where a storming element is written. */
export function stormingLocation(stormings: readonly StormingView[], id: string): SourceFocus | undefined {
    const found = lookup(stormings, id);
    const range = (found?.declaration ?? found?.view.storming)?.range;
    return range && { file: range.file, line: range.start.line, endLine: range.end.line };
}

/** The name of a selection in the inspector's back button. */
export const stormingSelectionName = (id: string): string => id.slice(id.lastIndexOf('/') + 1);

/** The `.dt` item a `ref` names, when the model has it (an event or an aggregate `Ctx.Name`, a command `Ctx.Agg.cmd`). */
function dtTarget(model: DomainModel | null, kind: string, path: string): string | undefined {
    if (!model) return undefined;
    const segments = path.split('.');
    if (kind === 'command' && segments.length === 3) {
        const agg = elementOf(model, `${segments[0]}.${segments[1]}`);
        return agg && commandsOf(agg).find((c) => c.name === segments[2])?.id;
    }
    const el = segments.length === 2 ? elementOf(model, path) : undefined;
    return el?.kind === kind ? el.id : undefined;
}

const LEVEL_ICONS: Record<ViewLevel, LucideIcon> = { 'big-picture': Telescope, 'design-level': Microscope };

/**
 * The Event Storming view's toolbar: its subject, the storming then the timeline (すべて（統合）, a stage with its
 * exceptions, or one timeline) as a breadcrumb of pickers, and its level. The timeline is what is looked at, not a
 * filter: the integrated canvas, a stage and a timeline draw different things (the exceptions are, `StormingFilter`).
 */
export function StormingToolbar({
    stormings,
    choice,
    mode,
    onChange,
}: {
    stormings: readonly StormingView[];
    choice: StormingChoice;
    mode: DisplayMode;
    onChange: (choice: StormingChoice) => void;
}) {
    const t = useT();
    const shown = shownStorming(stormings, choice);
    if (!shown) return null;
    const { storming, options } = shown;
    const stageName = (id: string): string => nameIn(mode, id, storming.stages?.find((st) => st.id === id)?.label);
    return (
        <ToolbarSubject>
            <nav className="subject-crumbs" aria-label={t.views.storming}>
                <SubjectPicker
                    label={t.stormingPicker}
                    value={storming.id}
                    options={stormings.map((s) => ({ value: s.id, label: nameIn(mode, s.id, s.label) }))}
                    onChange={(id) => onChange({ ...choice, stormingId: id })}
                />
                {storming.timelines.length > 0 && (
                    <>
                        <ChevronRight className="subject-sep" size={14} aria-hidden />
                        <SubjectPicker
                            label={t.timelineFilter}
                            value={options.timelineId ?? (options.stageId !== undefined ? stageChoice(options.stageId) : '')}
                            options={[
                                { value: '', label: t.allTimelines },
                                ...(storming.stages ?? []).map((st) => ({ value: stageChoice(st.id), label: t.stageView(stageName(st.id)) })),
                                ...storming.timelines.map((tl) => {
                                    const name = tl.exception ? t.exceptionTimeline(nameIn(mode, tl.id, tl.label)) : nameIn(mode, tl.id, tl.label);
                                    return { value: tl.id, label: tl.stageId !== undefined ? t.stageTimeline(stageName(tl.stageId), name) : name };
                                }),
                            ]}
                            onChange={(id) => onChange(chooseScope(choice, storming.id, id))}
                        />
                    </>
                )}
            </nav>
            <LevelSwitch
                label={t.stormingLevel}
                levels={VIEW_LEVELS}
                value={options.level}
                icons={LEVEL_ICONS}
                names={(l) => ({ label: t.stormingLevels[l].label, tooltip: `${t.stormingLevels[l].label} — ${t.stormingLevels[l].hint}` })}
                onChange={(level) => onChange({ ...choice, level })}
            />
        </ToolbarSubject>
    );
}

/**
 * The storming's 絞り込み: 「例外を表示」, when the storming has exceptions and the view is not one timeline (whose
 * exceptions are what it shows). Hidden exceptions count as one narrowing.
 */
export function StormingFilter({
    stormings,
    choice,
    onChange,
}: {
    stormings: readonly StormingView[];
    choice: StormingChoice;
    onChange: (choice: StormingChoice) => void;
}): ReactNode {
    const t = useT();
    const shown = shownStorming(stormings, choice);
    if (!shown || !hasExceptionTimelines(shown.storming) || shown.options.timelineId !== undefined) return null;
    const exceptions = choice.exceptions !== false;
    return (
        <FilterPopover count={activeFilterCount({ view: 'storming', exceptions })} onClear={() => onChange(clearStormingFilter(choice))}>
            <FilterSection title={t.filters.shown}>
                <label className="check">
                    <input type="checkbox" checked={exceptions} onChange={(e) => onChange({ ...choice, exceptions: e.target.checked })} />
                    {t.showExceptions}
                </label>
            </FilterSection>
        </FilterPopover>
    );
}

/** The storming's 絞り込み cleared: the exceptions shown again. */
export const clearStormingFilter = (choice: StormingChoice): StormingChoice => ({ ...choice, exceptions: true });

/** What the detail of a storming element gets from a session (`useSessionPage`); none outside one. */
export interface StormingDetailSession {
    /** What the session did about an element: its talk, the AI's runs, the run that added or changed it. */
    readonly activity: (el: StormingElementRef) => ElementActivity;
    /**
     * Puts the beginning of a message in the composer (`write` puts the element's `#` mention in it), with the element
     * as its target, and opens the chat; the person sends it. Absent while the session cannot take messages: the
     * actions are hidden.
     */
    readonly begin?: (elementId: string, write: (target: string) => string) => void;
    /** The chat, at a message. */
    readonly openMessage: (request: string) => void;
    /** The chat, at the card of a run. */
    readonly openRun: (run: string) => void;
    /** AI の作業, at the unit of a run. */
    readonly openRuns: (run: string) => void;
    /** The storming's journey, in brief (the whole storming selected). */
    readonly journeys?: (storming: string) => ReactNode;
}

/** A row of the detail: a grey icon naming it (its name as the tooltip), and its content. */
function Row({ icon: Icon, label, className, children }: { icon: LucideIcon; label: string; className?: string; children: ReactNode }): ReactNode {
    return (
        <div className={`es-row${className ? ` ${className}` : ''}`}>
            <span className="es-row-icon" role="img" aria-label={label} {...{ [TOOLTIP_ATTR]: label }}>
                <Icon size={14} aria-hidden />
            </span>
            <div className="es-row-body">{children}</div>
        </div>
    );
}

/** An action of the detail: an icon in the brand colour (filled when `primary`), its name as the tooltip. */
function Action({ icon: Icon, label, primary, onClick }: { icon: LucideIcon; label: string; primary?: boolean; onClick: () => void }): ReactNode {
    return (
        <button type="button" className={`es-action${primary ? ' filled' : ''}`} aria-label={label} {...{ [TOOLTIP_ATTR]: label }} onClick={onClick}>
            <Icon size={14} aria-hidden />
        </button>
    );
}

/**
 * The detail of a storming element, read next to the canvas (docs/plans/layout.md, step 5): only what the canvas does
 * not show — its problems on top, its description, the places outside the view, what Big Picture hides, the talk about
 * it, the AI's runs and the change of this session, its `.dt` counterpart, a resolved hotspot's conclusion — each row
 * only when it has something, then the actions that begin a message about it. A stage, a timeline and a group show
 * their flows. The connections it has are what the canvas keeps in full view around the selection.
 */
export function StormingDetails({
    stormings,
    selected,
    render,
    level,
    model,
    mode,
    diagnostics,
    history,
    headingAction,
    session,
    onSelect,
    onShowScope,
    onLevel,
}: {
    stormings: readonly StormingView[];
    selected: string;
    /** The render graph of the view shown, if it is a view of this storming. */
    render: RenderGraph | undefined;
    /** The level of the view shown. */
    level: ViewLevel;
    model: DomainModel | null;
    mode: DisplayMode;
    diagnostics: Diagnostic[];
    /** The back and close buttons. */
    history: ReactNode;
    /** Placed next to the element's name (in a session, the 💬 that adds it as a request's target). */
    headingAction?: ReactNode;
    session?: StormingDetailSession | undefined;
    onSelect: Select;
    /** Shows a view of the storming (`chooseScope`'s scope: a stage's or a timeline's), then selects `then` in it. */
    onShowScope?: (stormingId: string, scope: string, then?: string) => void;
    /** Shows the storming at another level (the selection kept). */
    onLevel?: (level: ViewLevel) => void;
}): ReactNode {
    const t = useT();
    const d = t.esDetail;
    const found = lookup(stormings, selected);
    if (!found) {
        return (
            <div className="inspector-head">
                {history}
                <p className="muted">{t.notInStorming(stormingSelectionName(selected))}</p>
            </div>
        );
    }
    const { view, declaration } = found;
    const storming = view.storming;
    const item = declaration ?? { ...storming, kind: undefined };
    const byId = firstDeclarations(storming);
    const name = (id: string): string => nameIn(mode, id, byId.get(id)?.label);
    const link = (id: string): ReactNode => <a onClick={() => onSelect(`es/${storming.id}/${id}`)}>{name(id)}</a>;
    const problems = diagnostics.filter((x) => x.elementId === selected);
    const begin = session?.begin && declaration ? (write: (target: string) => string) => session.begin?.(selected, write) : undefined;
    const isNote = declaration !== undefined && declaration.kind !== 'timeline' && declaration.kind !== 'group' && declaration.kind !== 'stage';
    const designOnly = declaration?.kind === 'event' && isDesignLevelOnly(declaration);

    return (
        <>
            <div className="inspector-head es-detail-head">
                {history}
                <div className="inspector-row">
                    <span className={`kind kind-es-${item.kind ?? 'storming'}`}>
                        {item.kind === 'timeline' && item.exception ? t.esException : item.kind ? t.esKinds[item.kind] : t.inStorming}
                    </span>
                    {designOnly && (
                        <span className="es-badge" role="img" aria-label={t.designLevelOnly} {...{ [TOOLTIP_ATTR]: t.designLevelOnly }}>
                            <Microscope size={13} aria-hidden />
                        </span>
                    )}
                </div>
                <div className="inspector-title">
                    <h2>{mode === 'both' ? labelOrName({ name: item.id, label: item.label }) : nameIn(mode, item.id, item.label)}</h2>
                    {headingAction}
                </div>
                {mode === 'both' && shownLabel(item.label) && <div className="canonical-name">{item.id}</div>}
            </div>
            <div className="inspector-body es-detail">
                {problems.map((p, i) => (
                    <div key={i} className={`es-problem es-problem-${p.severity}`}>
                        <span className="es-row-icon" role="img" aria-label={d.problem}>
                            <TriangleAlert size={14} aria-hidden />
                        </span>
                        <span className="es-problem-text" {...{ [TOOLTIP_ATTR]: p.code }}>
                            {problemText(p, d.problems)}
                        </span>
                        {begin && (
                            <Action icon={Wrench} label={d.fix} primary onClick={() => begin((target) => d.begin.fix(target, problemText(p, d.problems)))} />
                        )}
                    </div>
                ))}
                {item.doc && <p className="doc">{item.doc}</p>}
                {declaration === undefined && session?.journeys?.(storming.id)}
                {declaration?.kind === 'event' && (
                    <EventRows
                        storming={storming}
                        eventId={declaration.id}
                        render={render}
                        level={level}
                        name={name}
                        link={link}
                        onShowScope={onShowScope}
                        onLevel={onLevel}
                    />
                )}
                {isNote && session && <SessionRows activity={session.activity({ storming: storming.id, local: declaration.id })} session={session} />}
                {isNote && (declaration.kind === 'event' || declaration.kind === 'command' || declaration.kind === 'aggregate') && (
                    <ModelRow declaration={declaration} model={model} onSelect={onSelect} />
                )}
                {declaration?.kind === 'hotspot' && <ConclusionRow clauses={declaration.clauses} />}
                {declaration?.kind === 'group' && (
                    <Row icon={Layers} label={t.groupEvents}>
                        <ul className="es-list">
                            {declaration.events.map((e, i) => (
                                <li key={i}>{link(e.eventId)}</li>
                            ))}
                        </ul>
                    </Row>
                )}
                {declaration?.kind === 'stage' && (
                    <StageRows stage={declaration} link={link} onShow={onShowScope && (() => onShowScope(storming.id, stageChoice(declaration.id)))} />
                )}
                {declaration?.kind === 'timeline' && (
                    <TimelineRows timeline={declaration} link={link} onShow={onShowScope && (() => onShowScope(storming.id, declaration.id))} />
                )}
                {isNote && begin && (
                    <div className="es-actions">
                        {beginActions(declaration.kind, hotspotResolved(declaration.clauses)).map((a) => (
                            <Action key={a} icon={BEGIN_ICONS[a]} label={d[a]} primary={a === 'ask'} onClick={() => begin(d.begin[a])} />
                        ))}
                    </div>
                )}
            </div>
        </>
    );
}

const BEGIN_ICONS: Record<BeginAction, LucideIcon> = { ask: Sparkles, question: MessageCircleQuestionMark, resolve: CircleCheck };

/** Whether a hotspot is resolved (`status resolved`). */
const hotspotResolved = (clauses: NodeElement['clauses']): boolean => clauses.some((c) => c.type === 'status' && c.value === 'resolved');

/** An event's rows: its places outside the view shown, and at Big Picture the connections only Design Level draws. */
function EventRows({
    storming,
    eventId,
    render,
    level,
    name,
    link,
    onShowScope,
    onLevel,
}: {
    storming: Storming;
    eventId: string;
    render: RenderGraph | undefined;
    level: ViewLevel;
    name: (id: string) => string;
    link: (id: string) => ReactNode;
    onShowScope: ((stormingId: string, scope: string, then?: string) => void) | undefined;
    onLevel: ((level: ViewLevel) => void) | undefined;
}): ReactNode {
    const t = useT();
    const d = t.esDetail;
    const places = otherPlaces(storming, eventId, render);
    const hidden = level === 'big-picture' ? hiddenConnections(storming, eventId) : undefined;
    const placeName = (p: OtherPlace): string => {
        const own = p.exception ? t.exceptionTimeline(name(p.timelineId)) : name(p.timelineId);
        return p.stageId !== undefined ? `${name(p.stageId)} › ${own}` : own;
    };
    return (
        <>
            {places.length > 0 && (
                <Row icon={MapPin} label={d.otherPlaces}>
                    <ul className="es-list">
                        {places.map((p) => (
                            <li key={p.timelineId}>
                                {onShowScope ? (
                                    <a onClick={() => onShowScope(storming.id, p.timelineId, `es/${storming.id}/${eventId}`)}>{placeName(p)}</a>
                                ) : (
                                    placeName(p)
                                )}
                            </li>
                        ))}
                    </ul>
                </Row>
            )}
            {hidden && (
                <Row icon={EyeOff} label={d.hidden}>
                    <span className="es-flow">
                        {hidden.causes.map((c, i) => (
                            <span key={c.command}>
                                {i > 0 && ', '}
                                {c.actors.map((a) => (
                                    <span key={a} className="es-actor">
                                        {link(a)}{' '}
                                    </span>
                                ))}
                                {link(c.command)}
                            </span>
                        ))}
                        {hidden.causes.length > 0 && ' → '}
                        <span className="muted">{d.here}</span>
                        {hidden.reactions.length > 0 && ' → '}
                        {hidden.reactions.map((r, i) => (
                            <span key={r}>
                                {i > 0 && ', '}
                                {link(r)}
                            </span>
                        ))}
                    </span>
                    {onLevel && <Action icon={Microscope} label={d.seeDesignLevel} onClick={() => onLevel('design-level')} />}
                </Row>
            )}
        </>
    );
}

/** The session's rows: the talk about the element, the AI's runs about it, and the run that added or changed it. */
function SessionRows({ activity, session }: { activity: ElementActivity; session: StormingDetailSession }): ReactNode {
    const d = useT().esDetail;
    const { talk, runs, change } = activity;
    return (
        <>
            {talk && (
                <Row icon={MessageSquare} label={d.talk}>
                    <a onClick={() => session.openMessage(talk.latest.request)}>{talk.count}</a>{' '}
                    <q className="es-quote" {...{ [TOOLTIP_ATTR]: talk.latest.text }}>
                        {talk.latest.text}
                    </q>
                </Row>
            )}
            {runs && (
                <Row icon={Bot} label={d.runs}>
                    <a onClick={() => session.openRuns(runs.latest)}>{runs.count}</a>
                </Row>
            )}
            {change && (
                <Row icon={change.change === 'added' ? CirclePlus : PencilLine} label={change.change === 'added' ? d.added : d.changed}>
                    <a className="es-quote" onClick={() => session.openRun(change.run)} {...{ [TOOLTIP_ATTR]: change.request }}>
                        <q>{change.request}</q>
                    </a>
                </Row>
            )}
        </>
    );
}

/** The `.dt` counterpart of an event, a command or an aggregate, only when it has a `ref` (a link while the model has it). */
function ModelRow({ declaration, model, onSelect }: { declaration: NodeElement; model: DomainModel | null; onSelect: Select }): ReactNode {
    const t = useT();
    const refs = declaration.clauses.flatMap((c) => (c.type === 'ref' ? [c.path] : []));
    if (refs.length === 0) return null;
    return (
        <Row icon={Blocks} label={t.esDetail.model}>
            {refs.map((path) => {
                const target = dtTarget(model, declaration.kind, path);
                return (
                    <div key={path}>
                        {target ? (
                            <a onClick={() => onSelect(target)}>
                                <code>{path}</code>
                            </a>
                        ) : (
                            <code>{path}</code>
                        )}
                    </div>
                );
            })}
        </Row>
    );
}

/** A resolved hotspot's conclusion (an open one has none: its action tells it). */
function ConclusionRow({ clauses }: { clauses: NodeElement['clauses'] }): ReactNode {
    const t = useT();
    const resolution = clauses.find((c) => c.type === 'resolution');
    if (!hotspotResolved(clauses) || !resolution) return null;
    return (
        <Row icon={CircleCheck} label={t.esDetail.conclusion}>
            {resolution.text}
        </Row>
    );
}

/** A stage: the stage it comes after, its main flows and its exceptions, and the way to its view. */
function StageRows({ stage, link, onShow }: { stage: Stage; link: (id: string) => ReactNode; onShow: (() => void) | undefined }): ReactNode {
    const t = useT();
    const mains = stage.timelines.filter((tl) => !tl.exception);
    const exceptions = stage.timelines.filter((tl) => tl.exception);
    return (
        <>
            {stage.afters[0] && (
                <Row icon={ArrowLeft} label={t.stageAfter}>
                    {link(stage.afters[0].stageId)}
                </Row>
            )}
            {mains.length > 0 && (
                <Row icon={MoveRight} label={t.stageMain}>
                    <ul className="es-list">
                        {mains.map((tl) => (
                            <li key={tl.id}>{link(tl.id)}</li>
                        ))}
                    </ul>
                </Row>
            )}
            {exceptions.length > 0 && (
                <Row icon={CornerDownRight} label={t.stageExceptions}>
                    <ul className="es-list">
                        {exceptions.map((tl) => (
                            <li key={tl.id}>{link(tl.id)}</li>
                        ))}
                    </ul>
                </Row>
            )}
            {onShow && (
                <div className="es-actions">
                    <Action icon={Eye} label={t.showStage} onClick={onShow} />
                </div>
            )}
        </>
    );
}

/** A timeline or an exception: its steps (a group's events in braces), where an exception returns to, and its view. */
function TimelineRows({ timeline, link, onShow }: { timeline: Timeline; link: (id: string) => ReactNode; onShow: (() => void) | undefined }): ReactNode {
    const t = useT();
    return (
        <>
            <Row icon={ListOrdered} label={t.esDetail.steps}>
                <ol className="es-list">
                    {timeline.steps.map((s, i) => (
                        <li key={i}>
                            {s.type === 'event' ? (
                                link(s.eventId)
                            ) : (
                                <>
                                    {link(s.id)} {'{ '}
                                    {s.events.map((e, j) => (
                                        <span key={j}>
                                            {j > 0 && ', '}
                                            {link(e.eventId)}
                                        </span>
                                    ))}
                                    {' }'}
                                </>
                            )}
                        </li>
                    ))}
                </ol>
            </Row>
            {timeline.rejoin && (
                <Row icon={Undo2} label={t.esDetail.rejoin}>
                    {link(timeline.rejoin.eventId)}
                </Row>
            )}
            {onShow && (
                <div className="es-actions">
                    <Action icon={Eye} label={t.esDetail.openTimeline} onClick={onShow} />
                </div>
            )}
        </>
    );
}
