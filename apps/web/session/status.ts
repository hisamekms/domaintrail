// The status column of the chat (ADR 0026, amendment): every message row and AI turn row has one slot at the right end
// of its header, as wide on every row that has a status — a turn shows its latest run's state there as a glyph and a
// word, a sent message only a link to that turn (the state is the work's, shown once); and the confirmation asked before
// a run is cancelled.
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import type { MarkState } from './cards';
import type { Tx } from './chat-context';
import type { AgentMessage } from './stream';

type RunJson = SessionStateBody['runs'][number];

/** The glyph before a state's word (running has a pulsing dot instead). */
export const STATE_GLYPH: Record<MarkState, string> = {
    queued: '…',
    running: '●',
    clarification: '?',
    question: '?',
    answered: '↩',
    done: '✓',
    partial: '◐',
    skipped: '–',
    declined: '⊘',
    failed: '✕',
    cancelled: '⊘',
};

/**
 * The state an AI turn shows in its slot: its latest run's, only where nothing else shows it (queued, running,
 * declined, failed, cancelled) — a question says so itself, and done is the rule (a mechanical revert is done).
 */
export function turnState(m: AgentMessage): MarkState | undefined {
    switch (m.kind) {
        case 'completed':
        case 'clarification':
        case 'reverted':
            return undefined;
        default:
            return m.kind;
    }
}

/** A running turn's slot: the word and how long it has run. */
export const runningLabel = (marks: Tx['chat']['marks'], time: string): string => `${marks.running} ${time}`;

/** The states a turn shows in its slot (`turnState`'s). */
const SLOT_STATES = ['queued', 'declined', 'failed', 'cancelled'] as const satisfies readonly MarkState[];

/**
 * Every text the slot can show in the current language, to size it to the longest: the word of each state a turn shows
 * there, and a running turn's with a sample of its elapsed time (m:ss up to an hour, tabular digits).
 */
export const slotLabels = (marks: Tx['chat']['marks']): string[] => [...SLOT_STATES.map((s) => marks[s]), runningLabel(marks, '00:00')];

/** What the dialog before a cancel says: its title, and for a running run that its work so far is lost. */
export interface CancelPrompt {
    readonly title: string;
    readonly lost: string | undefined;
}

/** The confirmation of cancelling a run in `state`; undefined when it cannot be cancelled (it is neither queued nor running). */
export function cancelPrompt(state: RunJson['state'], texts: Tx['chat']['cancelDialog']): CancelPrompt | undefined {
    switch (state) {
        case 'Running':
            return { title: texts.running, lost: texts.lost };
        case 'Queued':
            return { title: texts.queued, lost: undefined };
        default:
            return undefined;
    }
}
