// What each role sees of the triages (ADR 0030, decision 8; plan decision 8): the facilitator the record — every stage
// that ran, its verdict, confidence, reason and model, which stage decided — and a participant only the outcome: how the
// message was addressed, whether it is decided, as what, and where it went. Applied to the state a page loads and to the
// events it is sent; the agent API is not a page and gets the records.
import type { Collaboration } from '@domaintrail/collaboration';
import type { EventMessage, Json, Role, SessionServerMessage, SessionStateBody, TriageBody, TriageOutcomeBody } from '@domaintrail/collaboration/protocol';

type TriageJson = Json<Collaboration.Triage>;

/** A triage (as the model has it, or its JSON) as a participant sees it: its outcome only. */
export function triageOutcome(triage: Collaboration.Triage | TriageJson): TriageOutcomeBody {
    const at = (d: Date | string): string => (typeof d === 'string' ? d : d.toISOString());
    const common = {
        id: triage.id,
        session: triage.session,
        request: triage.request,
        addressedBy: triage.addressedBy,
        addressedByParticipant: triage.addressedByParticipant,
        openedAt: at(triage.openedAt),
    };
    if (triage.state === 'Pending') return { ...common, state: 'Pending' };
    return {
        ...common,
        state: 'Decided',
        kind: triage.kind,
        decidedAt: at(triage.decidedAt),
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the outcome becomes its JSON when encoded (IDs as strings)
        ...(triage.outcome && { outcome: triage.outcome as unknown as NonNullable<TriageOutcomeBody['outcome']> }),
    };
}

/** A triage as `role` sees it. */
export function triageFor(role: Role, triage: Collaboration.Triage): TriageBody {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the aggregate becomes its JSON when encoded (dates as ISO strings)
    return role === 'facilitator' ? (triage as unknown as TriageJson) : triageOutcome(triage);
}

/** The session's state as `role` sees it: a participant gets the triages' outcomes only. */
export function stateFor(role: Role, state: SessionStateBody): SessionStateBody {
    if (role === 'facilitator' || !state.triages) return state;
    return {
        ...state,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a body with steps is a record
        triages: state.triages.map((t) => ('steps' in t ? triageOutcome(t as TriageJson) : t)),
    };
}

/**
 * An event as `role`'s page gets it: the facilitator every event as it is; a participant no `triage.step_recorded`,
 * `triage.decided` without the stage that decided, `triage.overridden` without its step. `undefined`: not sent.
 */
export function eventFor(role: Role, message: EventMessage): SessionServerMessage | undefined {
    if (role === 'facilitator') return message;
    switch (message.type) {
        case 'triage.step_recorded':
            return undefined;
        case 'triage.decided': {
            const { decidedBy: _, ...event } = message.event;
            return { type: message.type, seq: message.seq, event };
        }
        case 'triage.overridden': {
            const { step: _, ...event } = message.event;
            return { type: message.type, seq: message.seq, event };
        }
        default:
            return message;
    }
}
