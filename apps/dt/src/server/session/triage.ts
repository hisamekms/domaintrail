// The server's stage of the triage (ADR 0030, decision 4; the plan's "Stage 2: Clef"): stage 1 is recorded with the
// triage when it opens (the use case); this takes the triages that wait for stage 2 and records Clef's step — its
// verdict when a classifier is configured (`classifier`), an unknown step saying so otherwise — after which a triage job
// is due for the answerer role, or the triage is decided (Clef was sure; a 依頼 that goes to the queue is queued in the
// same transaction). One call per triage at a time; a server started again takes the triages left waiting. The message's
// text goes only to the classifier, never to a log.
import { type Collaboration, type CollaborationUseCases, clefStep, type MessageClassifier, nextStage, plainBody } from '@domaintrail/collaboration';

export interface TriageStageDeps {
    readonly session: Collaboration.SessionId;
    readonly collaboration: CollaborationUseCases;
    /** Clef, when `classifier` is configured. */
    readonly classifier?: MessageClassifier;
    /** The probability from which one of Clef's answers decides (`classifier.threshold`). */
    readonly threshold: number;
    /** How long Clef may take for a message. */
    readonly timeoutMs: number;
    /** Sends what the outbox got to the pages and the agent. */
    readonly pump: () => Promise<void>;
    readonly log: (line: string) => void;
}

export interface TriageStage {
    /** Takes the triages waiting for stage 2 (after a message was addressed, and at start). */
    kick(): void;
    /** Resolves once the calls under way have ended (tests, and a server stopping). */
    settled(): Promise<void>;
}

export function createTriageStage(deps: TriageStageDeps): TriageStage {
    const { session, collaboration: use } = deps;
    const inFlight = new Map<string, Promise<void>>();
    let scanning: Promise<void> | undefined;
    let again = false;

    const classify = async (triage: Collaboration.Triage, request: Collaboration.Request): Promise<void> => {
        // the body with its mentions as names (`#注文[1]` → `注文`, `@AI[p1]` → `AI`)
        const text = plainBody(request.body, { targets: request.targets.length, people: request.mentions.length }, true);
        const step = await clefStep(deps.classifier, text, { threshold: deps.threshold, timeoutMs: deps.timeoutMs });
        if (step.error !== undefined) deps.log(`triage ${triage.id}: Clef failed (${step.error})`);
        const recorded = await use.recordTriageStep({ triage: triage.id, step });
        // refused: the triage moved on meanwhile (the session closed, it was decided another way): nothing to do
        if (!recorded.ok) return;
        await deps.pump();
    };

    const scan = async (): Promise<void> => {
        do {
            again = false;
            const state = await use.sessionState({ session });
            if (!state.ok || state.value.session.state !== 'Open') return;
            const requests = new Map(state.value.requests.map((r) => [r.id, r]));
            for (const triage of state.value.triages) {
                if (triage.state !== 'Pending' || nextStage(triage.steps) !== 'Clef' || inFlight.has(triage.id)) continue;
                const request = requests.get(triage.request);
                if (!request) continue;
                const work = classify(triage, request)
                    .catch((e: unknown) => deps.log(`triage ${triage.id}: stage 2 failed: ${e instanceof Error ? e.message : String(e)}`))
                    .finally(() => inFlight.delete(triage.id));
                inFlight.set(triage.id, work);
            }
        } while (again);
    };

    return {
        kick() {
            if (scanning) {
                again = true;
                return;
            }
            scanning = scan()
                .catch((e: unknown) => deps.log(`triage stage 2 failed: ${e instanceof Error ? e.message : String(e)}`))
                .finally(() => (scanning = undefined));
        },
        async settled() {
            while (scanning || inFlight.size) await Promise.all([scanning, ...inFlight.values()]);
        },
    };
}
