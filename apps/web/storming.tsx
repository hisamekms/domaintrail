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
    caseInDrawing,
    type DisplayMode,
    drawsElement,
    HIDEABLE,
    type Hideable,
    hideInDrawing,
    type LaidOutGraph,
    type RenderGraph,
    type StormingFlow,
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
 * What the Event Storming view shows, all of it the page's state only: a storming, its place (the whole storming or a
 * stage: where it is looked at), the flow drawn there (ADR 0032 §11), a level, and what the 絞り込み hides.
 */
export interface StormingChoice {
    stormingId: string | undefined;
    level: ViewLevel;
    /**
     * By storming ID: its place, `@<stage ID>` for a stage (none: the whole storming). An earlier version kept a
     * timeline's ID here: read as the place of its stage, and in the storming shown without a `flow`, as its flow.
     */
    timelines: Record<string, string>;
    /**
     * The flow drawn in the storming shown (`shownFlow` checks it there). Absent: as an earlier version kept it — a
     * timeline's ID in `timelines`, the exceptions hidden — else every flow.
     */
    flow?: StormingFlow;
    /**
     * What the 絞り込み hides (its 「…を表示」 unchecked; absent: nothing), `HIDEABLE`'s kinds, in every storming where
     * they apply (`hideableIn`): left out of the drawing alone. An earlier version's `exceptions` here is read as the flow
     * 「主な流れ」.
     */
    hidden?: readonly string[];
    /** 「例外を表示」 as an earlier version kept it (false: hidden): read as the flow 「主な流れ」. */
    exceptions?: boolean;
}

/** Whether a storming has exceptions (the flow switch is then shown where it has some). */
export const hasExceptionTimelines = (storming: StormingView): boolean => storming.timelines.some((t) => t.exception);

/** Whether a storming has a resolved hotspot (the 絞り込み's 「解決済みを表示」 is then shown). */
export const hasResolvedHotspots = (storming: StormingView): boolean =>
    [...firstDeclarations(storming.storming).values()].some((d) => d.kind === 'hotspot' && hotspotResolved(d.clauses));

const isHideable = (kind: string): kind is Hideable => HIDEABLE.some((k) => k === kind);

/** What a choice hides, wherever it applies. */
export function hiddenOf(choice: StormingChoice): ReadonlySet<Hideable> {
    return new Set((choice.hidden ?? []).filter(isHideable));
}

/** Whether an earlier version hid the exceptions (its 「例外を表示」 off), which reads as the flow 「主な流れ」. */
const hidExceptions = (choice: StormingChoice): boolean =>
    choice.hidden?.includes('exceptions') === true || (choice.hidden === undefined && choice.exceptions === false);

/** The choice with `kind` hidden or shown again (what an earlier version kept of the flow is kept as it is). */
export function withHidden(choice: StormingChoice, kind: Hideable, hide: boolean): StormingChoice {
    const others = (choice.hidden ?? []).filter((k) => k !== kind);
    const { hidden: _, ...rest } = choice;
    const hidden = hide ? [...others, kind] : others;
    return hidden.length ? { ...rest, hidden } : rest;
}

/** What the 絞り込み can hide in a view of `storming`: the resolved hotspots, in any view of a storming with some. */
export function hideableIn(storming: StormingView): Hideable[] {
    return HIDEABLE.filter((k) => k === 'resolvedHotspots' && hasResolvedHotspots(storming));
}

/** What the view shown hides: what the choice hides, of what applies to it (`hideableIn`). */
export function shownHidden(stormings: readonly StormingView[], choice: StormingChoice): ReadonlySet<Hideable> {
    const shown = shownStorming(stormings, choice);
    if (!shown) return new Set();
    const hidden = hiddenOf(choice);
    return new Set(hideableIn(shown.storming).filter((k) => hidden.has(k)));
}

/** The picker's value of a stage's place (a timeline's is its ID: an ID never starts with `@`). */
export const stageChoice = (stageId: string): string => `@${stageId}`;

/** The timelines of a place of a storming (none: the whole storming), in their order. */
export function timelinesIn(storming: StormingView, stageId: string | undefined): StormingView['timelines'] {
    return storming.timelines.filter((t) => stageId === undefined || t.stageId === stageId);
}

