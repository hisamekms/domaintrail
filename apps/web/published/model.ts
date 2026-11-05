// The read-only page of the knowledge store's Worker (ADR 0031, section 11), without React: where the page is (its
// project, storming and level, in the query, so that a link opens the same view), the drawing a published form holds
// for a level, the stickies' names as the canvas shows them, and the date of the drawing.
import { PUBLISHED_LEVELS, type PublishedEntry, type PublishedLevel, type PublishedStorming } from '@domaintrail/knowledge';
import { nameIn, type DisplayMode, type LaidOutGraph, type Lang } from '@domaintrail/visualization';

/** What the page shows, as its query says it (`?project=…&storming=…&level=…`). */
export interface PageLocation {
    readonly project?: string;
    readonly storming?: string;
    readonly level: PublishedLevel;
}

/**
 * The level the page opens at: the Design Level, where every sticky that knowledge can be about is drawn (the Big
 * Picture draws only the events and the hotspots).
 */
export const DEFAULT_LEVEL: PublishedLevel = 'design-level';

const isLevel = (v: string | null): v is PublishedLevel => PUBLISHED_LEVELS.some((l) => l === v);

export function locationOf(search: string): PageLocation {
    const q = new URLSearchParams(search);
    const project = q.get('project') ?? undefined;
    const storming = q.get('storming') ?? undefined;
    const level = q.get('level');
    return { ...(project && { project }), ...(storming && { storming }), level: isLevel(level) ? level : DEFAULT_LEVEL };
}

export function searchOf(location: PageLocation): string {
    const q = new URLSearchParams();
    if (location.project) q.set('project', location.project);
    if (location.storming) q.set('storming', location.storming);
    if (location.level !== DEFAULT_LEVEL) q.set('level', location.level);
    const s = q.toString();
    return s ? `?${s}` : '';
}

/** The storming to show: the one asked for if it is published, else the first. */
export function shownStorming(entries: readonly PublishedEntry[], wanted: string | undefined): string | undefined {
    return entries.find((e) => e.storming === wanted)?.storming ?? entries[0]?.storming;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why a published drawing cannot be drawn: a form of another version of DomainTrail than the page's. */
export class DrawingError extends Error {}

/**
 * The drawing of a level: the Live View's laid-out graph, as `dt publish` sent it. Checked for the shape the canvas
 * reads (nodes and edges with their places), so that a form from another version of dt says so instead of drawing
 * nothing.
 */
export function drawingOf(form: PublishedStorming, level: PublishedLevel): LaidOutGraph {
    const g = form.views[level];
    if (
        !isRecord(g) ||
        typeof g.id !== 'string' ||
        !Array.isArray(g.nodes) ||
        !Array.isArray(g.edges) ||
        !isRecord(g.nodeLayout) ||
        !isRecord(g.edgeLayout) ||
        !g.nodes.every((n) => isRecord(n) && typeof n.id === 'string' && typeof n.elementId === 'string' && isRecord(n.label))
    )
        throw new DrawingError(`the drawing of ${form.storming} (${level}) is not one this page draws: publish it again with this version of dt`);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the shape the canvas reads is checked above
    return g as unknown as LaidOutGraph;
}

/** A sticky's name as the canvas shows it (`mode`), from the published stickies; the reference for one not in them. */
export function stickyNames(forms: readonly PublishedStorming[], mode: DisplayMode): (sticky: string) => string {
    const labels = new Map<string, string | undefined>(forms.flatMap((f) => f.stickies.map((s) => [s.ref as string, s.label] as const)));
    return (sticky) => {
        if (!labels.has(sticky)) return sticky;
        return nameIn(mode, sticky.slice(sticky.indexOf('.') + 1), labels.get(sticky));
    };
}

/** The date of the drawing (and its commit, short), as the page's bar says it. */
export function drawingDate(drawing: PublishedStorming['drawing'], lang: Lang): string {
    const date = drawing.at.toLocaleDateString(lang === 'ja' ? 'ja-JP' : 'en-US', { year: 'numeric', month: 'numeric', day: 'numeric' });
    return drawing.commit ? `${date} · ${drawing.commit.slice(0, 7)}` : date;
}
