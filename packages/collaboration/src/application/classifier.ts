// Telling a session's requests from its talk (ADR 0026, amendment: messages and apply). Each chat message is classified
// once, after it is sent and without holding it up: the page shows it at once, and the facilitator learns later whether
// it reads as a request. Opt-in; when the classifier fails, times out or is unsure, the message stays applicable (the
// decision falls back to the facilitator). The results are the facilitator's only and are kept in memory: a server
// started again classifies none of the earlier messages, which are applicable then.

/** What a message reads as: a request to change the model, talk, or not known (failed, unsure, not classified). */
export type MessageKind = 'request' | 'chat' | 'unknown';

export interface Classification {
    readonly kind: MessageKind;
    /** The probability that the message is a request, when the classifier gave one. */
    readonly probability?: number;
}

/** The classifier port: the probability (0–1) that a message is a request to change the domain model. */
export interface MessageClassifier {
    classify(text: string, signal: AbortSignal): Promise<number>;
}

/** How far from the threshold a probability must be to be trusted: closer, the message is `unknown` (applicable). */
export const UNSURE_MARGIN = 0.1;

/** The kind of a message from the probability that it is a request. */
export function classificationOf(probability: number | undefined, threshold: number, margin = UNSURE_MARGIN): Classification {
    if (probability === undefined || !Number.isFinite(probability)) return { kind: 'unknown' };
    const kind: MessageKind = probability >= threshold + margin ? 'request' : probability < threshold - margin ? 'chat' : 'unknown';
    return { kind, probability };
}

/** Whether the facilitator is offered to apply a message: anything but talk. */
export const applicable = (c: Classification | undefined): boolean => c?.kind !== 'chat';

export interface Classifications {
    /** Classifies a message in the background; `onClassified` tells the result. A message already classified is not again. */
    classify(id: string, text: string): void;
    /** Every result so far, by message ID. */
    all(): Readonly<Record<string, Classification>>;
    /** Resolves once the classifications under way have ended (tests, and a server stopping). */
    settled(): Promise<void>;
}

export interface ClassificationsDeps {
    readonly classifier: MessageClassifier;
    readonly threshold: number;
    readonly timeoutMs: number;
    readonly onClassified: (id: string, classification: Classification) => void;
    /** Told why a classification failed (never the message's text). */
    readonly log: (line: string) => void;
}

export function createClassifications(deps: ClassificationsDeps): Classifications {
    const results = new Map<string, Classification>();
    const pending = new Set<Promise<void>>();
    const asked = new Set<string>();
    return {
        classify(id, text) {
            if (asked.has(id)) return;
            asked.add(id);
            const timeout = AbortSignal.timeout(deps.timeoutMs);
            const work = deps.classifier
                .classify(text, timeout)
                .then(
                    (p) => classificationOf(p, deps.threshold),
                    (e: unknown) => {
                        deps.log(`classifying a message failed: ${timeout.aborted ? 'timed out' : e instanceof Error ? e.message : String(e)}`);
                        return { kind: 'unknown' } satisfies Classification;
                    },
                )
                .then((c) => {
                    results.set(id, c);
                    deps.onClassified(id, c);
                });
            pending.add(work);
            void work.finally(() => pending.delete(work));
        },
        all: () => Object.fromEntries(results),
        settled: async () => {
            await Promise.all(pending);
        },
    };
}
