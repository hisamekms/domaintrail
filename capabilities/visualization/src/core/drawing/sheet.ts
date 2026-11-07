// What a printed or exported diagram is: the line above it (its breadcrumb and the conditions it is shown in, as the
// Live View's toolbar shows them) and the name of its file. Pure: the caller describes what the diagram shows
// (`SheetSubject`), and these say it.
import { shownLabel, type DisplayMode, type StructureLevel } from '../graph/ir.js';
import { mainFlows } from '../storming/flows.js';
import { hides, type ViewLevel, type ViewOptions } from '../storming/ir.js';
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

/** The timeline an Event Storming view's canvas carries: every flow, or one main flow. */
export type StormingScope = { kind: 'all' } | { kind: 'timeline'; timeline: Named };

/** What a diagram shows, as its view's toolbar sets it. */
export type SheetSubject =
    | { view: 'contextMap'; all: boolean }
    | { view: 'structure'; level: StructureLevel; /** The focused contexts (none: all of them). */ contexts: Named[] }
    | {
          view: 'storming';
          storming: Named;
          /** Absent when the storming has one main flow at most (the toolbar has no timeline picker). */
          scope?: StormingScope | undefined;
          level: ViewLevel;
          /** Whether the exceptions' layer is included, when the storming has exceptions. */
          exceptions?: boolean | undefined;
      }
    | { view: 'states'; /** The aggregate: its ID (`Context.Name`), name and label. */ aggregate: Named & { name: string } };

const CRUMB = ' › ';
const CONDITION = ' · ';

/**
 * The line above a printed diagram (and an exported one, if asked): the workspace, the world, the view and what in it
 * is shown, then the conditions it is shown in, e.g. `ws › ドメインモデル › 構造図 · 詳細` or
 * `ws › イベントストーミング › 住民票 › すべて · デザインレベル · 例外を含む` (the storming world has one view).
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
            else if (scope?.kind === 'timeline') crumbs.push(name(scope.timeline));
            conditions.push(t.stormingLevels[subject.level].label);
            if (subject.exceptions !== undefined) conditions.push(subject.exceptions ? t.sheet.withExceptions : t.sheet.withoutExceptions);
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
            const part = !scope ? undefined : scope.kind === 'all' ? 'all' : scope.timeline.id;
            parts.push('storming', subject.storming.id, part, subject.level, subject.exceptions === false ? 'without-exceptions' : undefined);
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
 * What an Event Storming view of `storming` shows with `options` (its level and whether the exceptions are laid out)
 * and `main` (the main flow on its canvas; none: すべて), as a sheet's subject.
 */
export function stormingSheetSubject(storming: StormingOutline, options: ViewOptions, main?: Named): SheetSubject {
    const flows = mainFlows(storming.timelines, storming.stages);
    const exceptions = storming.timelines.some((t) => t.exception);
    return {
        view: 'storming',
        storming: { id: storming.id, label: storming.label },
        scope: flows.length < 2 ? undefined : main ? { kind: 'timeline', timeline: { id: main.id, label: main.label } } : { kind: 'all' },
        level: options.level,
        exceptions: exceptions ? !hides(options, 'exceptions') : undefined,
    };
}
