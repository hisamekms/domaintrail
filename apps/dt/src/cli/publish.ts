// `dt publish` (ADR 0031, section 11): the published form of a workspace's stormings, which the knowledge store's Worker
// keeps for its read-only page. The form is what the page's canvas draws — each sticky with its label, links and place,
// as the Live View lays out the whole storming at its Big Picture and its Design Level — with the commit and date of
// the drawing. It holds the storming's own words only: no chat, no person, no file path. Pure: the views come laid
// out, the commit from git (the wiring).
import { createHash } from 'node:crypto';
import { declarations } from '@domaintrail/storming';
import { stormingViewKey } from '@domaintrail/visualization';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { type PublishedLevel, type PublishedSticky, type PublishedStorming } from '@domaintrail/knowledge';
import { stickyRef } from '@domaintrail/knowledge/protocol';

/** Why nothing is published: printed as one line, exiting with `exitCode` (2: the options; 1: the workspace). */
export class PublishError extends Error {
    constructor(
        message: string,
        readonly exitCode: 1 | 2,
    ) {
        super(message);
    }
}

/** When the drawing was made: its commit and date, or (drawn from files not committed) the time of publishing. */
export interface Drawing {
    readonly at: Date;
    readonly commit?: string;
}

/** The kinds of declaration that are not stickies: knowledge is never about them. */
const NOT_STICKIES = new Set(['timeline', 'group', 'stage']);

/** The stickies of a storming in source order, each once (its first declaration), with their labels. */
export function stickiesOf(view: StormingView): PublishedSticky[] {
    const seen = new Set<string>();
    const stickies: PublishedSticky[] = [];
    for (const d of declarations(view.storming)) {
        if (NOT_STICKIES.has(d.kind) || seen.has(d.id)) continue;
        seen.add(d.id);
        const label = d.label?.trim();
        stickies.push({ ref: stickyRef(`${view.id}.${d.id}`, 'sticky'), ...(label && { label }) });
    }
    return stickies;
}

/** JSON with the keys of every object sorted: the same drawing, the same text. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (typeof value === 'object' && value !== null)
        return `{${Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
            .join(',')}}`;
    return JSON.stringify(value) ?? 'null';
}

/** The published form of a storming laid out by the Live View's view service, drawn at `drawing`. */
export function publishedForm(view: StormingView, drawing: Drawing): PublishedStorming {
    if (view.stale) throw new PublishError(`${view.id} does not parse (${view.file}): run \`dt check\` and fix it before publishing.`, 1);
    const graphOf = (level: PublishedLevel): unknown => {
        const laidOut = view.views[stormingViewKey({ level })];
        if (!laidOut) throw new PublishError(`${view.id} has no ${level} view.`, 1);
        return laidOut.graph;
    };
    const views: PublishedStorming['views'] = { 'big-picture': graphOf('big-picture'), 'design-level': graphOf('design-level') };
    const label = view.label?.trim();
    const stickies = stickiesOf(view);
    // the version is the drawing's, not the commit's: a commit that does not change the drawing publishes nothing new
    const version = createHash('sha256')
        .update(canonical({ storming: view.id, label, stickies, views }))
        .digest('hex')
        .slice(0, 24);
    return {
        format: 1,
        storming: view.id,
        ...(label && { label }),
        version,
        drawing: { at: drawing.at, ...(drawing.commit !== undefined && { commit: drawing.commit }) },
        stickies,
        views,
    };
}

/** The stormings to publish: those named (each must exist), or all of them. */
export function chosenStormings(stormings: readonly StormingView[], names: readonly string[] | undefined): StormingView[] {
    if (!names?.length) return [...stormings];
    const unknown = names.filter((n) => !stormings.some((s) => s.id === n));
    if (unknown.length)
        throw new PublishError(
            `Unknown storming ${unknown.map((n) => `'${n}'`).join(', ')}. Stormings: ${stormings.map((s) => s.id).join(', ') || '(none)'}`,
            1,
        );
    return stormings.filter((s) => names.includes(s.id));
}
