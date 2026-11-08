// The errors of the application (as opposed to those the domain decides), shared by its use cases.
import type { Collaboration } from '../generated/index.js';

export interface NotFound {
    readonly type: 'NotFound';
    readonly aggregate: 'Session' | 'Request' | 'AgentRun' | 'Revision' | 'Triage' | 'ChangeProposal' | 'Interview' | 'SlashCommand';
    readonly id: string;
}

/** The aggregate is in a state the command does not accept: the contracts make this the caller's check. */
export interface NotAllowed {
    readonly type: 'NotAllowed';
    readonly command: string;
    readonly state: string;
}

export interface NotAParticipant {
    readonly type: 'NotAParticipant';
    readonly participant: Collaboration.ParticipantId;
}

/** A request's target breaks an invariant of `TargetSnapshot` or `SourceRange`. */
export interface InvalidTarget {
    readonly type: 'InvalidTarget';
    readonly violated: readonly string[];
}

export const notFound = (aggregate: NotFound['aggregate'], id: string): NotFound => ({ type: 'NotFound', aggregate, id });
export const notAllowed = (command: string, state: string): NotAllowed => ({ type: 'NotAllowed', command, state });
