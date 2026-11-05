// What became of the message ホットスポットにする sent (ADR 0031, section 4), read from the collaboration: the
// knowledge's hand-overs (`createHotspotHandOvers`) ask it whenever the session moved. The message's latest run decides
// (the run that answers a question carries the same messages, so a question keeps it waiting): queued, running or
// asking, it waits; completed, the hotspots it added are the storming's diff from its base to its result revision
// (`modelChanges`, the run card's changed elements: by storming and local ID); declined, failed, cancelled, it ended.
// Without a run yet: its triage and proposal say whether one may still come (being triaged, a proposal waiting for the
// facilitator) or not (not for the AI, answered as a question, the proposal rejected or withdrawn).
import { type Collaboration, type CollaborationUseCases } from '@domaintrail/collaboration';
import type { RequestOutcome } from '@domaintrail/knowledge';

/** What became of a run of the message, by the run's state. */
async function outcomeOfRun(collaboration: CollaborationUseCases, session: Collaboration.SessionId, run: Collaboration.AgentRun): Promise<RequestOutcome> {
    switch (run.state) {
        case 'Queued':
        case 'Running':
        case 'NeedsClarification':
            return { kind: 'waiting' };
        case 'Completed': {
            if (!run.changed) return { kind: 'ran', hotspots: [] };
            const changes = await collaboration.modelChanges({ session, before: run.baseRevision, after: run.resultRevision });
            if (!changes.ok || !changes.value.complete) return { kind: 'ended', why: 'the storming before or after the run could not be read' };
            const hotspots = changes.value.changes.flatMap((c) =>
                c.language === 'Dtes' && c.kind === 'hotspot' && c.change === 'added' ? [`${c.storming}.${c.local}`] : [],
            );
            return { kind: 'ran', hotspots };
        }
        case 'Declined':
            return { kind: 'ended', why: 'the run declined' };
        case 'Failed':
            return { kind: 'ended', why: 'the run failed' };
        case 'Cancelled':
            return { kind: 'ended', why: 'the run was cancelled' };
        case 'Reverted':
            return { kind: 'ended', why: 'the run was a revert' };
    }
}

/** What became of a message of the session sent to the AI. */
export function requestOutcomes(collaboration: CollaborationUseCases, session: Collaboration.SessionId): (request: string) => Promise<RequestOutcome> {
    return async (request) => {
        const state = await collaboration.sessionState({ session });
        if (!state.ok) return { kind: 'ended', why: 'the session is gone' };
        const { requests, runs, triages, proposals } = state.value;
        const message = requests.find((r) => r.id === request);
        if (!message) return { kind: 'ended', why: 'no such message' };
        if (message.state === 'Dismissed') return { kind: 'ended', why: 'the message was dismissed' };
        const latest = runs.filter((r) => r.input.requests.some((f) => f.request === message.id)).at(-1);
        if (latest) return outcomeOfRun(collaboration, session, latest);
        const triage = triages.find((t) => t.request === message.id);
        // not triaged yet, or being triaged
        if (!triage || triage.state === 'Pending') return { kind: 'waiting' };
        if (triage.kind === 'NotForAi') return { kind: 'ended', why: 'the message was not for the AI' };
        const outcome = triage.outcome;
        if (!outcome) return { kind: 'waiting' };
        switch (outcome.kind) {
            case 'Answer':
                return { kind: 'ended', why: 'the AI answered it as a question' };
            case 'Run':
                // the run is among the runs once queued
                return { kind: 'waiting' };
            case 'Proposal': {
                const proposal = proposals.find((p) => p.id === outcome.proposal);
                if (proposal?.state === 'Rejected') return { kind: 'ended', why: 'the proposal was rejected' };
                if (proposal?.state === 'Withdrawn') return { kind: 'ended', why: 'the proposal was withdrawn' };
                return { kind: 'waiting' };
            }
        }
    };
}

/** Whether a message is the participant's own, sent in the session: only its author records a press for it. */
export async function ownRequest(
    collaboration: CollaborationUseCases,
    session: Collaboration.SessionId,
    request: string,
    participant: string,
): Promise<boolean> {
    const state = await collaboration.sessionState({ session });
    return state.ok && state.value.requests.some((r) => r.id === request && r.author === participant);
}
