// Who calls a use case (ADR 0027, Authorization): built by this application from the authenticated identity, never
// taken from what a request says. The participant and the role reach the commands as parameters, and the commands'
// `requires` (collaboration/model/*.dt) decide what the role allows. The agent acts through the lease it claimed (its
// token), not as an `Actor`: no use case a person calls is open to it.
import type { Collaboration } from '../generated/index.js';
import { FACILITATOR_PARTICIPANT, participantOf, sameIdentity, type IdentityKey } from './identity.js';

/** A participant of the session, with the role they hold in it. */
export interface Actor {
    readonly kind: 'participant';
    readonly participant: Collaboration.ParticipantId;
    readonly role: Collaboration.ParticipantRole;
    /** The identity that was authenticated, kept with what it did (a restore's operation log); absent without one (tests). */
    readonly identity?: IdentityKey;
}

/**
 * The actor of an authenticated identity: the facilitator when it holds the facilitator role (`facilitator`, the
 * identity that used the facilitator link), a participant otherwise.
 */
export function actorOf(identity: IdentityKey, facilitator: IdentityKey | undefined): Actor {
    const key: IdentityKey = { provider: identity.provider, subject: identity.subject };
    if (facilitator && sameIdentity(facilitator, identity))
        return { kind: 'participant', participant: FACILITATOR_PARTICIPANT, role: 'Facilitator', identity: key };
    return { kind: 'participant', participant: participantOf(identity), role: 'Participant', identity: key };
}
