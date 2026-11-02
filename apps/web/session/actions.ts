// The facilitator's actions in the chat (ADR 0026, amendment: messages and apply): applying messages (one, with a
// note, or several as one run), answering a run's questions by choosing, picking another alternative of an assumption,
// approving an assumption (recorded, nothing queued), cancelling a run, and the short undo after applying (a cancel of
// the run while it is still queued). Every action queues at once: there is no tray. The server checks the role anyway.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnswerBody, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { sessionApi } from './api';
import { failure } from './parts';

type RunJson = SessionStateBody['runs'][number];

/** How long the undo after applying is offered. */
export const UNDO_MS = 6_000;

/**
 * What the facilitator chose for one question: options (by ID), and その他 — selected or not — with its own words. The
 * words are kept while その他 is not selected (choosing an option of a single-choice question deselects it), so that
 * selecting it again restores them; they are sent only while it is selected.
 */
export interface QuestionChoice {
    readonly options: readonly string[];
    /** その他 is selected: its words are part of the answer (when there are any). */
    readonly other?: boolean;
    readonly text?: string;
}

/**
 * The answer to send: the questions answered, in the reply's order; none answered: undefined. A question is answered
 * by its options, or by その他 while it is selected with words; その他 selected without words counts as not selected,
 * and words written under an unselected その他 are not sent. A single-choice question is answered by one option or by
 * its own words, never both (その他 wins: it was the last chosen, as choosing an option deselects it); a
 * multiple-choice one by any of its options and its own words together.
 */
export function answerBody(
    questions: readonly { readonly id: string; readonly multiple?: boolean }[],
    choices: Readonly<Record<string, QuestionChoice>>,
): AnswerBody | undefined {
    const answers = questions.flatMap((q) => {
        const c = choices[q.id];
        if (!c) return [];
        const text = c.other ? c.text?.trim() || undefined : undefined;
        const options = q.multiple ? [...c.options] : text ? [] : c.options.slice(0, 1);
        if (options.length === 0 && !text) return [];
        return [{ question: q.id, options, ...(text && { text }) }];
    });
    return answers.length > 0 ? { answers } : undefined;
}

/** The requests a run was given, to queue them again (an answer, another alternative). */
export const requestsOf = (run: RunJson): string[] => run.input.requests.map((r) => r.request);

export interface ChatActions {
    /** Queues the messages as one run, with the note if any; the undo is offered then. */
    apply(requests: readonly string[], note?: string): Promise<boolean>;
    /** Queues the run's requests again with the answer to its questions. */
    answer(run: RunJson, answer: AnswerBody): Promise<boolean>;
    /**
     * Queues the run's requests again with the alternative picked of one of its assumptions (by its number in the reply
     * and the alternative's key), and the note asking for it (for the agent and the people reading the chat).
     */
    pick(run: RunJson, assumption: number, alternative: string, note: string): Promise<boolean>;
    /** Approves an assumption of the run (by its number in the reply) as it is: recorded, nothing is sent to the AI. */
    approve(run: RunJson, assumption: number): Promise<boolean>;
    cancel(run: string): Promise<boolean>;
    /** The run just queued, while its undo is offered. */
    readonly undo: { readonly run: string } | undefined;
    undoNow(): void;
    dismissUndo(): void;
    readonly busy: boolean;
    readonly error: string | undefined;
}

export function useChatActions(): ChatActions {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [undo, setUndo] = useState<{ run: string } | undefined>();
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(timer.current), []);
    const offerUndo = useCallback((run: string) => {
        clearTimeout(timer.current);
        setUndo({ run });
        timer.current = setTimeout(() => setUndo(undefined), UNDO_MS);
    }, []);
    const act = useCallback(async (f: () => Promise<unknown>): Promise<boolean> => {
        setBusy(true);
        try {
            await f();
            setError(undefined);
            return true;
        } catch (e) {
            setError(failure(e));
            return false;
        } finally {
            setBusy(false);
        }
    }, []);
    const queue = useCallback(
        (body: Parameters<typeof sessionApi.queueRun>[0]): Promise<boolean> =>
            act(async () => {
                const queued = await sessionApi.queueRun(body);
                offerUndo(queued.run.id);
            }),
        [act, offerUndo],
    );
    return {
        apply: (requests, note) => queue({ requests: [...requests], ...(note?.trim() && { note: note.trim() }) }),
        answer: (run, answer) => queue({ requests: requestsOf(run), answerTo: run.id, answer }),
        pick: (run, assumption, alternative, note) => queue({ requests: requestsOf(run), note, pick: { pickOf: run.id, assumption, alternative } }),
        approve: (run, assumption) => act(() => sessionApi.approve({ run: run.id, assumption })),
        cancel: (run) => act(() => sessionApi.cancelRun(run)),
        undo,
        undoNow: () => {
            if (!undo) return;
            setUndo(undefined);
            void act(() => sessionApi.cancelRun(undo.run));
        },
        dismissUndo: () => setUndo(undefined),
        busy,
        error,
    };
}
