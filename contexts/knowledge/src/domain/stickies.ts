// The workspace's stickies an extraction is given (ADR 0031, section 3), so that the extractor can say what a finding is
// about by meaning, not only among the stickies a message points at (`#`): people rarely point at one.
//
// Which stormings: those the session is looking at — the storming the facilitator's page has open (else one any page
// has open: in a session the facilitator usually drives the shared screen; when their page is on the model, where the
// others look is the next best sign) and the stormings of the session's current journey. When neither is known (no page
// on a storming, no journey naming one), every storming. Either way at most `MAX_WORKSPACE_STICKIES` stickies: the
// stormings taken whole in order — those open, then the journey's; without them, the stormings the talk points at, then
// the others in the workspace's order — and the last one cut. The list is in that order and changes only when the
// stormings or the view change, so that the prompt cache keeps it from one extraction to the next.
//
// The stickies whose label (or local ID) the talk writes out are the ones it likely speaks of without pointing at them:
// `mentionedStickies` finds them mechanically, for the items the extractor is given and as a hint to it.

/** The most stickies of the workspace one extraction is given (a few hundred: a big storming whole, a few small ones). */
export const MAX_WORKSPACE_STICKIES = 300;

/** A sticky of the workspace as the extractor is given it. */
export interface WorkspaceSticky {
    /** `<Storming>.<LocalId>`. */
    readonly ref: string;
    readonly label?: string;
    /** Its kind (`event`, `command`, `actor`, `hotspot`, …). */
    readonly kind: string;
}

/** A storming of the workspace with its stickies, in source order. */
export interface StormingStickies {
    readonly id: string;
    readonly stickies: readonly { readonly local: string; readonly label?: string; readonly kind: string }[];
}

/** What the session is looking at: the workspace's stormings, the ones open on the pages, the current journey's. */
export interface StickyFocus {
    /** Every storming of the workspace, in the workspace's order. */
    readonly stormings: readonly StormingStickies[];
    /** The stormings the facilitator's pages have open (else those any page has open). */
    readonly open: readonly string[];
    /** The stormings of the session's current journey. */
    readonly journey: readonly string[];
}

/** Which stormings were chosen: those the session looks at, or all of them for want of any. */
export type StickyBasis = 'focus' | 'all';

export interface ChosenStickies {
    readonly stickies: readonly WorkspaceSticky[];
    readonly basis: StickyBasis;
    /** The stormings given (the last one perhaps cut). */
    readonly stormings: readonly string[];
    /** The stickies of the chosen stormings left out by the cap. */
    readonly left: number;
}

/** The stickies of the stormings the session looks at, else of all; at most `cap` (see the head of this file). */
export function chooseStickies(focus: StickyFocus, targeted: readonly string[] = [], cap: number = MAX_WORKSPACE_STICKIES): ChosenStickies {
    const byId = new Map(focus.stormings.map((s) => [s.id, s]));
    const focused = [...new Set([...focus.open, ...focus.journey])].filter((id) => byId.has(id));
    const pointedAt = new Set(targeted.map((r) => r.split('.')[0]));
    const order =
        focused.length > 0
            ? focused
            : [...focus.stormings.filter((s) => pointedAt.has(s.id)), ...focus.stormings.filter((s) => !pointedAt.has(s.id))].map((s) => s.id);
    const stickies: WorkspaceSticky[] = [];
    const stormings: string[] = [];
    let left = 0;
    for (const id of order) {
        const storming = byId.get(id);
        if (!storming) continue;
        const room = Math.max(0, cap - stickies.length);
        const taken = storming.stickies.slice(0, room);
        left += storming.stickies.length - taken.length;
        if (taken.length === 0) continue;
        stormings.push(id);
        for (const s of taken) stickies.push({ ref: `${id}.${s.local}`, ...(s.label && { label: s.label }), kind: s.kind });
    }
    return { stickies, basis: focused.length > 0 ? 'focus' : 'all', stormings, left };
}

/** Shorter labels (and local IDs) than this are too common to tell a sticky by. */
const MIN_MENTION = 2;
const MIN_ID_MENTION = 4;

/** The stickies whose label or local ID one of `texts` writes out (case aside), in the list's order. */
export function mentionedStickies(stickies: readonly WorkspaceSticky[], texts: readonly string[]): readonly string[] {
    const said = texts.join('\n').toLowerCase();
    if (!said) return [];
    return stickies
        .filter((s) => {
            const label = s.label?.trim().toLowerCase();
            const local = s.ref.slice(s.ref.indexOf('.') + 1).toLowerCase();
            return (label !== undefined && label.length >= MIN_MENTION && said.includes(label)) || (local.length >= MIN_ID_MENTION && said.includes(local));
        })
        .map((s) => s.ref);
}
