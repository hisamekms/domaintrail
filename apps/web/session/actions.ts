// The actions in the chat (ADR 0026, amendment: messages and apply; ADR 0030): the facilitator addresses messages to the
// AI (「AI に送る」, one or several: each one's triage decides what follows), approves change proposals (several
// together: one run, each as is or edited) or rejects them, answers a run's questions by choosing, picks another
// alternative of an assumption, approves an assumption (recorded, nothing queued), cancels a run, and has the short undo
// after an answer or a pick (a cancel of the run while it is still queued); a participant withdraws their own proposal.
// Every action acts at once: there is no tray. The server checks the role anyway.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnswerBody, ProposalBody, SessionStateBody } from '@domaintrail/collaboration/protocol';
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
    /** The facilitator's 「AI に送る」 (ADR 0030): addresses the messages to the AI; each one's triage decides what follows. */
    address(requests: readonly string[]): Promise<boolean>;
    /** Approves open change proposals, each as is or edited (`edited`): approved together, they are one run. */
    approveProposals(proposals: readonly { readonly proposal: string; readonly edited?: ProposalBody }[]): Promise<boolean>;
    /** Rejects an open change proposal, with a note to its requester if any. */
    rejectProposal(proposal: string, note?: string): Promise<boolean>;
    /** Withdraws my open change proposal. */
    withdrawProposal(proposal: string): Promise<boolean>;
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
        address: (requests) => act(() => sessionApi.address([...requests])),
        approveProposals: (proposals) => act(() => sessionApi.approveProposals({ proposals: [...proposals] })),
        rejectProposal: (proposal, note) => act(() => sessionApi.rejectProposal(proposal, note?.trim() || undefined)),
        withdrawProposal: (proposal) => act(() => sessionApi.withdrawProposal(proposal)),
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
