// Who is at the other end of a request (ADR 0026): an identity proven by the identity mode of the session (`dev`, a
// name picked on the first visit and a session cookie; `access`, a Cloudflare Access token), and the participant it
// stands for. The facilitator is assigned locally (a one-time link), never derived from the identity provider.
import { Collaboration } from '../generated/index.js';

/** The identity modes of a session, explicit in the configuration (`session.identity`), never inferred from headers. */
export type IdentityMode = 'dev' | 'access';

/** A proven identity. The e-mail is never shown to other participants. */
export interface Identity {
    readonly provider: IdentityMode;
    /** Stable for the person within the provider: a random ID (dev), the token's `sub` (access). */
    readonly subject: string;
    readonly displayName: string;
    readonly email?: string;
    readonly avatarUrl?: string;
}

/** The part of an identity that names the person: the provider and the subject. */
export interface IdentityKey {
    readonly provider: IdentityMode;
    readonly subject: string;
}

export const sameIdentity = (a: IdentityKey, b: IdentityKey): boolean => a.provider === b.provider && a.subject === b.subject;

/**
 * Proves an identity from what the browser sent: for Access, the `Cf-Access-Jwt-Assertion` header or the
 * `CF_Authorization` cookie. `undefined` when the token is absent, malformed, of another audience or issuer, expired,
 * or not signed by the team's keys. The verification of the signature (JWKS) and the Identity API are S8's.
 */
export interface IdentityProvider {
    readonly mode: IdentityMode;
    verify(token: string): Promise<Identity | undefined>;
}

/** The participant the facilitator's identity stands for: the session is started with it, before anyone claims it. */
export const FACILITATOR_PARTICIPANT: Collaboration.ParticipantId = participantId('local:facilitator');

/** The display name the session is started with for the facilitator. */
export const FACILITATOR_NAME: Collaboration.DisplayName = displayName('Facilitator');

/** The participant of an identity that is not the facilitator: `<provider>:<subject>`. */
export function participantOf(identity: IdentityKey): Collaboration.ParticipantId {
    return participantId(`${identity.provider}:${identity.subject}`);
}

function participantId(raw: string): Collaboration.ParticipantId {
    const id = Collaboration.makeParticipantId(raw);
    if (!id.ok) throw new Error(`Not a participant ID: ${raw}`);
    return id.value;
}

function displayName(raw: string): Collaboration.DisplayName {
    const name = Collaboration.makeDisplayName(raw);
    if (!name.ok) throw new Error(`Not a display name: ${raw}`);
    return name.value;
}
