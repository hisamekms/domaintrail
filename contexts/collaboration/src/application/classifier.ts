// Stage 2 of the triage (ADR 0030, decision 4; the plan's "Stage 2: Clef"): the classifier port, and the step it gives a
// message addressed to the AI. Clef is asked three questions about the message (its body with its mentions as names);
// one answer at or above the threshold decides (`clefVerdict`), anything else is unknown and the message goes on to the
// light model. Without a classifier configured the step is still recorded, unknown with that reason: a triage job for
// the answerer role is due once a `Clef` step is recorded (`answerJobOf`). A failure or a timeout is unknown, with why.
// The message's text never reaches a log. (Clef's former role — tagging every message for the facilitator's 「AI に
// 送る」 — is gone.)
import { clefVerdict, type ClefProbabilities } from '../domain/triage.js';
import type { TriageStepInput } from './conversation.js';

/** The classifier port: Clef's probabilities for the three questions of stage 2. */
export interface MessageClassifier {
    /** The model asked (recorded with the step). */
    readonly model?: string;
    classify(text: string, signal: AbortSignal): Promise<ClefProbabilities>;
}

/** The reason of a Clef step when no classifier is configured. */
export const CLEF_NOT_CONFIGURED = 'Clef は設定されていない';

const shown = (p: number): string => (Number.isFinite(p) ? p.toFixed(2) : '?');

/**
 * Stage 2 for a message (`text`: its body with its mentions as names): Clef's verdict with the probabilities as its
 * reason, unknown without a classifier, or unknown with the error when it fails or takes longer than `timeoutMs`.
 */
export async function clefStep(
    classifier: MessageClassifier | undefined,
    text: string,
    options: { readonly threshold: number; readonly timeoutMs: number; readonly now?: () => number },
): Promise<TriageStepInput> {
    if (!classifier) return { stage: 'Clef', verdict: 'Unknown', reason: CLEF_NOT_CONFIGURED, durationMs: 0 };
    const now = options.now ?? Date.now;
    const started = now();
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const model = classifier.model === undefined ? {} : { model: classifier.model };
    try {
        const p = await classifier.classify(text, timeout);
        const { verdict, confidence } = clefVerdict(p, options.threshold);
        return {
            stage: 'Clef',
            verdict,
            ...(confidence !== undefined && { confidence }),
            reason: `相談 ${shown(p.consultation)} / 依頼 ${shown(p.changeRequest)} / 不要 ${shown(p.neither)}`,
            ...model,
            durationMs: now() - started,
        };
    } catch (e) {
        const error = timeout.aborted ? 'timed out' : e instanceof Error ? e.message : String(e);
        return { stage: 'Clef', verdict: 'Unknown', ...model, durationMs: now() - started, error };
    }
}
