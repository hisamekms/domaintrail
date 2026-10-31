// The facilitator's actions in the chat (ADR 0026, amendment: messages and apply): applying messages (one, with a
// note, or several as one run), answering a run's questions by choosing, picking another alternative of an assumption,
// cancelling a run, and the short undo after applying (a cancel of the run while it is still queued). Every action
// queues at once: there is no tray. The server checks the role anyway.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnswerBody, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { sessionApi } from './api';
import { failure } from './parts';

type RunJson = SessionStateBody['runs'][number];

/** How long the undo after applying is offered. */
export const UNDO_MS = 6_000;

/** What the facilitator chose for one question: options (by ID) and/or own words. */
export interface QuestionChoice {
    readonly options: readonly string[];
    readonly text?: string;
}

/** The answer to send: the questions answered (an option chosen or words written), in the reply's order; none answered: undefined. */
export function answerBody(questions: readonly { readonly id: string }[], choices: Readonly<Record<string, QuestionChoice>>): AnswerBody | undefined {
    const answers = questions.flatMap((q) => {
        const c = choices[q.id];
        const text = c?.text?.trim();
        if (!c || (c.options.length === 0 && !text)) return [];
        return [{ question: q.id, options: [...c.options], ...(text && { text }) }];
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
    /** Queues the run's requests again, with a note asking for another alternative. */
    requeue(run: RunJson, note: string): Promise<boolean>;
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
        requeue: (run, note) => queue({ requests: requestsOf(run), note }),
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
