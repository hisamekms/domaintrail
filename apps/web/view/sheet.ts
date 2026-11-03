// What a printed or exported diagram is: the line above it (its breadcrumb and the conditions it is shown in, as the
// toolbar shows them) and the name of its file. Pure: the workspace and the state view describe what they show
// (`SheetSubject`), and these say it.
import type { DisplayMode, StructureLevel, ViewLevel } from '@domaintrail/visualization';
import type { DomainModel } from '@domaintrail/modeling';
import type { StormingView } from '@domaintrail/visualization/protocol';
import type { Messages } from '../i18n';
import { nameIn } from '../model-utils';
import { hasExceptionTimelines, shownStorming, type StormingChoice } from '../storming';

/** A thing with an ID and maybe a label (a storming, a stage, a timeline, a context, an aggregate). */
export interface Named {
    id: string;
    label?: string | undefined;
}

/** The part of a storming an Event Storming view shows: everything, a stage, or one timeline. */
export type StormingScope =
    | { kind: 'all' }
    | { kind: 'stage'; stage: Named }
    | { kind: 'timeline'; timeline: Named; exception: boolean; stage?: Named | undefined };

/** What a diagram shows, as its view's toolbar sets it. */
export type SheetSubject =
    | { view: 'contextMap'; all: boolean }
    | { view: 'structure'; level: StructureLevel; /** The focused contexts (none: all of them). */ contexts: Named[] }
    | {
          view: 'storming';
          storming: Named;
          /** Absent when the storming has no timelines (the toolbar has no timeline picker). */
          scope?: StormingScope | undefined;
          level: ViewLevel;
          /** Whether the exceptions are drawn, when the storming has some and the view is not one timeline. */
          exceptions?: boolean | undefined;
      }
    | { view: 'states'; /** The aggregate: its ID (`Context.Name`), name and label. */ aggregate: Named & { name: string } };

const CRUMB = ' › ';
const CONDITION = ' · ';

/**
 * The line above a printed diagram (and an exported one, if asked): the workspace, the view and what in it is shown,
 * then the conditions it is shown in, e.g. `ws › イベントストーミング › 住民票 › コンビニでの発行 · デザインレベル · 例外を含む`.
 * Names follow the display mode, as on the screen.
 */
export function sheetHeading(workspace: string | undefined, subject: SheetSubject, t: Messages, mode: DisplayMode): string {
    const name = (x: Named): string => nameIn(mode, x.id, x.label);
    const crumbs: string[] = workspace ? [workspace] : [];
    const conditions: string[] = [];
    switch (subject.view) {
        case 'contextMap':
            crumbs.push(t.views.contextMap);
            if (subject.all) conditions.push(t.sheet.allContexts);
            break;
        case 'structure':
            crumbs.push(t.views.structure);
            if (subject.contexts.length) crumbs.push(subject.contexts.map(name).join(', '));
            conditions.push(t.sheet.structureLevels[subject.level]);
            break;
        case 'storming': {
            crumbs.push(t.views.storming, name(subject.storming));
            const scope = subject.scope;
            if (scope?.kind === 'all') crumbs.push(t.allTimelines);
            else if (scope?.kind === 'stage') crumbs.push(name(scope.stage));
            else if (scope?.kind === 'timeline') {
                const timeline = scope.exception ? t.exceptionTimeline(name(scope.timeline)) : name(scope.timeline);
                crumbs.push(scope.stage ? t.stageTimeline(name(scope.stage), timeline) : timeline);
            }
            conditions.push(t.stormingLevels[subject.level].label);
            if (subject.exceptions !== undefined) conditions.push(subject.exceptions ? t.sheet.withExceptions : t.sheet.withoutExceptions);
            break;
        }
        case 'states':
            crumbs.push(t.tabs.states, nameIn(mode, subject.aggregate.name, subject.aggregate.label));
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
            const part = !scope ? undefined : scope.kind === 'all' ? 'all' : scope.kind === 'stage' ? scope.stage.id : scope.timeline.id;
            parts.push('storming', subject.storming.id, part, subject.level);
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

/** What the Event Storming view shows for `choice` (as `shownStorming` picks it), as a sheet's subject. */
export function stormingSubject(stormings: readonly StormingView[], choice: StormingChoice): SheetSubject | undefined {
    const shown = shownStorming(stormings, choice);
    if (!shown) return undefined;
    const { storming, options } = shown;
    const stage = (id: string): Named => ({ id, label: storming.stages?.find((st) => st.id === id)?.label });
    const timeline = options.timelineId === undefined ? undefined : storming.timelines.find((tl) => tl.id === options.timelineId);
    const scope: StormingScope | undefined = !storming.timelines.length
        ? undefined
        : timeline
          ? {
                kind: 'timeline',
                timeline: { id: timeline.id, label: timeline.label },
                exception: timeline.exception === true,
                stage: timeline.stageId === undefined ? undefined : stage(timeline.stageId),
            }
          : options.stageId !== undefined
            ? { kind: 'stage', stage: stage(options.stageId) }
            : { kind: 'all' };
    return {
        view: 'storming',
        storming: { id: storming.id, label: storming.label },
        scope,
        level: options.level,
        exceptions: hasExceptionTimelines(storming) && !timeline ? options.hideExceptions !== true : undefined,
    };
}

/** What a canvas view of the workspace shows, as its toolbar sets it (none for the catalog, or nothing to show). */
export function canvasSubject(
    view: 'contextMap' | 'structure' | 'storming' | 'catalog',
    settings: { structureLevel: StructureLevel; mapAll: boolean; stormingChoice: StormingChoice },
    /** The focused contexts of the Structure View (none: every context). */
    focused: readonly string[],
    model: DomainModel | null,
    stormings: readonly StormingView[],
): SheetSubject | undefined {
    switch (view) {
        case 'contextMap':
            return { view, all: settings.mapAll };
        case 'structure':
            return {
                view,
                level: settings.structureLevel,
                contexts: focused.map((id) => ({ id, label: model?.contexts.find((c) => c.name === id)?.label })),
            };
        case 'storming':
            return stormingSubject(stormings, settings.stormingChoice);
        case 'catalog':
            return undefined;
    }
}
