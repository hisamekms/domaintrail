// What a request is about (ADR 0026, ModelTarget): built from the page's selection when the request is composed, with
// the label and the source range it has then. The workspace, a `.dt` element by model ID, a storming element
// (`es/<Storming>/<Local>`), or, only in a timeline's view, one occurrence of an event (the render node's occurrence in
// that timeline). On the integrated canvas a note is the event's definition. Render node IDs are never stored.
import type { Json } from '@domaintrail/collaboration/protocol';
import type { Collaboration } from '@domaintrail/collaboration/generated/index';
import type { DomainModel } from '@domaintrail/modeling/model/model';
import type { SourceRange as StormingRange } from '@domaintrail/modeling/storming/ir';
import type { RenderGraph } from '@domaintrail/visualization/domain/storming/ir';
import { firstDeclarations } from '@domaintrail/visualization/domain/storming/semantic';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { resolve, selectedFile, withLabel } from '../model-utils';
import { locationOf } from '../source';

export type ModelTarget = Json<Collaboration.ModelTarget>;
export type TargetRange = Json<Collaboration.SourceRange>;

/** A target as the page took it, before the revision it was seen in is added when it is sent. */
export interface TargetDraft {
    readonly target: ModelTarget;
    readonly label?: string;
    readonly range?: TargetRange;
}

export const WORKSPACE_TARGET: TargetDraft = { target: { kind: 'Workspace' } };

/** The timeline view a selection is made in: the storming and timeline it shows, its render graph. */
export interface TimelineView {
    readonly stormingId: string;
    readonly timelineId: string;
    readonly render: RenderGraph;
}

export interface SelectionContext {
    /** The selection ID (`Sales.Order`, `es/S/L`, `file:…`), if any. */
    readonly selected: string | undefined;
    readonly model: DomainModel | null;
    readonly stormings: readonly StormingView[];
    readonly sources: readonly { readonly path: string; readonly text: string }[];
    /** Set only while a timeline's view is shown: an occurrence can be targeted there and nowhere else. */
    readonly timelineView?: TimelineView;
    /** The graph node of the shape selected on the canvas (`t:…`, `e:…`, `n:…`), if one is. */
    readonly selectedNode?: string;
}

/** The step path of an occurrence as a target names it (`3`, `2.1`; `encodeOccurrencePath` of collaboration). */
export const occurrencePath = (stepPath: readonly number[]): string => stepPath.join('.');

/** Labels are keys on the server: one line, at most 512 characters. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 512);

/** A `.dt` declaration's lines as an inclusive range (its last column is the end of its last line). */
function dtRange(file: string, line: number, endLine: number, sources: SelectionContext['sources']): TargetRange {
    const text = sources.find((s) => s.path === file)?.text;
    const last = text?.split(/\r?\n/)[endLine - 1];
    return { path: file, startLine: line, startColumn: 1, endLine, endColumn: Math.max(1, last?.length ?? 1) };
}

/** A storming range (end column exclusive) as an inclusive one. */
function stormingRange(r: StormingRange): TargetRange {
    const sameLine = r.start.line === r.end.line;
    const end = Math.max(1, r.end.column - 1);
    return {
        path: r.file,
        startLine: r.start.line,
        startColumn: r.start.column,
        endLine: r.end.line,
        endColumn: sameLine ? Math.max(r.start.column, end) : end,
    };
}

/** The target of the selection, or `undefined` when it names nothing a request can be about (a file, a context). */
export function targetOfSelection(ctx: SelectionContext): TargetDraft | undefined {
    const { selected } = ctx;
    if (!selected || selectedFile(selected)) return undefined;
    if (selected.startsWith('es/')) return stormingTarget(ctx, selected);
    if (!ctx.model) return undefined;
    const r = resolve(ctx.model, selected);
    if (!r || r.kind === 'context') return undefined;
    const named = r.kind === 'element' ? r.el : r.kind === 'state' ? r.state : r.command;
    const label = r.kind === 'element' ? withLabel({ name: r.el.id, label: r.el.label }) : withLabel({ name: selected, label: named.label });
    const at = locationOf(ctx.model, selected);
    return {
        target: { kind: 'DtElement', element: selected },
        label: oneLine(label),
        ...(at && { range: dtRange(at.file, at.line, at.endLine, ctx.sources) }),
    };
}

function stormingTarget(ctx: SelectionContext, selected: string): TargetDraft | undefined {
    const [, stormingId, localId] = selected.split('/');
    if (!stormingId || !localId) return undefined;
    const view = ctx.stormings.find((s) => s.id === stormingId);
    const declaration = view && firstDeclarations(view.storming).get(localId);
    if (!declaration) return undefined;
    const label = oneLine(`${stormingId} / ${withLabel({ name: localId, label: declaration.label })}`);
    const range = stormingRange(declaration.range);
    const occurrence = occurrenceOf(ctx, stormingId, localId);
    if (occurrence) {
        return {
            target: {
                kind: 'DtesOccurrence',
                storming: stormingId,
                timeline: occurrence.timelineId,
                eventName: localId,
                occurrence: occurrencePath(occurrence.stepPath),
            },
            label: oneLine(`${label} @ ${occurrence.timelineId} #${occurrence.stepPath.map((i) => i + 1).join('.')}`),
            range,
        };
    }
    return { target: { kind: 'DtesElement', storming: stormingId, local: localId }, label, range };
}

/** The occurrence of the selected note in the timeline shown, when the view is a timeline's and the note is an event of it. */
function occurrenceOf(ctx: SelectionContext, stormingId: string, eventId: string): { timelineId: string; stepPath: number[] } | undefined {
    const tv = ctx.timelineView;
    if (!tv || tv.stormingId !== stormingId || !ctx.selectedNode) return undefined;
    const node = tv.render.nodes.find((n) => n.id === ctx.selectedNode);
    if (node?.type !== 'event' || node.eventId !== eventId) return undefined;
    return node.occurrences.find((o) => o.timelineId === tv.timelineId);
}

/** A key equal for equal targets (to compare a draft's target with the selection). */
export function targetKey(t: ModelTarget): string {
    switch (t.kind) {
        case 'Workspace':
            return `workspace:${t.scope ?? ''}`;
        case 'DtElement':
            return `dt:${t.element}`;
        case 'DtesElement':
            return `dtes:${t.storming}/${t.local}`;
        case 'DtesOccurrence':
            return `occ:${t.storming}/${t.timeline}/${t.eventName}#${t.occurrence}`;
    }
}

/** The selection ID that shows a target: the element, or for an occurrence its event. */
export function selectionOf(t: ModelTarget): string | undefined {
    switch (t.kind) {
        case 'Workspace':
            return undefined;
        case 'DtElement':
            return t.element;
        case 'DtesElement':
            return `es/${t.storming}/${t.local}`;
        case 'DtesOccurrence':
            return `es/${t.storming}/${t.eventName}`;
    }
}

/** The render node that draws an occurrence in a timeline's view (its event node with that step path). */
export function occurrenceNode(render: RenderGraph, t: Extract<ModelTarget, { kind: 'DtesOccurrence' }>): string | undefined {
    return render.nodes.find(
        (n) =>
            n.type === 'event' &&
            n.eventId === t.eventName &&
            n.occurrences.some((o) => o.timelineId === t.timeline && occurrencePath(o.stepPath) === t.occurrence),
    )?.id;
}
