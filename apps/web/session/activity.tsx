// What a running run is doing (ADR 0026, amendment: what a running run is doing), in one small line: an icon of the
// phase in the accent, the phase, then what it is about — a file by its last segment (its whole path in the tooltip),
// or a command. Under the quoted messages of the running AI turn, and under the facts of the running unit in AI の作業.
// No line before the first activity; a change replaces the line with the page's small fade.
import { BookOpen, ListChecks, MessageSquareText, Pencil, type LucideIcon } from 'lucide-react';
import type { RunActivityPhase } from '@domaintrail/collaboration/protocol';
import { useChat } from './chat-context';

const PHASE_ICONS: Record<RunActivityPhase, LucideIcon> = {
    reading: BookOpen,
    editing: Pencil,
    checking: ListChecks,
    finishing: MessageSquareText,
};

/** What a subject shows: a file by its last segment; a command (checking) as it is. */
export function shownSubject(phase: RunActivityPhase, subject: string): string {
    return phase === 'checking' ? subject : (subject.split('/').filter(Boolean).at(-1) ?? subject);
}

/** The line of a running run, once it reported an activity. */
export function ActivityLine({ run }: { run: string }) {
    const { session, tx } = useChat();
    const activity = session.activities[run];
    if (!activity) return null;
    const Icon = PHASE_ICONS[activity.phase];
    const { subject } = activity;
    return (
        // a new key per activity: the line is replaced, and fades in again
        <span key={`${activity.phase}\u0000${subject ?? ''}`} className="run-activity motion-pop motion-pop-up">
            <Icon size={14} className="run-activity-icon" aria-hidden />
            <span className="run-activity-phase">{tx.chat.activity[activity.phase]}</span>
            {subject !== undefined && (
                <span className="run-activity-subject" data-tooltip={subject}>
                    {shownSubject(activity.phase, subject)}
                </span>
            )}
        </span>
    );
}
