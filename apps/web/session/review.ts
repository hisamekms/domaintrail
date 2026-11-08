// The review at the end of a run, as the card shows it (ADR 0034): what dt's rules found, by kind, and whether it was
// fixed (the server's `found` against its `left`); what the AI says it fixed and kept; and the message 見直しを頼む
// sends for what is left.
import type { Collaboration } from '@domaintrail/collaboration';
import type { Json, SendRequestBody } from '@domaintrail/collaboration/protocol';
import { mentionName } from './mentions';

export type RunReviewJson = Json<Collaboration.RunReview>;
type FindingJson = Json<Collaboration.ReviewFinding>;

/** The kinds in the order the card lists them: the pairs of a hotspot and its sticky first. */
export const REVIEW_KINDS: readonly Collaboration.ReviewFindingKind[] = ['ResolvedUnchanged', 'ChangedOpen', 'StaleWording', 'DuplicateLabel'];

/** A finding's identity, as the server compares what it found and what is left. */
const keyOf = (f: FindingJson): string =>
    JSON.stringify([f.kind, f.sticky.storming, f.sticky.element, f.other?.storming ?? '', f.other?.element ?? '', f.was ?? '']);

/** One line of the card per kind found: how many, and how many are left once the run ended. */
export interface ReviewGroup {
    readonly kind: Collaboration.ReviewFindingKind;
    readonly found: number;
    readonly left: number;
}

/** The kinds found or left, each with its counts (`found` counts what is left too, when it came up only after). */
export function reviewGroups(review: RunReviewJson): ReviewGroup[] {
    const found = new Set(review.found.map(keyOf));
    return REVIEW_KINDS.flatMap((kind) => {
        const was = review.found.filter((f) => f.kind === kind).length;
        const left = review.left.filter((f) => f.kind === kind);
        const newly = left.filter((f) => !found.has(keyOf(f))).length;
        const total = was + newly;
        return total === 0 ? [] : [{ kind, found: total, left: left.length }];
    });
}

/** Whether the card has anything to show of a review: a finding, or what the AI fixed or kept. */
export const reviewShown = (review: RunReviewJson): boolean =>
    review.found.length > 0 || review.left.length > 0 || review.fixed.length > 0 || review.kept.length > 0;

/** The stickies of what is left, each once, `<Storming>.<Element>` (both sides of a pair), at most `max`. */
export function leftStickies(review: RunReviewJson, max = 20): string[] {
    const out = new Set<string>();
    for (const f of review.left) for (const s of [f.sticky, ...(f.other ? [f.other] : [])]) out.add(`${s.storming}.${s.element}`);
    return [...out].slice(0, max);
}

/**
 * 見直しを頼む: a message to the AI replying to the run (its card continues), with the stickies of what is left as its
 * targets, mentioned in the text. A Collab session addresses it by the mention.
 */
export function reviewRequestBody(input: {
    readonly run: string;
    readonly review: RunReviewJson;
    /** A sticky's label as the canvas names it. */
    readonly label: (sticky: string) => string;
    readonly revision: string;
    readonly aiName: string;
    readonly text: (targets: string) => string;
}): SendRequestBody {
    const targets = leftStickies(input.review).map((s) => {
        const dot = s.indexOf('.');
        return {
            target: { kind: 'DtesElement' as const, storming: s.slice(0, dot), local: s.slice(dot + 1) },
            label: input.label(s),
            sourceRevision: input.revision,
        };
    });
    const mentions = targets.map((t, i) => `#${mentionName(t.label)}[${i + 1}]`).join(' ');
    return {
        targets,
        body: `@${mentionName(input.aiName)}[p1] ${input.text(mentions)}`,
        mentions: ['ai'],
        replyTo: { kind: 'Run', run: input.run },
    };
}
