// Votes and reactions as the page shows them (ADR 0026, appendix "Votes and reactions"), without React: the session's
// placed marks counted per target and sign, who placed them (names on hover, in a popover on a click), and whether one
// is mine; the emoji placed on a message or a turn, in the order they first appeared, and whether another one fits
// (`MAX_REACTION_EMOJI`); whether a vote can still change (the rules of `domain/marks.ts`, the same as the server's).
// Everything is derived from the session's state on the page.
import {
    isVoteTarget,
    markKey,
    type MarkSignData,
    type MarkStatus,
    type MarkTargetData,
    markTargetStatus,
    MAX_REACTION_EMOJI,
    signKey,
    VOTE,
} from '@domaintrail/collaboration';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { DEFAULT_QUICK_REACTIONS, readEmoji } from '@domaintrail/modeling';

export { MAX_REACTION_EMOJI, markKey, readEmoji, signKey, VOTE, type MarkTargetData };
export type Sign = MarkSignData;

/** A reaction with an emoji (in the form reactions are kept). */
export const reaction = (emoji: string): Sign => ({ kind: 'Reaction', emoji });

/** The marks of one sign on one target: how many, who (participant IDs, in the order they marked), and whether I am among them. */
export interface Tally {
    readonly count: number;
    readonly who: readonly string[];
    readonly mine: boolean;
}

export const NO_TALLY: Tally = { count: 0, who: [], mine: false };

/** The session's placed marks by target (`markKey`), then by sign (`signKey`), each in the order it first appeared. */
export type MarkIndex = ReadonlyMap<string, ReadonlyMap<string, Tally>>;

/** Counts the session's placed marks (a state from before marks has none). */
export function markIndex(state: Pick<SessionStateBody, 'marks'>, me: string): MarkIndex {
    const index = new Map<string, Map<string, Tally>>();
    for (const m of state.marks ?? []) {
        const target = markKey(m.target);
        const signs = index.get(target) ?? new Map<string, Tally>();
        const key = signKey(m.sign);
        const t = signs.get(key) ?? NO_TALLY;
        signs.set(key, { count: t.count + 1, who: [...t.who, m.participant], mine: t.mine || m.participant === me });
        index.set(target, signs);
    }
    return index;
}

export const tallyOf = (index: MarkIndex, target: MarkTargetData, sign: Sign): Tally => index.get(markKey(target))?.get(signKey(sign)) ?? NO_TALLY;

/** The emoji placed on a message or a turn, in the order each first appeared (the row does not reorder as counts change). */
export function reactionsOn(index: MarkIndex, target: MarkTargetData): { readonly emoji: string; readonly tally: Tally }[] {
    return [...(index.get(markKey(target)) ?? new Map<string, Tally>())].flatMap(([key, tally]) => (key === signKey(VOTE) ? [] : [{ emoji: key, tally }]));
}

/** Whether I can react with an emoji there: it is there already, or the target has fewer than `MAX_REACTION_EMOJI` different emoji. */
export function reactionFits(index: MarkIndex, target: MarkTargetData, emoji: string): boolean {
    const placed = reactionsOn(index, target);
    return placed.some((r) => r.emoji === emoji) || placed.length < MAX_REACTION_EMOJI;
}

/** The emoji the add-reaction popover offers first: the session's (`session.quickReactions`), or the default ones. */
export const quickReactions = (state: Partial<Pick<SessionStateBody, 'quickReactions'>>): readonly string[] =>
    state.quickReactions && state.quickReactions.length > 0 ? state.quickReactions : DEFAULT_QUICK_REACTIONS;

/** Whether a target's marks can change now: reactions while the session is live, votes while their run is the latest of its requests too. */
export function markStatus(target: MarkTargetData, state: Pick<SessionStateBody, 'requests' | 'runs'>): MarkStatus {
    return markTargetStatus(target, state);
}

/** What I may do with a vote: place or move it (a participant, open), only see it (the facilitator, or closed). */
export function canVote(
    target: MarkTargetData,
    state: Pick<SessionStateBody, 'requests' | 'runs'>,
    role: 'facilitator' | 'participant',
    live: boolean,
): boolean {
    return live && role === 'participant' && isVoteTarget(target) && markStatus(target, state) === 'open';
}

/** The names of who marked, joined (`、` or `, `). */
export const names = (tally: Tally, nameOf: (id: string) => string, separator: string): string => tally.who.map(nameOf).join(separator);