/** The stage of a storming a place names (`@<stage ID>`), if it has it. */
const stageOf = (storming: StormingView, place: string | undefined): string | undefined =>
    place?.startsWith('@') ? storming.stages?.find((st) => stageChoice(st.id) === place)?.id : undefined;

/**
 * The flow `flow` is in a place of `storming` (`stageId`; none: the whole storming), and the place it is drawn in: one
 * main flow is drawn alone, in its stage; an exception that is not of the place, or a timeline the storming does not
 * have, is every flow again.
 */
export function placedFlow(storming: StormingView, stageId: string | undefined, flow: StormingFlow): { stageId: string | undefined; flow: StormingFlow } {
    if (typeof flow === 'string') return { stageId, flow };
    if ('main' in flow) {
        const t = storming.timelines.find((x) => x.id === flow.main && !x.exception);
        return t ? { stageId: storming.stages?.some((st) => st.id === t.stageId) ? t.stageId : undefined, flow } : { stageId, flow: 'main' };
    }
    const shown = timelinesIn(storming, stageId).some((t) => t.id === flow.exception && t.exception);
    return { stageId, flow: shown ? flow : 'all' };
}

/** The place and the flow of `storming` the choice shows (an earlier version's state read as `StormingChoice` says). */
export function shownPlace(storming: StormingView, choice: StormingChoice): { stageId: string | undefined; flow: StormingFlow } {
    const scope = choice.timelines[storming.id];
    const timeline = scope !== undefined && !scope.startsWith('@') ? storming.timelines.find((t) => t.id === scope) : undefined;
    const stageId = timeline ? (storming.stages?.some((st) => st.id === timeline.stageId) ? timeline.stageId : undefined) : stageOf(storming, scope);
    const flow: StormingFlow =
        choice.flow ?? (timeline ? (timeline.exception ? { exception: timeline.id } : { main: timeline.id }) : hidExceptions(choice) ? 'main' : 'all');
    return placedFlow(storming, stageId, flow);
}

/** The view shown: its storming (the chosen one, or the first), the view of it as the payload keys it, and its flow. */
export interface ShownStorming {
    storming: StormingView;
    options: ViewOptions;
    /** The flow drawn: one exception's case is drawn from the view of every flow (`caseInDrawing`). */
    flow: StormingFlow;
    /** Its place: a stage (none: the whole storming); one main flow's is its stage. */
    stageId: string | undefined;
}

/** The storming shown (the chosen one, or the first), the view of it as the payload keys it, and its place and flow. */
export function shownStorming(stormings: readonly StormingView[], choice: StormingChoice): ShownStorming | undefined {
    const storming = stormings.find((s) => s.id === choice.stormingId) ?? stormings[0];
    if (!storming) return undefined;
    const level = VIEW_LEVELS.includes(choice.level) ? choice.level : 'big-picture';
    const { stageId, flow } = shownPlace(storming, choice);
    const place = stageId !== undefined ? { stageId } : {};
    if (typeof flow === 'object' && 'main' in flow) return { storming, options: { level, timelineId: flow.main }, flow, stageId };
    // the main flows only: laid out without the exceptions (the integrated canvas and the stages of a storming that has some)
    const main = flow === 'main' && hasExceptionTimelines(storming) ? { flow: 'main' as const } : {};
    return { storming, options: { level, ...place, ...main }, flow, stageId };
}

/** The choice showing `stageId` (none: the whole storming) of `stormingId` with `flow`, as written (an earlier version's state dropped). */
function placed(choice: StormingChoice, stormingId: string, stageId: string | undefined, flow: StormingFlow): StormingChoice {
    const { [stormingId]: _, ...others } = choice.timelines;
    const { exceptions: __, hidden, ...rest } = choice;
    const kept = (hidden ?? []).filter(isHideable);
    return {
        ...rest,
        stormingId,
        timelines: stageId !== undefined ? { ...others, [stormingId]: stageChoice(stageId) } : others,
        flow,
        ...(kept.length && { hidden: kept }),
    };
}

/**
 * The choice showing a row of the storming navigator, or a declaration's view from a link (`scope`): '' the whole
 * storming and `@<stage ID>` a stage, each with every flow (「例外も」); a timeline's ID, an exception's case at its
 * stage, or one main flow. The navigator, the detail's links and the session's targets choose through it.
 */
