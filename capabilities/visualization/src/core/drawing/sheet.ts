// What a printed or exported diagram is: the line above it (its breadcrumb and the conditions it is shown in, as the
// Live View's toolbar shows them) and the name of its file. Pure: the caller describes what the diagram shows
// (`SheetSubject`), and these say it.
import { shownLabel, type DisplayMode, type StructureLevel } from '../graph/ir.js';
import type { StormingFlow, ViewLevel, ViewOptions } from '../storming/ir.js';
import type { DiagramTexts } from './texts.js';

/**
 * A name in the given display mode. A label missing, empty or only whitespace counts as none (`shownLabel`): the name
 * stands in for it, and 両方 shows the name alone.
 */
export const nameIn = (mode: DisplayMode, name: string, label?: string): string => {
    const shown = shownLabel(label);
    return mode === 'name' || !shown ? name : mode === 'label' ? shown : `${shown} (${name})`;
};

/** A thing with an ID and maybe a label (a storming, a stage, a timeline, a context, an aggregate). */
export interface Named {
    id: string;
    label?: string | undefined;
}

/** The place of a storming with stages an Event Storming view shows: the whole storming, or a stage. */
export type StormingScope = { kind: 'all' } | { kind: 'stage'; stage: Named };

/** The flow an Event Storming view draws, as its view bar's flow switch shows it. */
export type SheetFlow =
    | { kind: 'main' }
    | { kind: 'all' }
    | { kind: 'exception'; timeline: Named }
    /** One main flow. */
    | { kind: 'mainFlow'; timeline: Named };

/** What a diagram shows, as its view's toolbar sets it. */
export type SheetSubject =
    | { view: 'contextMap'; all: boolean }
    | { view: 'structure'; level: StructureLevel; /** The focused contexts (none: all of them). */ contexts: Named[] }
    | {
          view: 'storming';
          storming: Named;
          /** Absent when the storming has no stages (the toolbar names the storming only). */
          scope?: StormingScope | undefined;
          level: ViewLevel;
          /** Absent when the place has no flows to choose from (no exceptions, and not one main flow chosen). */
          flow?: SheetFlow | undefined;
      }
    | { view: 'states'; /** The aggregate: its ID (`Context.Name`), name and label. */ aggregate: Named & { name: string } };

const CRUMB = ' › ';
const CONDITION = ' · ';

/**
 * The line above a printed diagram (and an exported one, if asked): the workspace, the world, the view and what in it
 * is shown, then the conditions it is shown in, e.g. `ws › ドメインモデル › 構造図 · 詳細` or
 * `ws › イベントストーミング › 住民票 › コンビニでの発行 · デザインレベル · 例外を含む` (the storming world has one view).
 * Names follow the display mode, as on the screen.
 */
export function sheetHeading(workspace: string | undefined, subject: SheetSubject, t: DiagramTexts, mode: DisplayMode): string {
    const name = (x: Named): string => nameIn(mode, x.id, x.label);
    const crumbs: string[] = workspace ? [workspace] : [];
    const conditions: string[] = [];
    switch (subject.view) {
        case 'contextMap':
            crumbs.push(t.worlds.model, t.views.contextMap);
            if (subject.all) conditions.push(t.sheet.allContexts);
            break;
        case 'structure':
            crumbs.push(t.worlds.model, t.views.structure);
            if (subject.contexts.length) crumbs.push(subject.contexts.map(name).join(', '));
            conditions.push(t.sheet.structureLevels[subject.level]);
            break;
        case 'storming': {
            crumbs.push(t.worlds.storming, name(subject.storming));
            const scope = subject.scope;
            if (scope?.kind === 'all') crumbs.push(t.allTimelines);
            else if (scope?.kind === 'stage') crumbs.push(name(scope.stage));
            conditions.push(t.stormingLevels[subject.level].label);
            const flow = subject.flow;
            if (flow) {
                conditions.push(
                    flow.kind === 'exception'
                        ? t.flows.exception(name(flow.timeline))
                        : flow.kind === 'mainFlow'
                          ? t.flows.mainFlow(name(flow.timeline))
                          : t.flows[flow.kind],
                );
            }
            break;
        }
        case 'states':
            crumbs.push(t.worlds.model, t.tabs.states, nameIn(mode, subject.aggregate.name, subject.aggregate.label));
            break;
    }
    return [crumbs.join(CRUMB), ...conditions].join(CONDITION);
}

