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
    X,
    type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { commandsOf, elementOf, type DomainModel } from '@domaintrail/modeling';
import {
    type AnyDeclaration,
    buildSemanticGraph,
    firstDeclarations,
    isDesignLevelOnly,
    type NodeElement,
    type Stage,
    type Storming,
    type Timeline,
} from '@domaintrail/storming';
import { type Diagnostic } from '@domaintrail/kernel';
import {
    type DisplayMode,
    drawsElement,
    flowInDrawing,
    flowNotes,
    HIDEABLE,
    type Hideable,
    hideInDrawing,
    hides,
    laidOutHidden,
    type LaidOutGraph,
    mainFlowOf,
    mainFlows,
    type MainFlow,
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
import { FilterPopover, FilterSection, LevelSwitch, MenuPicker, SubjectPicker, ToolbarSubject } from './view/toolbar';

/**
 * What the Event Storming view shows, all of it the page's state only (ADR 0032 §11): a storming, the timeline on its
 * canvas (すべて, or one main flow), a level, and what is hidden — the exceptions (the layer over the canvas, off) and
 * what the 絞り込み hides.
 */
export interface StormingChoice {
    stormingId: string | undefined;
    level: ViewLevel;
    /**
     * By storming ID: the main flow on its canvas (`MainFlow`'s ID; none: すべて). An earlier version kept here a
     * stage's `@<ID>` (read as すべて) or any timeline's ID (an exception: すべて, its exceptions included; a main
     * flow: the main flow it is part of).
     */
    timelines: Record<string, string>;
    /**
     * What is hidden (absent: nothing), in every storming where it applies (`hideableIn`), as `HIDDEN_BY` hides it:
     * `exceptions` — the exceptions' layer off (the toggle beside the breadcrumb, laid out without them) — and what the
     * 絞り込み hides (the resolved hotspots, by the drawing alone).
     */
    hidden?: Hideable[];
    /** 「例外を表示」 as an earlier version kept it (false: hidden): read as `hidden`'s `exceptions` (`hiddenOf`). */
    exceptions?: boolean;
    /** The flow as a trial of this version kept it: read as the exceptions included or not, and one main flow. */
    flow?: 'main' | 'all' | { readonly exception: string } | { readonly main: string };
}

/**
 * The exception emphasized over the canvas (ADR 0032 §11): close to a selection — the page's own, never kept nor
 * followed — and apart from the stickies' selection (selecting a sticky keeps it).
 */
export interface StormingFocus {
    readonly stormingId: string;
    readonly exceptionId: string;
}

/** Whether a storming has exceptions (the exceptions' toggle is then shown). */
export const hasExceptionTimelines = (storming: StormingView): boolean => storming.timelines.some((t) => t.exception);

/** Whether a storming has a resolved hotspot (the 絞り込み's 「解決済みを表示」 is then shown). */
export const hasResolvedHotspots = (storming: StormingView): boolean =>
    [...firstDeclarations(storming.storming).values()].some((d) => d.kind === 'hotspot' && hotspotResolved(d.clauses));

/**
 * What a choice hides, wherever it applies: an earlier version's `exceptions: false` and a trial's flow 「主な流れ」 are
 * the exceptions hidden.
 */
export function hiddenOf(choice: StormingChoice): ReadonlySet<Hideable> {
    const flow = choice.flow;
    const exceptions = flow !== undefined ? flow === 'main' : choice.hidden !== undefined ? choice.hidden.includes('exceptions') : choice.exceptions === false;
    return new Set(HIDEABLE.filter((k) => (k === 'exceptions' ? exceptions : choice.hidden?.includes(k) === true)));
}

/** The choice as this version writes it: an earlier version's and a trial's fields read and dropped. */
function written(choice: StormingChoice): StormingChoice {
    const hidden = hiddenOf(choice);
    const { exceptions: _, hidden: __, flow, ...rest } = choice;
    const main = typeof flow === 'object' && 'main' in flow && choice.stormingId !== undefined ? { [choice.stormingId]: flow.main } : {};
    const kinds = HIDEABLE.filter((k) => hidden.has(k));
    return { ...rest, timelines: { ...rest.timelines, ...main }, ...(kinds.length && { hidden: kinds }) };
}

/** The choice with `kind` hidden or shown again (written as `hidden`). */
export function withHidden(choice: StormingChoice, kind: Hideable, hide: boolean): StormingChoice {
    const all = new Set(hiddenOf(choice));
    if (hide) all.add(kind);
    else all.delete(kind);
    const { hidden: _, ...rest } = written(choice);
    const hidden = HIDEABLE.filter((k) => all.has(k));
    return hidden.length ? { ...rest, hidden } : rest;
}

/** What a view of `storming` can hide: its exceptions (the toggle), its resolved hotspots (the 絞り込み). */
export function hideableIn(storming: StormingView): Hideable[] {
    return HIDEABLE.filter((k) => (k === 'exceptions' ? hasExceptionTimelines(storming) : hasResolvedHotspots(storming)));
}

/** What the 絞り込み can hide in a view of `storming`: the resolved hotspots (the exceptions are the toggle's). */
export const filterableIn = (storming: StormingView): Hideable[] => hideableIn(storming).filter((k) => k !== 'exceptions');

/** What the view shown hides: what the choice hides, of what applies to it (`hideableIn`). */
export function shownHidden(stormings: readonly StormingView[], choice: StormingChoice): ReadonlySet<Hideable> {
    const shown = shownStorming(stormings, choice);
    if (!shown) return new Set();
    const hidden = new Set(hiddenOf(choice));
    // an earlier version's exception shown on its own: its exceptions included
    if (shown.exceptionShown) hidden.delete('exceptions');
    return new Set(hideableIn(shown.storming).filter((k) => hidden.has(k)));
}

/** The main flows of a storming (`mainFlows`). */
export const mainFlowsOf = (storming: StormingView): MainFlow[] => mainFlows(storming.timelines, storming.stages);

/** The view shown: the storming, the layout of it the payload keys (`options`), and the main flow on it, if one. */
export interface ShownStorming {
    storming: StormingView;
    options: ViewOptions;
    /** The main flow on the canvas (none: すべて). */
    main: MainFlow | undefined;
    /** An earlier version showed an exception's own view: its exceptions are included. */
    exceptionShown?: true;
}

/** The storming shown (the chosen one, or the first), the view of it as the payload keys it, and its main flow. */
export function shownStorming(stormings: readonly StormingView[], choice: StormingChoice): ShownStorming | undefined {
    const storming = stormings.find((s) => s.id === choice.stormingId) ?? stormings[0];
    if (!storming) return undefined;
    const level = VIEW_LEVELS.includes(choice.level) ? choice.level : 'big-picture';
    const flows = mainFlowsOf(storming);
    const trial = typeof choice.flow === 'object' && 'main' in choice.flow && choice.stormingId === storming.id ? choice.flow.main : undefined;
    const scope = trial ?? choice.timelines[storming.id];
    const exceptionShown = choice.flow === undefined && scope !== undefined && storming.timelines.some((t) => t.id === scope && t.exception);
    const main = flows.length > 1 && scope !== undefined ? mainFlowOf(flows, scope) : undefined;
    const hidden = new Set(hiddenOf(choice));
    if (exceptionShown) hidden.delete('exceptions');
    // laid out without what is hidden by another layout (the exceptions), of what applies; what the drawing hides is
    // left out of the drawing of that layout (`drawnAs`)
    const hide = laidOutHidden(hideableIn(storming).filter((k) => hidden.has(k)));
    return { storming, options: { level, ...hide }, main, ...(exceptionShown && { exceptionShown: true as const }) };
}

/** The choice showing another storming, with all its timelines (すべて). */
export function chooseStorming(choice: StormingChoice, stormingId: string): StormingChoice {
    const c = written(choice);
    const { [stormingId]: _, ...others } = c.timelines;
    return { ...c, stormingId, timelines: others };
}

/** The choice showing one main flow of a storming on its canvas (its `MainFlow` ID; '' or none: すべて). */
export function chooseTimeline(choice: StormingChoice, stormingId: string, mainFlow: string | undefined): StormingChoice {
    const c = written(choice);
    const { [stormingId]: _, ...others } = c.timelines;
    return { ...c, stormingId, timelines: mainFlow ? { ...others, [stormingId]: mainFlow } : others };
}

/** The choice with the exceptions' layer included or not. */
export const withExceptions = (choice: StormingChoice, include: boolean): StormingChoice => withHidden(choice, 'exceptions', !include);

/**
 * The exceptions' layer of the view shown: whether it is included, and the exceptions it lays over the canvas — every
 * one, or those branching off the main flow shown — in the storming's order. None for a storming without exceptions.
 */
export function exceptionLayer(stormings: readonly StormingView[], choice: StormingChoice): { included: boolean; exceptions: string[] } | undefined {
    const shown = shownStorming(stormings, choice);
    if (!shown || !hasExceptionTimelines(shown.storming)) return undefined;
    const all = shown.storming.views[stormingViewKey({ level: shown.options.level })]?.render;
    const drawn = all ? flowNotes(all, shown.storming.storming, shown.storming.timelines, { main: shown.main }).exceptions : [];
    return {
        included: !hides(shown.options, 'exceptions'),
        exceptions: shown.storming.timelines.filter((t) => t.exception && drawn.includes(t.id)).map((t) => t.id),
    };
}

/** The exception emphasized in the view shown: `focus` when it is of the storming shown and drawn there. */
export function shownFocus(stormings: readonly StormingView[], choice: StormingChoice, focus: StormingFocus | null): string | undefined {
    const shown = shownStorming(stormings, choice);
    const layer = exceptionLayer(stormings, choice);
    if (!focus || !shown || !layer?.included || focus.stormingId !== shown.storming.id) return undefined;
    return layer.exceptions.includes(focus.exceptionId) ? focus.exceptionId : undefined;
}

/**
 * Emphasizing an exception (its ▾, its lane's label, its row in the navigator): the exceptions included first, and
 * すべて when the main flow shown does not have it.
 */
export function focusOn(
    stormings: readonly StormingView[],
    choice: StormingChoice,
    stormingId: string,
    exceptionId: string,
): { choice: StormingChoice; focus: StormingFocus } {
    let next =
        choice.stormingId === stormingId || (choice.stormingId === undefined && stormings[0]?.id === stormingId)
            ? written(choice)
            : chooseStorming(choice, stormingId);
    next = withExceptions({ ...next, stormingId }, true);
    if (!exceptionLayer(stormings, next)?.exceptions.includes(exceptionId)) next = chooseTimeline(next, stormingId, undefined);
    return { choice: next, focus: { stormingId, exceptionId } };
}

/**
 * The choice that shows `elementId` (a storming selection) where `choice` does not draw it, to move to it and select it,
 * in the view `choice` shows (callers choose the storming and the level first). One rule for whatever keeps it out of
 * the drawing (ADR 0032 §10, §11): the exceptions included, then すべて, then the kinds the 絞り込み hides — one when
 * that is enough, else all of them. `choice` itself when the view draws it, or when nothing would (a link, the
 * palette, a turn's marks, the knowledge, the detail).
 */
export function revealIn(stormings: readonly StormingView[], choice: StormingChoice, elementId: string): StormingChoice {
    const shown = shownStorming(stormings, choice);
    if (!shown) return choice;
    const draws = (c: StormingChoice): boolean => {
        const graph = stormingDrawing(stormings, c, null);
        return graph !== undefined && drawsElement(graph, elementId, shownHidden(stormings, c));
    };
    if (draws(choice)) return choice;
    const id = shown.storming.id;
    const hidden = shownHidden(stormings, choice);
    const included = hidden.has('exceptions') ? withExceptions(choice, true) : choice;
    const all = shown.main ? chooseTimeline(included, id, undefined) : included;
    const kinds = [...hidden].filter((k) => k !== 'exceptions');
    const tries = [included, all, ...[choice, included, all].flatMap((c) => kinds.map((k) => withHidden(c, k, false)))];
    for (const c of tries) if (c !== choice && draws(c)) return c;
    const cleared = clearStormingFilter(all);
    return draws(cleared) ? cleared : choice;
}

/** The layout and the render graph of the view shown (the drawing of it: `drawnAs`). */
export function stormingGraph(stormings: readonly StormingView[], choice: StormingChoice): { graph: LaidOutGraph; render: RenderGraph } | undefined {
    const shown = shownStorming(stormings, choice);
    return shown && shown.storming.views[stormingViewKey(shown.options)];
}

/**
 * `graph` (the layout of the view shown, `stormingGraph`, or its compact one) drawn as the choice draws it: the main
 * flow shown without the others, the exception emphasized with the rest faint (`flowInDrawing`), without what the
 * 絞り込み hides (`hideInDrawing`). Nothing moves.
 */
export function drawnAs<G extends LaidOutGraph>(stormings: readonly StormingView[], choice: StormingChoice, focus: StormingFocus | null, graph: G): G {
    const shown = shownStorming(stormings, choice);
    const render = stormingGraph(stormings, choice)?.render;
    if (!shown || !render) return graph;
    const emphasized = shownFocus(stormings, choice, focus);
    const flowed = flowInDrawing(graph, render, shown.storming.storming, shown.storming.timelines, { main: shown.main, focus: emphasized });
    const hidden = shownHidden(stormings, choice);
    return hidden.size ? hideInDrawing(flowed, hidden) : flowed;
}

/**
 * The render graph of what the view shown draws (for the detail's other places): with one main flow shown, without the
 * notes it leaves out, and its events' occurrences of the timelines drawn only. The layout's own otherwise.
 */
export function drawnRender(stormings: readonly StormingView[], choice: StormingChoice): RenderGraph | undefined {
    const shown = shownStorming(stormings, choice);
    const render = stormingGraph(stormings, choice)?.render;
    if (!shown || !render || !shown.main) return render;
    const notes = flowNotes(render, shown.storming.storming, shown.storming.timelines, { main: shown.main });
    const timelines = new Set([...shown.main.timelines, ...notes.exceptions]);
    return {
        ...render,
        nodes: render.nodes
            .filter((n) => !notes.hidden.has(n.id))
            .map((n) => (n.type === 'event' ? { ...n, occurrences: n.occurrences.filter((o) => timelines.has(o.timelineId)) } : n)),
    };
}

/** The drawing of the view shown (`drawnAs`). */
export function stormingDrawing(stormings: readonly StormingView[], choice: StormingChoice, focus: StormingFocus | null): LaidOutGraph | undefined {
    const graph = stormingGraph(stormings, choice)?.graph;
    return graph && drawnAs(stormings, choice, focus, graph);
}

/** The picker's value of a stage (a timeline's is its ID: an ID never starts with `@`). */
export const stageChoice = (stageId: string): string => `@${stageId}`;

/** What showing a scope does (`scopeView`): the choice, the exception emphasized, and where the camera goes. */
export interface ScopeView {
    readonly choice: StormingChoice;
    readonly focus: StormingFocus | null;
    /** The camera to a stage's frame, or to an exception's path; none: as the view is drawn. */
    readonly frame?: { readonly stage: string } | { readonly exception: string };
}

/**
 * What a row of the storming navigator, or a declaration's link, shows (`scope`): '' the storming (すべて, nothing
 * emphasized); `@<stage ID>` the stage's frame on the same canvas (the camera to it, nothing else changed); a main
 * flow's timeline, that main flow on the canvas; an exception, emphasized (`focusOn`) with the camera on its path.
 */
export function scopeView(
    stormings: readonly StormingView[],
    choice: StormingChoice,
    focus: StormingFocus | null,
    stormingId: string,
    scope: string,
): ScopeView {
    const storming = stormings.find((s) => s.id === stormingId);
    const same = (shownStorming(stormings, choice)?.storming.id ?? '') === stormingId;
    if (!storming || scope === '') return { choice: chooseStorming(choice, stormingId), focus: null };
    if (scope.startsWith('@')) {
        const next = same ? choice : chooseStorming(choice, stormingId);
        return { choice: next, focus: same ? focus : null, frame: { stage: scope.slice(1) } };
    }
    const timeline = storming.timelines.find((t) => t.id === scope);
    if (timeline?.exception) {
        const f = focusOn(stormings, choice, stormingId, timeline.id);
        return { ...f, frame: { exception: timeline.id } };
    }
    const flows = mainFlowsOf(storming);
    const main = flows.length > 1 ? mainFlowOf(flows, scope)?.id : undefined;
    return { choice: chooseTimeline(choice, stormingId, main), focus: null };
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

/** A storming selection's local ID (its name when it is not found). */
export const stormingSelectionName = (id: string): string => id.slice(id.lastIndexOf('/') + 1);

/** The `.dt` item a `ref` names, when the model has it (an event or an aggregate `Ctx.Name`, a command `Ctx.Agg.cmd`). */
export function dtTarget(model: DomainModel | null, kind: string, path: string): string | undefined {
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
 * The Event Storming view's toolbar (ADR 0032 §11): its subject — what the canvas carries, a breadcrumb of pickers:
 * the storming › its timeline (すべて, or one main flow; none for a storming with one) — then the exceptions' layer over
 * it (`ExceptionToggle`), and the level. Every change goes through `onView` (with the exception emphasized: a change
 * of the storming or the timeline ends it).
 */
export function StormingToolbar({
    stormings,
    choice,
    focus,
    mode,
    onView,
}: {
    stormings: readonly StormingView[];
    choice: StormingChoice;
    focus: StormingFocus | null;
    mode: DisplayMode;
    onView: (view: ScopeView) => void;
}) {
    const t = useT();
    const shown = shownStorming(stormings, choice);
    if (!shown) return null;
    const { storming, options, main } = shown;
    const flows = mainFlowsOf(storming);
    return (
        <ToolbarSubject>
            <nav className="subject-crumbs" aria-label={t.views.storming}>
                <SubjectPicker
                    label={t.stormingPicker}
                    value={storming.id}
                    options={stormings.map((s) => ({ value: s.id, label: nameIn(mode, s.id, s.label) }))}
                    onChange={(id) => onView({ choice: chooseStorming(choice, id), focus: null })}
                />
                {flows.length > 1 && (
                    <>
                        <ChevronRight className="subject-sep" size={14} aria-hidden />
                        <SubjectPicker
                            label={t.timelineFilter}
                            value={main?.id ?? ''}
                            options={[{ value: '', label: t.allTimelines }, ...flows.map((f) => ({ value: f.id, label: nameIn(mode, f.id, f.label) }))]}
                            onChange={(id) => onView({ choice: chooseTimeline(choice, storming.id, id || undefined), focus: null })}
                        />
                    </>
                )}
            </nav>
            <ExceptionToggle stormings={stormings} choice={choice} focus={focus} mode={mode} onView={onView} />
            <LevelSwitch
                label={t.stormingLevel}
                levels={VIEW_LEVELS}
                value={options.level}
                icons={LEVEL_ICONS}
                names={(l) => ({ label: t.stormingLevels[l].label, tooltip: `${t.stormingLevels[l].label} — ${t.stormingLevels[l].hint}` })}
                onChange={(level) => onView({ choice: { ...choice, level }, focus })}
            />
        </ToolbarSubject>
    );
}

/**
 * The exceptions' layer over the canvas (ADR 0032 §11), apart from the breadcrumb in its look (round, in the
 * exceptions' pink): ↳ 例外 and how many it lays over the canvas (those branching off the main flow shown). Its left
 * part includes them or not; its ▾ emphasizes one (included first), which the toggle then names, with its × to end
 * the emphasis. None for a storming without exceptions.
 */
export function ExceptionToggle({
    stormings,
    choice,
    focus,
    mode,
    onView,
}: {
    stormings: readonly StormingView[];
    choice: StormingChoice;
    focus: StormingFocus | null;
    mode: DisplayMode;
    onView: (view: ScopeView) => void;
}): ReactNode {
    const t = useT();
    const shown = shownStorming(stormings, choice);
    const layer = exceptionLayer(stormings, choice);
    if (!shown || !layer) return null;
    const { storming, main } = shown;
    const emphasized = shownFocus(stormings, choice, focus);
    const timeline = (id: string): StormingView['timelines'][number] | undefined => storming.timelines.find((x) => x.id === id);
    const named = (id: string): string => nameIn(mode, id, timeline(id)?.label);
    const byStage = !main && (storming.stages?.length ?? 0) > 0;
    const stageName = (id: string | undefined): string | undefined => {
        const st = byStage && id !== undefined ? storming.stages?.find((s) => s.id === id) : undefined;
        return st && nameIn(mode, st.id, st.label);
    };
    const options = layer.exceptions.map((id) => ({
        value: id,
        label: named(id),
        group: stageName(timeline(id)?.stageId),
        icon: <CornerDownRight className="exception-mark" size={12} aria-hidden />,
    }));
    const pick = (id: string): void => onView({ ...focusOn(stormings, choice, storming.id, id), frame: { exception: id } });
    const caret = (
        <span className="toolbar-caret" aria-hidden>
            ▾
        </span>
    );
    const state = emphasized !== undefined ? ' focus' : layer.included ? ' on' : '';
    return (
        <div className={`exception-layer${state}`} role="group" aria-label={t.exceptionLayer.label}>
            {emphasized !== undefined ? (
                <>
                    <MenuPicker
                        className="exception-layer-pick"
                        buttonClass="exception-layer-main"
                        label={t.exceptionLayer.label}
                        value={emphasized}
                        options={options}
                        onChange={pick}
                    >
                        <CornerDownRight size={13} aria-hidden />
                        <span className="toolbar-button-text">{t.exceptionLayer.focused(named(emphasized))}</span>
                        {caret}
                    </MenuPicker>
                    <button
                        className="icon-button exception-layer-clear"
                        aria-label={t.exceptionLayer.unfocus}
                        data-tooltip={t.exceptionLayer.unfocus}
                        onClick={() => onView({ choice, focus: null })}
                    >
                        <X size={13} aria-hidden />
                    </button>
                </>
            ) : (
                <>
                    <button
                        className="exception-layer-main"
                        aria-pressed={layer.included}
                        onClick={() => onView({ choice: withExceptions(choice, !layer.included), focus: null })}
                    >
                        <CornerDownRight size={13} aria-hidden />
                        {t.exceptionLayer.label}
                        <span className="exception-layer-count">{layer.exceptions.length}</span>
                    </button>
                    {options.length > 0 && (
                        <MenuPicker
                            className="exception-layer-pick"
                            buttonClass="exception-layer-drop"
                            buttonLabel={t.exceptionLayer.pick}
                            tooltip={t.exceptionLayer.pick}
                            label={t.exceptionLayer.label}
                            value={undefined}
                            options={options}
                            onChange={pick}
                        >
                            {caret}
                        </MenuPicker>
                    )}
                </>
            )}
        </div>
    );
}

/**
 * The storming's 絞り込み: what it can hide in the view shown (`filterableIn`) — 「解決済みを表示」 when the storming has a
 * resolved hotspot; no button without it. The exceptions are the layer's toggle, not a narrowing.
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
    const kinds = shown ? filterableIn(shown.storming) : [];
    if (!kinds.length) return null;
    const hidden = shownHidden(stormings, choice);
    const names: Record<Hideable, string> = { exceptions: '', resolvedHotspots: t.showResolvedHotspots };
    const count = kinds.filter((k) => hidden.has(k)).length;
    return (
        <FilterPopover count={activeFilterCount({ view: 'storming', hidden: count })} onClear={() => onChange(clearStormingFilter(choice))}>
            <FilterSection title={t.filters.shown}>
                {kinds.map((kind) => (
                    <label key={kind} className="check">
                        <input type="checkbox" checked={!hidden.has(kind)} onChange={(e) => onChange(withHidden(choice, kind, !e.target.checked))} />
                        {names[kind]}
                    </label>
                ))}
            </FilterSection>
        </FilterPopover>
    );
}

/** The storming's 絞り込み cleared: what it hides shown again (the exceptions' layer as it is). */
export const clearStormingFilter = (choice: StormingChoice): StormingChoice =>
    HIDEABLE.filter((k) => k !== 'exceptions').reduce((c, k) => withHidden(c, k, false), choice);

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
 * their flows. The connections it has are the lines the canvas draws thicker around the selection.
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
    knowledge,
    copies,
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
    /** The knowledge about a sticky (`<Storming>.<Local>`), in a session with a knowledge store. */
    knowledge?: ((sticky: string) => ReactNode) | undefined;
    /** The steps through the copies of a sticky drawn more than once on the canvas (「同じ付箋 n 件 ◀ k/n ▶」). */
    copies?: ((elementId: string) => ReactNode) | undefined;
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
                {isNote && copies?.(selected)}
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
                {isNote && declaration.kind !== 'hotspot' && <HotspotsRow storming={storming} subject={declaration.id} link={link} />}
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
                {isNote && knowledge?.(`${storming.id}.${declaration.id}`)}
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

/**
 * The hotspots on a sticky, open and resolved, whatever the 絞り込み hides of them (hidden on the canvas, the sticky's check stands for them):
 * each a link to it, a resolved one's check telling what was agreed.
 */
function HotspotsRow({ storming, subject, link }: { storming: Storming; subject: string; link: (id: string) => ReactNode }): ReactNode {
    const t = useT();
    const byId = firstDeclarations(storming);
    const on = buildSemanticGraph(storming)
        .edges.filter((e) => e.kind === 'hotspot-on' && e.targetId === subject)
        .flatMap((e) => {
            const d = byId.get(e.sourceId);
            return d?.kind === 'hotspot' ? [d] : [];
        });
    if (!on.length) return null;
    return (
        <Row icon={MessageCircleQuestionMark} label={t.esKinds.hotspot}>
            <ul className="es-list">
                {on.map((h) => {
                    const resolution = hotspotResolved(h.clauses) ? (h.clauses.find((c) => c.type === 'resolution')?.text ?? '') : undefined;
                    const tip = resolution === undefined ? undefined : t.resolvedHotspotTip(resolution);
                    return (
                        <li key={h.id}>
                            {link(h.id)}
                            {tip !== undefined && (
                                <span className="es-hotspot-resolved" role="img" aria-label={tip} {...{ [TOOLTIP_ATTR]: tip }}>
                                    <CircleCheck size={13} aria-hidden />
                                </span>
                            )}
                        </li>
                    );
                })}
            </ul>
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
