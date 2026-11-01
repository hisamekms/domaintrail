// Votes and reactions as the page shows them (ADR 0026, appendix "Votes and reactions"), without React: the session's
// placed marks counted per target and sign, who placed them (names on hover, in a popover on a click), and whether one
// is mine; whether a vote can still change (the rules of `domain/marks.ts`, the same as the server's); the lines of the
// tooltips that keep a closed vote's counts. Everything is derived from the session's state on the page.
import { isVoteTarget, markKey, markTargetStatus, REACTIONS, type MarkStatus, type MarkTargetData } from '@domaintrail/collaboration/domain/marks';
import type { Collaboration } from '@domaintrail/collaboration/generated/index';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';

export { REACTIONS, markKey, type MarkTargetData };
export type Sign = Collaboration.MarkSign;
export type Reaction = (typeof REACTIONS)[number];

/** The marks of one sign on one target: how many, who (participant IDs, in the order they marked), and whether I am among them. */
export interface Tally {
    readonly count: number;
    readonly who: readonly string[];
    readonly mine: boolean;
}

export const NO_TALLY: Tally = { count: 0, who: [], mine: false };

/** The session's placed marks by target and sign (`markKey(target)` and the sign). */
export type MarkIndex = ReadonlyMap<string, Tally>;

const indexKey = (target: MarkTargetData, sign: Sign): string => `${sign}|${markKey(target)}`;

/** Counts the session's placed marks (a state from before marks has none). */
export function markIndex(state: Pick<SessionStateBody, 'marks'>, me: string): MarkIndex {
    const index = new Map<string, Tally>();
    for (const m of state.marks ?? []) {
        const key = indexKey(m.target, m.sign);
        const t = index.get(key) ?? NO_TALLY;
        index.set(key, { count: t.count + 1, who: [...t.who, m.participant], mine: t.mine || m.participant === me });
    }
    return index;
}

export const tallyOf = (index: MarkIndex, target: MarkTargetData, sign: Sign): Tally => index.get(indexKey(target, sign)) ?? NO_TALLY;

/** The reactions on a message or a turn that someone placed, in the fixed order. */
export function reactionsOn(index: MarkIndex, target: MarkTargetData): { readonly sign: Reaction; readonly tally: Tally }[] {
    return REACTIONS.flatMap((sign) => {
        const tally = tallyOf(index, target, sign);
        return tally.count > 0 ? [{ sign, tally }] : [];
    });
}

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

/**
 * The votes on a question's options, one line per option that got any (`label ♡ 2: Ann、Bob`), for the tooltip of the
 * answer that closed them. Empty when nobody voted.
 */
export function questionVoteLines(
    index: MarkIndex,
    run: string,
    question: { readonly id: string; readonly options: readonly { readonly id: string; readonly label: string }[] },
    nameOf: (id: string) => string,
    separator: string,
): string[] {
    return question.options.flatMap((o) => {
        const t = tallyOf(index, { kind: 'QuestionOption', run, question: question.id, option: o.id }, 'Vote');
        return t.count > 0 ? [`${o.label} ♡ ${t.count}: ${names(t, nameOf, separator)}`] : [];
    });
}

/**
 * The votes on an assumption's choices — kept as it is (`keep`), then each alternative — one line per choice that got
 * any, for the tooltip of the note of the run that picked an alternative. Empty when nobody voted.
 */
export function assumptionVoteLines(
    index: MarkIndex,
    run: string,
    assumption: number,
    alternatives: readonly { readonly id: string; readonly label: string }[],
    keep: string,
    nameOf: (id: string) => string,
    separator: string,
): string[] {
    const choices = [{ id: undefined, label: keep }, ...alternatives];
    return choices.flatMap((c) => {
        const t = tallyOf(index, { kind: 'AssumptionChoice', run, assumption, ...(c.id !== undefined && { alternative: c.id }) }, 'Vote');
        return t.count > 0 ? [`${c.label} ♡ ${t.count}: ${names(t, nameOf, separator)}`] : [];
    });
}
