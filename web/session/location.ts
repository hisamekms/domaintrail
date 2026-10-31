// Where a participant is looking (ADR 0026, Presence): the page's view as a `ViewLocation`, and when two of them are
// the same view, so that cursors are drawn only between equal locations.
import type { ViewLocation } from '@domaintrail/collaboration/protocol';
import type { LaidOutGraph } from '@domaintrail/visualization/domain/graph/ir';
import type { ViewOptions } from '@domaintrail/visualization/domain/storming/ir';
import type { View } from '../view/navigation';

/** The `layoutKey` of a view without a laid-out graph (the catalog, a view still loading). */
export const NO_LAYOUT = '-';

/** The laid-out graph's identity: its ID and its signature (another layout of the same graph is another location). */
export const layoutKeyOf = (graph: LaidOutGraph | null | undefined): string => (graph ? `${graph.id}@${graph.signature}` : NO_LAYOUT);

/**
 * The location of the page's view. `viewKey` tells the `.dt` views apart as their cameras are (the Structure View's
 * level and focus, the context map with or without every context); a storming's location is its storming, level and
 * timeline (none: the integrated canvas).
 */
export function viewLocation(input: {
    readonly view: View;
    /** The camera key of the view (`ViewGraph.cameraKey`). */
    readonly viewKey: string;
    readonly graph: LaidOutGraph | null | undefined;
    /** The storming the Event Storming view shows, and how. */
    readonly storming: { readonly id: string; readonly options: ViewOptions } | undefined;
}): ViewLocation {
    const layoutKey = layoutKeyOf(input.graph);
    if (input.view.kind === 'storming' && input.storming) {
        const { id, options } = input.storming;
        return { kind: 'dtes', stormingId: id, level: options.level, ...(options.timelineId !== undefined && { timelineId: options.timelineId }), layoutKey };
    }
    return { kind: 'dt', viewKey: input.view.kind === 'catalog' ? 'catalog' : input.viewKey, layoutKey };
}

/** Whether two locations are the same view of the same layout: only then is a cursor of one drawn on the other. */
export function sameLocation(a: ViewLocation | undefined, b: ViewLocation | undefined): boolean {
    if (!a || !b || a.layoutKey !== b.layoutKey) return false;
    if (a.kind === 'dt') return b.kind === 'dt' && a.viewKey === b.viewKey;
    return b.kind === 'dtes' && a.stormingId === b.stormingId && a.level === b.level && a.timelineId === b.timelineId;
}

/** Whether a location draws a canvas cursors can be placed on (not the catalog, not a view still loading). */
export const hasCanvas = (location: ViewLocation): boolean => location.layoutKey !== NO_LAYOUT;