/** A part of a file name: letters (of any script), digits, `_` and `.` kept, anything else a `-`. */
export const slug = (part: string): string =>
    part
        .replace(/[^\p{L}\p{N}_.]+/gu, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .replace(/-{2,}/g, '-');

/**
 * The name of an exported diagram's file, from IDs (never labels, which change with the display mode):
 * `<workspace>-<view>-<storming|contexts>-<stage|timeline>-<level>.<ext>`, the parts a view does not have left out.
 */
export function exportFileName(workspace: string | undefined, subject: SheetSubject, ext: 'png' | 'svg'): string {
    const parts: (string | undefined)[] = [workspace];
    switch (subject.view) {
        case 'contextMap':
            parts.push('context-map', subject.all ? 'all' : undefined);
            break;
        case 'structure':
            parts.push('structure', subject.contexts.map((c) => c.id).join('+') || undefined, subject.level);
            break;
        case 'storming': {
            const scope = subject.scope;
            const flow = subject.flow;
            const flowPart = !flow || flow.kind === 'all' ? undefined : flow.kind === 'main' ? 'main' : flow.timeline.id;
            parts.push('storming', subject.storming.id, !scope ? undefined : scope.kind === 'all' ? 'all' : scope.stage.id, flowPart, subject.level);
            break;
        }
        case 'states':
            parts.push('states', subject.aggregate.id);
            break;
    }
    const stem = parts
        .filter((p): p is string => p !== undefined)
        .map(slug)
        .filter(Boolean)
        .join('-');
    return `${stem || 'diagram'}.${ext}`;
}

/** What a sheet's subject needs to know of a storming: its name, its timelines and its stages. */
export interface StormingOutline {
    id: string;
    label?: string | undefined;
    timelines: readonly { id: string; label?: string | undefined; stageId?: string | undefined; exception?: true | undefined }[];
    stages?: readonly Named[] | undefined;
}

/**
 * What an Event Storming view of `storming` shows with `options` (its level and place) and `flow` (the flow its view bar
 * shows; by default the one `options` lays out: one main flow's timeline, the main flows only, or every flow), as a
 * sheet's subject.
 */
export function stormingSheetSubject(storming: StormingOutline, options: ViewOptions, flow?: StormingFlow): SheetSubject {
    const named = (x: Named | undefined, id: string): Named => ({ id, label: x?.label });
    const stage = (id: string): Named =>
        named(
            storming.stages?.find((st) => st.id === id),
            id,
        );
    const timeline = (id: string): Named =>
        named(
            storming.timelines.find((tl) => tl.id === id),
            id,
        );
    const shown: StormingFlow = flow ?? (options.timelineId !== undefined ? { main: options.timelineId } : options.flow === 'main' ? 'main' : 'all');
    const one = typeof shown === 'object' ? ('main' in shown ? shown.main : shown.exception) : undefined;
    const placeId =
        options.stageId ?? (one !== undefined && options.timelineId !== undefined ? storming.timelines.find((tl) => tl.id === one)?.stageId : undefined);
    const scope: StormingScope | undefined = !storming.stages?.length
        ? undefined
        : placeId !== undefined
          ? { kind: 'stage', stage: stage(placeId) }
          : { kind: 'all' };
    const exceptions = storming.timelines.some((tl) => tl.exception && (placeId === undefined || tl.stageId === placeId));
    const sheetFlow: SheetFlow | undefined =
        typeof shown === 'object'
            ? 'main' in shown
                ? { kind: 'mainFlow', timeline: timeline(shown.main) }
                : { kind: 'exception', timeline: timeline(shown.exception) }
            : exceptions
              ? { kind: shown }
              : undefined;
    return { view: 'storming', storming: { id: storming.id, label: storming.label }, scope, level: options.level, flow: sheetFlow };
}
