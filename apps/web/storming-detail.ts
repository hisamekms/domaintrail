// What the detail of a storming element shows besides the canvas (docs/plans/layout.md, step 5), without React: the
// places of an event outside the view shown, what Design Level would show of it at Big Picture, and its problems in
// plain words. The connections the canvas draws are not repeated here (the canvas draws the lines joined to the selection thicker, `joinedEdges`).
import type { Diagnostic } from '@domaintrail/kernel';
import { buildSemanticGraph, type NodeElementKind, stormingStages, stormingTimelines, timelineOccurrences, type Storming } from '@domaintrail/storming';
import type { RenderGraph } from '@domaintrail/visualization';

/** A timeline an event occurs in, outside the view shown: opening it shows the event there. */
export interface OtherPlace {
    readonly timelineId: string;
    /** The stage the timeline is in, if any. */
    readonly stageId?: string;
    readonly exception: boolean;
}

/**
 * The timelines an event occurs in that the view shown does not draw it in: another stage or timeline, or an exception
 * hidden by the filter (`render`: the render graph of the view shown, when it is a view of this storming; without it,
 * every timeline of the event is elsewhere). Each timeline once, in declaration order.
 */
export function otherPlaces(storming: Storming, eventId: string, render: RenderGraph | undefined): OtherPlace[] {
    const shown = new Set((render?.nodes ?? []).flatMap((n) => (n.type === 'event' && n.eventId === eventId ? n.occurrences.map((o) => o.timelineId) : [])));
    const stageOf = new Map(stormingStages(storming).flatMap((st) => st.timelines.map((tl) => [tl.id, st.id] as const)));
    return stormingTimelines(storming).flatMap((tl) => {
        if (shown.has(tl.id) || !timelineOccurrences(tl).some((o) => o.eventId === eventId)) return [];
        const stageId = stageOf.get(tl.id);
        return [{ timelineId: tl.id, ...(stageId !== undefined && { stageId }), exception: tl.exception === true }];
    });
}

/**
 * What Design Level draws around an event: the commands that cause it (each with who issues it, `by`), and what reacts
 * to it: the policies, and the commands whose issuer reacts to it (a command's `on`, ADR 0032 §14).
 */
export interface HiddenConnections {
    readonly causes: readonly { readonly command: string; readonly actors: readonly string[] }[];
    readonly reactions: readonly string[];
}

/** An event's connections that only Design Level draws; undefined when it has none. */
export function hiddenConnections(storming: Storming, eventId: string): HiddenConnections | undefined {
    const edges = buildSemanticGraph(storming).edges;
    const causes = edges
        .filter((e) => e.kind === 'emits' && e.targetId === eventId)
        .map((e) => ({ command: e.sourceId, actors: edges.filter((a) => a.kind === 'by' && a.targetId === e.sourceId).map((a) => a.sourceId) }));
    const reactions = edges.filter((e) => (e.kind === 'on' || e.kind === 'command-on') && e.sourceId === eventId).map((e) => e.targetId);
    return causes.length > 0 || reactions.length > 0 ? { causes, reactions } : undefined;
}

/** A problem in plain words: a short sentence for the codes that have one, else the checker's message (its code is the tooltip). */
export const problemText = (d: Pick<Diagnostic, 'code' | 'message'>, plain: Readonly<Record<string, string>>): string => plain[d.code] ?? d.message;

/** The actions that begin a message about a note: ask the AI, add a question (an event), tell the resolution (an open hotspot). */
export type BeginAction = 'ask' | 'question' | 'resolve';

/** The actions a note of `kind` offers (`resolved`: a resolved hotspot, whose resolution is told already). */
export function beginActions(kind: NodeElementKind, resolved: boolean): BeginAction[] {
    return ['ask', ...(kind === 'event' ? (['question'] as const) : []), ...(kind === 'hotspot' && !resolved ? (['resolve'] as const) : [])];
}
