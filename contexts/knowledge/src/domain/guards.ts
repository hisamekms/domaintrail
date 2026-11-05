// The guards of an extraction (ADR 0031, section 3): extracting soon after the talk must not jump to conclusions from a
// remark in mid-talk. What an extraction proposes is sorted here, purely:
//
// - add and addSource apply at once (a wrong item costs a deletion);
// - update and conflict are held, unseen, and apply only
//   - when a later extraction — the talk has moved on: new messages came — makes the same call (`sameCall`): the later
//     operation applies, with its wording and the version it saw, and the held one is done;
//   - or when the item's topic stayed quiet for `settleMs` since the held operation's talk: no later extraction made
//     another call on the item meanwhile;
//   - at the session's end: nothing can overturn them any more;
//   otherwise they are dropped: a later extraction made another call on the same item (the newer one is held instead).
//
// "The same call" is the same kind of operation on the same item, finding the same kind of thing about the same time
// (`labels.kind` and `labels.when`), about at least one same sticky (or about none, both). The text is not compared: the
// model words a finding anew each time.
import type { Knowledge } from '../generated/index.js';

/** An operation that waits for its guard. */
export type HeldKind = Extract<Knowledge.Operation, { readonly kind: 'Update' | 'Conflict' }>;

/** A held operation: the extraction that proposed it, and when its talk was (the newest message that extraction saw). */
export interface HeldOperation {
    readonly operation: HeldKind;
    readonly heldIn: number;
    readonly heldAt: Date;
}

/** Why a held operation was let go: applied (`confirmed`, `settled`, `ended`), or `superseded` (dropped). */
export type HeldOutcome = 'confirmed' | 'settled' | 'ended' | 'superseded';

export interface GuardDecision {
    /** What to send to the store now, in order. */
    readonly apply: readonly Knowledge.Operation[];
    /** What stays held. */
    readonly hold: readonly HeldOperation[];
    /** The held operations let go, and why (`superseded` ones are dropped; the others are in `apply`). */
    readonly released: readonly { readonly held: HeldOperation; readonly outcome: HeldOutcome }[];
    /** Proposed operations dropped: a second call on an item this extraction already made one on. */
    readonly duplicates: readonly HeldKind[];
}

export interface GuardInput {
    /** What this extraction proposes, in order. */
    readonly proposed: readonly Knowledge.Operation[];
    /** What earlier extractions hold. */
    readonly held: readonly HeldOperation[];
    /** This extraction's number. */
    readonly number: number;
    /** The newest message this extraction saw: when its held operations' talk was. */
    readonly talkAt: Date;
    readonly now: Date;
    /** How long a topic stays quiet before a held operation on it applies (`settleSeconds`). */
    readonly settleMs: number;
    /** The session ended: whatever is held applies. */
    readonly ended: boolean;
}

const isHeldKind = (o: Knowledge.Operation): o is HeldKind => o.kind === 'Update' || o.kind === 'Conflict';

const contentOf = (o: HeldKind): Knowledge.ItemContent => (o.kind === 'Update' ? o.revised : o.content);

/** Whether two held kinds of operation make the same call (see the head of this file). */
export function sameCall(a: HeldKind, b: HeldKind): boolean {
    if (a.kind !== b.kind || a.item !== b.item) return false;
    const x = contentOf(a);
    const y = contentOf(b);
    if (x.labels.kind !== y.labels.kind || x.labels.when !== y.labels.when) return false;
    if (x.about.length === 0 || y.about.length === 0) return x.about.length === y.about.length;
    return x.about.some((s) => y.about.includes(s));
}

/** Whether a held operation's topic has been quiet long enough at `now`. */
export const settled = (held: HeldOperation, now: Date, settleMs: number): boolean => now.getTime() - held.heldAt.getTime() >= settleMs;

/** When the first of the held operations settles, if any is held. */
export function nextSettleAt(held: readonly HeldOperation[], settleMs: number): Date | undefined {
    if (held.length === 0) return undefined;
    return new Date(Math.min(...held.map((h) => h.heldAt.getTime())) + settleMs);
}

/** Sorts what an extraction proposes, with what earlier ones hold (see the head of this file). */
export function guardExtraction(input: GuardInput): GuardDecision {
    const apply: Knowledge.Operation[] = [];
    const hold: HeldOperation[] = [];
    const released: { held: HeldOperation; outcome: HeldOutcome }[] = [];
    const duplicates: HeldKind[] = [];
    const earlier = new Map(input.held.map((h) => [h.operation.item, h]));
    /** The items this extraction made a held kind of call on. */
    const called = new Set<Knowledge.KnowledgeItemId>();

    for (const operation of input.proposed) {
        if (!isHeldKind(operation)) {
            apply.push(operation);
            continue;
        }
        if (called.has(operation.item)) {
            duplicates.push(operation);
            continue;
        }
        called.add(operation.item);
        const before = earlier.get(operation.item);
        if (before) {
            earlier.delete(operation.item);
            if (before.heldIn < input.number && sameCall(before.operation, operation)) {
                released.push({ held: before, outcome: 'confirmed' });
                apply.push(operation);
                continue;
            }
            released.push({ held: before, outcome: 'superseded' });
        }
        if (input.ended) apply.push(operation);
        else hold.push({ operation, heldIn: input.number, heldAt: input.talkAt });
    }
    // the held operations this extraction made no call on: their topic is quiet
    for (const held of earlier.values()) {
        if (input.ended || settled(held, input.now, input.settleMs)) {
            released.push({ held, outcome: input.ended ? 'ended' : 'settled' });
            apply.push(held.operation);
        } else hold.push(held);
    }
    return { apply, hold, released, duplicates };
}

/** The held operations whose topic has settled at `now` (or all, the session ended): applied without an extraction. */
export function settleHeld(held: readonly HeldOperation[], now: Date, settleMs: number, ended = false): GuardDecision {
    return guardExtraction({ proposed: [], held, number: Number.MAX_SAFE_INTEGER, talkAt: now, now, settleMs, ended });
}
