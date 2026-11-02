// What a running run is doing (ADR 0026, amendment: what a running run is doing): one of four phases, with an optional
// short subject — a file's path relative to the workspace, or a command such as `dt check`. Any agent adapter maps its
// own events onto them; the page shows the latest one and never sees the agent's output. Transient: it is not part of
// the model, never stored, and makes no event.

/** The phases, in the order a run usually goes through them (it may go back: it reads, edits, checks and edits again). */
export const RUN_ACTIVITY_PHASES = ['reading', 'editing', 'checking', 'finishing'] as const;

export type RunActivityPhase = (typeof RUN_ACTIVITY_PHASES)[number];

/** A run's current activity. */
export interface RunActivity {
    readonly phase: RunActivityPhase;
    /** The file (relative to the workspace, `/`-separated) or the command the phase is about. */
    readonly subject?: string;
}

/** Longest subject, in characters. */
export const MAX_ACTIVITY_SUBJECT = 200;

export const isActivityPhase = (v: unknown): v is RunActivityPhase => typeof v === 'string' && (RUN_ACTIVITY_PHASES as readonly string[]).includes(v);

/** A subject a page may show: not empty, one line, short, without control or bidirectional characters. */
export function isActivitySubject(v: unknown): v is string {
    return (
        typeof v === 'string' &&
        v.trim() !== '' &&
        v.length <= MAX_ACTIVITY_SUBJECT &&
        // oxlint-disable-next-line no-control-regex -- refusing the control characters is the point
        !/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/.test(v)
    );
}

/** The activity of a phase and an optional subject, or undefined when either is not one. */
export function readActivity(phase: unknown, subject: unknown): RunActivity | undefined {
    if (!isActivityPhase(phase)) return undefined;
    if (subject === undefined) return { phase };
    return isActivitySubject(subject) ? { phase, subject } : undefined;
}

/** Whether two activities say the same (the same phase and subject). */
export const sameActivity = (a: RunActivity | undefined, b: RunActivity | undefined): boolean => a?.phase === b?.phase && a?.subject === b?.subject;