export function chooseScope(stormings: readonly StormingView[], choice: StormingChoice, stormingId: string, scope: string): StormingChoice {
    const storming = stormings.find((s) => s.id === stormingId);
    const timeline = storming?.timelines.find((t) => t.id === scope);
    if (!storming || !timeline) return placed(choice, stormingId, storming && stageOf(storming, scope), 'all');
    const stageId = storming.stages?.some((st) => st.id === timeline.stageId) ? timeline.stageId : undefined;
    return placed(choice, stormingId, stageId, timeline.exception ? { exception: timeline.id } : { main: timeline.id });
}

/**
 * The choice showing another place of the storming shown (the breadcrumb's stage: `@<stage ID>`, '' the whole storming),
 * its flow kept: one main flow chosen is the main flows again, and an exception that is not of the new place every flow.
 */
export function choosePlace(stormings: readonly StormingView[], choice: StormingChoice, place: string): StormingChoice {
    const shown = shownStorming(stormings, choice);
    if (!shown) return choice;
    const stageId = stageOf(shown.storming, place);
    const flow = typeof shown.flow === 'object' && 'main' in shown.flow ? 'main' : shown.flow;
    return placed(choice, shown.storming.id, stageId, placedFlow(shown.storming, stageId, flow).flow);
}

/** The choice drawing `flow` in the storming shown, at its place (one main flow, in its stage). */
export function chooseFlow(stormings: readonly StormingView[], choice: StormingChoice, flow: StormingFlow): StormingChoice {
    const shown = shownStorming(stormings, choice);
    if (!shown) return choice;
    const at = placedFlow(shown.storming, shown.stageId, flow);
    return placed(choice, shown.storming.id, at.stageId, at.flow);
}

/** The choice showing another storming, at the place last shown of it, with every flow. */
export function chooseStorming(choice: StormingChoice, stormingId: string): StormingChoice {
    const { exceptions: _, hidden, ...rest } = choice;
    const kept = (hidden ?? []).filter(isHideable);
    return { ...rest, stormingId, flow: 'all', ...(kept.length && { hidden: kept }) };
}

/**
 * The navigator's row of the view shown (see `chooseScope`): an exception's or one main flow's timeline, else the
 * place; and the place's row, marked faintly, when the row is a timeline's.
 */
export function shownScope(stormings: readonly StormingView[], choice: StormingChoice): { stormingId: string; scope: string; place?: string } | undefined {
    const shown = shownStorming(stormings, choice);
    if (!shown) return undefined;
    const place = shown.stageId !== undefined ? stageChoice(shown.stageId) : '';
    const one = typeof shown.flow === 'object' ? ('main' in shown.flow ? shown.flow.main : shown.flow.exception) : undefined;
    return one !== undefined ? { stormingId: shown.storming.id, scope: one, place } : { stormingId: shown.storming.id, scope: place };
}

/**
 * The choice that shows `elementId` (a storming selection) where `choice` does not draw it, to move to it and select it,
 * in the view `choice` shows (callers choose the storming and the level first). One rule for whatever keeps it out of
 * the drawing (ADR 0032 §10, §11): the flow first — another exception's case when one draws it while a case is shown,
 * else every flow (「例外も」) — then the kinds the 絞り込み hides, one when that is enough, else all of them and every
 * flow. `choice` itself when the view draws it, or when nothing would (a link, the palette, a turn's marks, the
 * knowledge, the detail).
 */
export function revealIn(stormings: readonly StormingView[], choice: StormingChoice, elementId: string): StormingChoice {
    const shown = shownStorming(stormings, choice);
    if (!shown) return choice;
    const draws = (c: StormingChoice): boolean => {
        const graph = stormingDrawing(stormings, c);
        return graph !== undefined && drawsElement(graph, elementId, shownHidden(stormings, c));
    };
    if (draws(choice)) return choice;
    const cases =
        typeof shown.flow === 'object' && 'exception' in shown.flow
            ? timelinesIn(shown.storming, shown.stageId).flatMap((t) => (t.exception ? [chooseFlow(stormings, choice, { exception: t.id })] : []))
            : [];
    const every = shown.flow === 'all' ? [] : [chooseFlow(stormings, choice, 'all')];
    for (const c of [...cases, ...every, ...[...shownHidden(stormings, choice)].map((kind) => withHidden(choice, kind, false))]) if (draws(c)) return c;
    const all = clearStormingFilter(chooseFlow(stormings, choice, 'all'));
    return draws(all) ? all : choice;
}

