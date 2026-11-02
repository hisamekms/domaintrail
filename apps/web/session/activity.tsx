// What a running run is doing (ADR 0026, amendment: what a running run is doing), in one small line: an icon of the
// phase in the accent, the phase, then what it is about — a file by its last segment (its whole path in the tooltip),
// or a command. Under the quoted messages of the running AI turn, and under the facts of the running unit in AI の作業.
// No line before the first activity (the first one is shown at once). Each activity stays ACTIVITY_HOLD_MS at least,
// the latest one coming after it; a change cross-fades in place (`useSwap`, `--motion-swap`): the part that changed
// fades out, then the new one in — only the subject when the phase stays, else the icon and the phase with it.
import { BookOpen, ListChecks, MessageSquareText, Pencil, type LucideIcon } from 'lucide-react';
import type { RunActivity, RunActivityPhase } from '@domaintrail/collaboration/protocol';
import { useHeld, useSwap } from '../shared/motion';
import { useChat } from './chat-context';

const PHASE_ICONS: Record<RunActivityPhase, LucideIcon> = {
    reading: BookOpen,
    editing: Pencil,
    checking: ListChecks,
    finishing: MessageSquareText,
};

/**
 * How long an activity stays on the line at least, in milliseconds: long enough to read it, while an agent can report
 * several a second. Not a motion: "reduce motion" makes the swap instant but keeps this pace (fewer changes is calmer).
 */
export const ACTIVITY_HOLD_MS = 1200;

/** What a subject shows: a file by its last segment; a command (checking) as it is. */
export function shownSubject(phase: RunActivityPhase, subject: string): string {
    return phase === 'checking' ? subject : (subject.split('/').filter(Boolean).at(-1) ?? subject);
}

/** The same activity: the same phase about the same subject. */
export function sameActivity(a: RunActivity, b: RunActivity): boolean {
    return a.phase === b.phase && a.subject === b.subject;
}

/** The line of a running run, once it reported an activity. */
export function ActivityLine({ run }: { run: string }) {
    const { session, tx } = useChat();
    const held = useHeld(session.activities[run], ACTIVITY_HOLD_MS, sameActivity);
    // `held` keeps its identity while it is the same activity, so the swap sees a change only when there is one
    const swap = useSwap(held);
    if (!held) return null;
    // the first activity has nothing to fade out: it is shown at once
    const activity = swap.shown ?? held;
    const swapping = swap.swapping && swap.shown !== undefined;
    const phaseSwapping = swapping && held.phase !== activity.phase;
    const Icon = PHASE_ICONS[activity.phase];
    const { subject } = activity;
    const fade = (on: boolean): string => (on ? ' swapping' : '');
    return (
        // the parts stay mounted across a change (an icon in a span of its own, the subject's span even when empty), so
        // that the new content fades in from where the old one faded out instead of appearing at once
        <span className="run-activity">
            <span className={`run-activity-icon${fade(phaseSwapping)}`}>
                <Icon size={14} aria-hidden />
            </span>
            <span className={`run-activity-phase${fade(phaseSwapping)}`}>{tx.chat.activity[activity.phase]}</span>
            <span className={`run-activity-subject${fade(swapping)}`} data-tooltip={subject}>
                {subject !== undefined && shownSubject(activity.phase, subject)}
            </span>
        </span>
    );
}
