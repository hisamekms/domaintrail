// What became of the message ホットスポットにする sent (ADR 0031, section 4), read from the collaboration: the
// knowledge's hand-overs (`createHotspotHandOvers`) ask it whenever the session moved. The message's latest run decides
// (the run that answers a question carries the same messages, so a question keeps it waiting): queued, running or
// asking, it waits; completed, the hotspots it added and the existing ones it changed are the storming's diff from its
// base to its result revision (`modelChanges`, the run card's changed elements: by storming and local ID), and those
// its reply names are its element references (`@{es:<Storming>/<Local>}`) that are hotspots in its result revision;
// declined, failed, cancelled, it ended.
// Without a run yet: its triage and proposal say whether one may still come (being triaged, a proposal waiting for the
// facilitator) or not (not for the AI, answered as a question, the proposal rejected or withdrawn).
import { type Collaboration, type CollaborationUseCases, parseElementReference } from '@domaintrail/collaboration';
import type { RequestOutcome } from '@domaintrail/knowledge';

/** The `.dtes` elements a reply names (`@{es:<Storming>/<Local>}` in any of its text), as `<Storming>.<Local>`, each once. */
export function namedInReply(reply: Collaboration.AgentReply | undefined): string[] {
    if (!reply) return [];
    const texts = [reply.summary, reply.answer ?? '', ...reply.requests.map((r) => r.note ?? ''), ...reply.assumptions.map((a) => a.text)];
    const named = texts.flatMap((t) =>
        [...String(t).matchAll(/@\{es:[^{}\s@\\]+\}/gu)].flatMap((m) => {
            const target = parseElementReference(m[0]);
            return target?.kind === 'DtesElement' ? [`${target.storming}.${target.local}`] : [];
        }),
    );
    return [...new Set(named)];
}

/** The hotspots a completed run added and changed, and those its reply names; why not, when the storming cannot be read. */
async function hotspotsOfRun(
    collaboration: CollaborationUseCases,
    session: Collaboration.SessionId,
    run: Collaboration.CompletedAgentRun,
): Promise<RequestOutcome> {
    const unreadable: RequestOutcome = { kind: 'ended', why: 'the storming before or after the run could not be read' };
    let added: string[] = [];
    let changed: string[] = [];
    if (run.changed) {
        const changes = await collaboration.modelChanges({ session, before: run.baseRevision, after: run.resultRevision });
        if (!changes.ok || !changes.value.complete) return unreadable;
        const hotspots = (change: 'added' | 'changed'): string[] =>
            changes.value.changes.flatMap((c) => (c.language === 'Dtes' && c.kind === 'hotspot' && c.change === change ? [`${c.storming}.${c.local}`] : []));
        added = hotspots('added');
        changed = hotspots('changed');
    }
    const mentioned = namedInReply(run.reply);
    let named: string[] = [];
    if (added.length === 0 && changed.length === 0 && mentioned.length > 0) {
        const elements = await collaboration.stormingElements({ session, revision: run.resultRevision });
        if (!elements.ok) return unreadable;
        const isHotspot = new Set(elements.value.elements.filter((e) => e.kind === 'hotspot').map((e) => `${e.storming}.${e.local}`));
        named = mentioned.filter((m) => isHotspot.has(m));
    }
    return { kind: 'ran', added, changed, named };
}

/** What became of a run of the message, by the run's state. */
async function outcomeOfRun(collaboration: CollaborationUseCases, session: Collaboration.SessionId, run: Collaboration.AgentRun): Promise<RequestOutcome> {
    switch (run.state) {
        case 'Queued':
        case 'Running':
        case 'NeedsClarification':
            return { kind: 'waiting' };
        case 'Completed':
            return hotspotsOfRun(collaboration, session, run);
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
