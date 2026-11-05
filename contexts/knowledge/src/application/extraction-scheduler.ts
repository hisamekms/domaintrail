// The timing of a session's extractions put to work (ADR 0031, section 3): told when something happened (a message, an
// extractor connecting) through `kick`, it asks the pure decision (`domain/timing.ts`) what to do now, does it, and arms
// a timer for the next time it should ask. One extraction at a time: a kick during one is taken once it ends. The
// session's end runs the last extraction (or applies what is held) and resolves once it is done.
import { decideExtraction, type ExtractionTiming } from '../domain/timing.js';
import type { SessionExtraction } from './extraction.js';

/** A one-shot timer: returns its cancel. */
export interface Timers {
    set(ms: number, run: () => void): () => void;
}

export interface ExtractionSchedulerDeps {
    readonly extraction: SessionExtraction;
    readonly timing: ExtractionTiming;
    readonly now: () => Date;
    readonly timers: Timers;
    readonly log: (line: string) => void;
}

export interface ExtractionScheduler {
    /** Something happened (a message, an answer, an extractor connected): decide again. */
    kick(): void;
    /** The session ended: the last extraction, or what is held applied; resolves once done. */
    end(): Promise<void>;
    /** Stops deciding (the server stops); an extraction under way ends on its own. */
    stop(): void;
    /** Resolves once nothing runs (tests). */
    settled(): Promise<void>;
}

type Step = 'again' | 'done' | 'backoff';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createExtractionScheduler(deps: ExtractionSchedulerDeps): ExtractionScheduler {
    const { extraction, timing, timers, log } = deps;
    let running: Promise<void> | undefined;
    let again = false;
    let ended = false;
    let endDone = false;
    let stopped = false;
    let cancel: (() => void) | undefined;

    const arm = (ms: number): void => {
        cancel?.();
        cancel = timers.set(Math.max(0, ms), () => {
            cancel = undefined;
            scheduler.kick();
        });
    };

    const step = async (): Promise<Step> => {
        const talk = await extraction.talkState();
        const decision = decideExtraction({ ...talk, running: false, ended, endDone }, deps.now(), timing);
        switch (decision.kind) {
            case 'extract': {
                const outcome = await extraction.extract(decision.trigger);
                if (decision.trigger === 'end') endDone = true;
                if (outcome === 'unavailable') {
                    // no extractor connected: its connecting kicks again; at the end, what is held applies without one
                    if (ended) {
                        log('knowledge: no extractor is connected for the last extraction; the messages since the previous one are not extracted');
                        await extraction.settle(true);
                        endDone = true;
                    }
                    return 'done';
                }
                return outcome === 'store-failed' ? 'backoff' : 'again';
            }
            case 'settle': {
                await extraction.settle(ended);
                if (ended) endDone = true;
                // a store that failed leaves it pending: asked again after a while, not at once
                const after = await extraction.talkState();
                return after.settleAt && after.settleAt.getTime() <= deps.now().getTime() ? 'backoff' : 'again';
            }
            case 'wait':
                arm(decision.at.getTime() - deps.now().getTime());
                return 'done';
            case 'idle':
                return 'done';
        }
    };

    const loop = async (): Promise<void> => {
        do {
            again = false;
            let next: Step;
            try {
                next = await step();
            } catch (e) {
                log(`knowledge: the extraction failed (${message(e)})`);
                next = 'backoff';
            }
            if (next === 'again') again = true;
            if (next === 'backoff' && !stopped) arm(timing.minIntervalMs);
        } while (again && !stopped);
    };

    const scheduler: ExtractionScheduler = {
        kick() {
            if (stopped) return;
            if (running) {
                again = true;
                return;
            }
            running = loop().finally(() => {
                running = undefined;
                if (again && !stopped) scheduler.kick();
            });
        },
        async end() {
            ended = true;
            cancel?.();
            scheduler.kick();
            await scheduler.settled();
        },
        stop() {
            stopped = true;
            cancel?.();
        },
        async settled() {
            while (running) await running;
        },
    };
    return scheduler;
}
