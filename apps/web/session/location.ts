// Where a participant is looking (ADR 0026, Presence): the page's view as a `ViewLocation`, and when two of them are
// the same view, so that cursors are drawn only between equal locations.
import type { ViewLocation } from '@domaintrail/collaboration/protocol';
import { hides, type LaidOutGraph, type ViewOptions } from '@domaintrail/visualization';
import type { View } from '../view/navigation';

/** The `layoutKey` of a view without a laid-out graph (the catalog, a view still loading). */
export const NO_LAYOUT = '-';

/** A short hash of a text (cyrb53, 53 bits as hex): a signature is the whole layout, far longer than a key may be. */
export function shortHash(text: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** Longest graph ID kept as it is in a `layoutKey` (the server takes keys of at most 512 characters). */
const MAX_ID = 200;

/**
 * The laid-out graph's identity: its ID and a hash of its signature (another layout of the same graph is another
 * location), and its spacing when compact (「詰めて表示」 places the same graph elsewhere).
 */
export const layoutKeyOf = (graph: LaidOutGraph | null | undefined): string =>
    graph
        ? `${graph.id.length > MAX_ID ? shortHash(graph.id) : graph.id}@${shortHash(graph.signature)}${graph.spacing === 'compact' ? '~compact' : ''}`
        : NO_LAYOUT;

/**
 * The location of the page's view. `viewKey` tells the `.dt` views apart as their cameras are (the Structure View's
 * level and focus, the context map with or without every context); a storming's location is its storming, level,
 * timeline (the main flow on its canvas; none: すべて) and whether its exceptions are included — not the exception
 * emphasized, which is the reader's own (ADR 0032 §11).
 */
export function viewLocation(input: {
    readonly view: View;
    /** The camera key of the view (`ViewGraph.cameraKey`). */
    readonly viewKey: string;
    readonly graph: LaidOutGraph | null | undefined;
    /** The storming the Event Storming view shows, and how. */
    readonly storming: { readonly id: string; readonly options: ViewOptions; readonly main?: string | undefined } | undefined;
}): ViewLocation {
    const layoutKey = layoutKeyOf(input.graph);
    if (input.view.kind === 'storming' && input.storming) {
        const { id, options, main } = input.storming;
        return {
            kind: 'dtes',
            stormingId: id,
            level: options.level,
            ...(main !== undefined && { timelineId: main }),
            ...(hides(options, 'exceptions') && { exceptions: false as const }),
            layoutKey,
        };
    }
    return { kind: 'dt', viewKey: input.view.kind === 'catalog' ? 'catalog' : input.viewKey, layoutKey };
}

/** Whether two locations are the same view of the same layout: only then is a cursor of one drawn on the other. */
export function sameLocation(a: ViewLocation | undefined, b: ViewLocation | undefined): boolean {
    if (!a || !b || a.layoutKey !== b.layoutKey) return false;
    if (a.kind === 'dt') return b.kind === 'dt' && a.viewKey === b.viewKey;
    return b.kind === 'dtes' && a.stormingId === b.stormingId && a.level === b.level && a.timelineId === b.timelineId && a.exceptions === b.exceptions;
}

/** Whether a location draws a canvas cursors can be placed on (not the catalog, not a view still loading). */
export const hasCanvas = (location: ViewLocation): boolean => location.layoutKey !== NO_LAYOUT;
