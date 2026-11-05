// When a session's knowledge is extracted (ADR 0031, section 3), as one pure decision over where the talk stands and
// the time now (the caller's clock):
//
// - after a person's message, once `quietMs` pass without any message;
// - right after the answerer (the AI) replies;
// - at the session's end, at once (when anything is new or held);
// - at most one extraction per `minIntervalMs` (but the end's), and one at a time: a later trigger waits, coalesced into
//   the next one, which takes every message since the previous;
// - besides, the held operations whose topic stayed quiet `settleMs` are applied without an extraction (`settle`);
// - while the extraction is switched off for the session (`off`), nothing is extracted, at the end neither; what is held
//   still settles (and is dropped at the end), and what was decided before is still sent.
//
// What an extraction then does with the messages — stop at the mechanical stage, or at the light model's, or extract —
// is the extraction's (`domain/stages.ts`), not the timing's.
//
// The answer of the AI and the person's quiet are triggers of the same extraction: whichever comes first.

export interface ExtractionTiming {
    readonly quietMs: number;
    readonly minIntervalMs: number;
}

/** Where the talk stands, as the extraction sees it. */
export interface TalkState {
    /** When the previous extraction of the session started (none yet: undefined). */
    readonly lastExtractionAt?: Date;
    /** The newest message not yet extracted, of anyone. */
    readonly lastMessageAt?: Date;
    /** Whether a person's message is among those not yet extracted. */
    readonly personWaiting: boolean;
    /** When the AI answered, if an answer is among the messages not yet extracted. */
    readonly answeredAt?: Date;
    /** When the first held operation settles (none held: undefined). */
    readonly settleAt?: Date;
    /** An extraction of the session is under way. */
    readonly running: boolean;
    /** The session ended. */
    readonly ended: boolean;
    /** The extraction of the end was made. */
    readonly endDone: boolean;
    /** The extraction is switched off for the session. */
    readonly off?: boolean;
}

export type ExtractionTrigger = 'quiet' | 'answer' | 'end';

export type TimingDecision =
    /** Extract now. */
    | { readonly kind: 'extract'; readonly trigger: ExtractionTrigger }
    /** Apply the settled held operations now (no extraction). */
    | { readonly kind: 'settle' }
    /** Decide again at `at` (unless something happens before). */
    | { readonly kind: 'wait'; readonly at: Date }
    /** Nothing to do until something happens. */
    | { readonly kind: 'idle' };

const later = (a: Date, b: Date | undefined): Date => (b && b.getTime() > a.getTime() ? b : a);

/** What to do now (see the head of this file). */
export function decideExtraction(state: TalkState, now: Date, timing: ExtractionTiming): TimingDecision {
    if (state.running) return { kind: 'idle' };
    const waiting = !state.off && (state.personWaiting || state.answeredAt !== undefined);
    if (state.ended) {
        if (state.endDone) return { kind: 'idle' };
        if (waiting) return { kind: 'extract', trigger: 'end' };
        return state.settleAt ? { kind: 'settle' } : { kind: 'idle' };
    }
    const earliest = state.lastExtractionAt && new Date(state.lastExtractionAt.getTime() + timing.minIntervalMs);
    const quietDue = !state.off && state.personWaiting && state.lastMessageAt ? new Date(state.lastMessageAt.getTime() + timing.quietMs) : undefined;
    const answerDue = state.off ? undefined : state.answeredAt;
    const due = [answerDue, quietDue].filter((d): d is Date => d !== undefined).sort((a, b) => a.getTime() - b.getTime())[0];
    const extractAt = due && later(due, earliest);
    if (extractAt && extractAt.getTime() <= now.getTime()) {
        const trigger: ExtractionTrigger = answerDue && answerDue.getTime() <= now.getTime() ? 'answer' : 'quiet';
        return { kind: 'extract', trigger };
    }
    if (state.settleAt && state.settleAt.getTime() <= now.getTime()) return { kind: 'settle' };
    const next = [extractAt, state.settleAt].filter((d): d is Date => d !== undefined).sort((a, b) => a.getTime() - b.getTime())[0];
    return next ? { kind: 'wait', at: next } : { kind: 'idle' };
}