/** The drawing and the render graph of the view laid out for the view shown (an exception's case: of every flow). */
export function stormingGraph(stormings: readonly StormingView[], choice: StormingChoice): { graph: LaidOutGraph; render: RenderGraph } | undefined {
    const shown = shownStorming(stormings, choice);
    return shown && shown.storming.views[stormingViewKey(shown.options)];
}

/**
 * `graph` (the layout of the view shown, `stormingGraph`, or its compact one) drawn as the choice draws it: an
 * exception's case without the other exceptions (`caseInDrawing`), and without what the 絞り込み hides (`hideInDrawing`).
 * Nothing moves.
 */
export function drawnAs<G extends LaidOutGraph>(stormings: readonly StormingView[], choice: StormingChoice, graph: G): G {
    const shown = shownStorming(stormings, choice);
    const render = stormingGraph(stormings, choice)?.render;
    if (!shown || !render) return graph;
    const flow = shown.flow;
    const cased = typeof flow === 'object' && 'exception' in flow ? caseInDrawing(graph, render, shown.storming.timelines, flow.exception) : graph;
    const hidden = shownHidden(stormings, choice);
    return hidden.size ? hideInDrawing(cased, hidden) : cased;
}

/** The drawing of the view shown, as the choice draws it (`drawnAs`). */
export function stormingDrawing(stormings: readonly StormingView[], choice: StormingChoice): LaidOutGraph | undefined {
    const graph = stormingGraph(stormings, choice)?.graph;
    return graph && drawnAs(stormings, choice, graph);
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
 * The Event Storming view's toolbar: its subject — the place as a breadcrumb of pickers (the storming › its stage, as the
 * navigator nests them; すべて the whole storming) and beside it the flow drawn there (`FlowSwitch`) — and its level.
 * The place is where one looks, the flow what is drawn there; neither is a filter (the 絞り込み hides, `StormingFilter`).
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
    const stages = storming.stages ?? [];
    return (
        <ToolbarSubject>
            <nav className="subject-crumbs" aria-label={t.views.storming}>
                <SubjectPicker
                    label={t.stormingPicker}
                    value={storming.id}
                    options={stormings.map((s) => ({ value: s.id, label: nameIn(mode, s.id, s.label) }))}
                    onChange={(id) => onChange(chooseStorming(choice, id))}
                />
                {stages.length > 0 && (
                    <>
                        <ChevronRight className="subject-sep" size={14} aria-hidden />
                        <SubjectPicker
                            label={t.stagePicker}
                            value={shown.stageId !== undefined ? stageChoice(shown.stageId) : ''}
                            options={[
                                { value: '', label: t.allTimelines },
                                ...stages.map((st) => ({ value: stageChoice(st.id), label: nameIn(mode, st.id, st.label) })),
                            ]}
                            onChange={(place) => onChange(choosePlace(stormings, choice, place))}
                        />
                    </>
                )}
            </nav>
            <FlowSwitch stormings={stormings} choice={choice} mode={mode} onChange={onChange} />
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
 * The flow drawn at the place shown (ADR 0032 §11), beside the breadcrumb: 主な流れ (its ▾ chooses one main flow), 例外も
 * (every exception, the default) and 例外 ▾ (one exception's case), the exceptions under their stages on the whole
 * storming. A place without exceptions but with several main flows has only 主な流れ ▾; one with neither, nothing.
 */
export function FlowSwitch({
    stormings,
    choice,
    mode,
    onChange,
}: {
    stormings: readonly StormingView[];
    choice: StormingChoice;
    mode: DisplayMode;
    onChange: (choice: StormingChoice) => void;
}): ReactNode {
    const t = useT();
    const shown = shownStorming(stormings, choice);
    if (!shown) return null;
    const { storming, flow, stageId } = shown;
    const here = timelinesIn(storming, stageId);
    const mains = here.filter((x) => !x.exception);
    const exceptions = here.filter((x) => x.exception);
    const named = (x: { id: string; label?: string | undefined }): string => nameIn(mode, x.id, x.label);
    const timeline = (id: string): StormingView['timelines'][number] | undefined => storming.timelines.find((x) => x.id === id);
    const one = typeof flow === 'object' && 'main' in flow ? timeline(flow.main) : undefined;
    const exception = typeof flow === 'object' && 'exception' in flow ? timeline(flow.exception) : undefined;
    // on the whole storming, its timelines under their stages
    const byStage = stageId === undefined && (storming.stages?.length ?? 0) > 0;
    const group = (x: StormingView['timelines'][number]): string | undefined => {
        const st = byStage && x.stageId !== undefined ? storming.stages?.find((s) => s.id === x.stageId) : undefined;
        return st && named(st);
    };
    const set = (f: StormingFlow): void => onChange(chooseFlow(stormings, choice, f));
    const mainLabel = one ? t.flows.mainFlow(named(one)) : t.flows.main;
    const mainOptions = [{ value: '', label: t.allMainFlows }, ...mains.map((m) => ({ value: m.id, label: named(m), group: group(m) }))];
    const caret = (
        <span className="toolbar-caret" aria-hidden>
            ▾
        </span>
    );
    if (!exceptions.length) {
        if (mains.length < 2) return null;
        return (
            <div className="segmented small flow-switch" role="group" aria-label={t.flowSwitch}>
                <MenuPicker
                    className="flow-pick"
                    buttonClass={one ? 'active' : undefined}
                    label={t.flows.main}
                    value={one?.id ?? ''}
                    options={mainOptions}
                    onChange={(v) => set(v ? { main: v } : 'all')}
                >
                    <span className="toolbar-button-text">{mainLabel}</span>
                    {caret}
                </MenuPicker>
            </div>
        );
    }
    const mainOn = flow === 'main' || one !== undefined;
    const every = flow === 'all';
    return (
        <div className="segmented small flow-switch" role="group" aria-label={t.flowSwitch}>
            <button className={mainOn ? 'active' : ''} aria-pressed={mainOn} onClick={() => !one && set('main')}>
                <span className="toolbar-button-text">{mainLabel}</span>
            </button>
            {mains.length > 1 && (
                <MenuPicker
                    className="flow-pick"
                    buttonClass={`flow-split${mainOn ? ' active' : ''}`}
                    buttonLabel={t.chooseMainFlow}
                    tooltip={t.chooseMainFlow}
                    label={t.flows.main}
                    value={one?.id ?? (flow === 'main' ? '' : undefined)}
                    options={mainOptions}
                    onChange={(v) => set(v ? { main: v } : 'main')}
                >
                    {caret}
                </MenuPicker>
            )}
            <button className={every ? 'active' : ''} aria-pressed={every} onClick={() => set('all')}>
                {t.flows.all}
            </button>
            <MenuPicker
                className="flow-pick"
                buttonClass={exception ? 'active' : undefined}
                label={t.flows.exceptions}
                value={exception?.id}
                options={exceptions.map((x) => ({
                    value: x.id,
                    label: named(x),
                    group: group(x),
                    icon: <CornerDownRight className="flow-exception-mark" size={12} aria-hidden />,
                }))}
                onChange={(v) => set({ exception: v })}
            >
                <span className="toolbar-button-text">{exception ? t.flows.exception(named(exception)) : t.flows.exceptions}</span>
                {caret}
            </MenuPicker>
        </div>
    );
}

/**
 * The storming's 絞り込み: what it can hide in the view shown (`hideableIn`) — 「解決済みを表示」 when the storming has a
 * resolved hotspot; no button without anything to hide. Each kind hidden counts as one narrowing. The exceptions are not
 * hidden here: they are a flow (`FlowSwitch`), which 「すべて解除」 leaves as it is.
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
    const kinds = shown ? hideableIn(shown.storming) : [];
    if (!kinds.length) return null;
    const hidden = shownHidden(stormings, choice);
    const names: Record<Hideable, string> = { resolvedHotspots: t.showResolvedHotspots };
    return (
        <FilterPopover count={activeFilterCount({ view: 'storming', hidden: hidden.size })} onClear={() => onChange(clearStormingFilter(choice))}>
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

/** The storming's 絞り込み cleared: everything it hides shown again (the flow kept, an earlier version's included). */
export const clearStormingFilter = (choice: StormingChoice): StormingChoice => {
    const { hidden: _, ...rest } = choice;
    const kept = (choice.hidden ?? []).filter((k) => !isHideable(k));
    return kept.length ? { ...rest, hidden: kept } : rest;
};

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
