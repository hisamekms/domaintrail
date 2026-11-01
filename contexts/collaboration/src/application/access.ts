// Who may act in a session, outside the model (ADR 0026, S4): the one-time facilitator link printed by `dt session
// start` (or issued again locally), the identity it binds to the facilitator, and the sign-ins of the `dev` identity
// mode (an opaque cookie mapped to a picked name). Secrets leave here once, to the caller; only their SHA-256 is kept.
import { err, ok, type Collaboration, type Result } from '../generated/index.js';
import { sha256Hex } from '../domain/sha256.js';
import type { Identity, IdentityKey } from './identity.js';
import type { Clock, SecretGenerator, SignIn, UnitOfWork } from './ports.js';

type SessionId = Collaboration.SessionId;

/** A facilitator link's code (secret, single use) and when it stops working. */
export interface FacilitatorLink {
    readonly code: string;
    readonly expiresAt: Date;
}

/** The session is not open (or unknown): no link is issued for it. */
export interface SessionNotOpen {
    readonly type: 'SessionNotOpen';
}

/** The link's code is unknown, used, expired, or for another session. */
export interface LinkInvalid {
    readonly type: 'LinkInvalid';
}

export interface SessionAccess {
    /** A new one-time facilitator link for the open session, valid for `ttlMs`. */
    issueFacilitatorLink(input: { readonly session: SessionId; readonly ttlMs: number }): Promise<Result<FacilitatorLink, SessionNotOpen>>;
    /** Uses the link: `identity` now holds the facilitator role (the previous holder, if any, loses it). */
    claimFacilitator(input: {
        readonly session: SessionId;
        readonly code: string;
        readonly identity: IdentityKey;
    }): Promise<Result<{ readonly previous: IdentityKey | undefined }, LinkInvalid>>;
    /** The identity holding the facilitator role, if one claimed it. */
    facilitator(session: SessionId): Promise<IdentityKey | undefined>;
    /** Signs `identity` in (dev mode): the cookie's secret, returned once. */
    signIn(input: { readonly session: SessionId; readonly identity: Identity }): Promise<string>;
    /** The sign-in of a cookie's secret, unless revoked. */
    signedIn(secret: string): Promise<SignIn | undefined>;
    /** Revokes the sign-in of a cookie's secret; false when there was none. */
    signOut(secret: string): Promise<boolean>;
    /** Revokes every sign-in of the session (when it closes): the identities that were signed in. */
    signOutAll(session: SessionId): Promise<IdentityKey[]>;
}

const encoder = new TextEncoder();

/** What is stored of a secret. */
export const secretHash = (secret: string): string => sha256Hex(encoder.encode(secret));

export function createSessionAccess(deps: { readonly uow: UnitOfWork; readonly clock: Clock; readonly secrets: SecretGenerator }): SessionAccess {
    const { uow, clock, secrets } = deps;
    return {
        async issueFacilitatorLink({ session, ttlMs }) {
            return uow.transaction((stores) => {
                if (stores.sessions.load(session)?.state !== 'Open') return err({ type: 'SessionNotOpen' });
                const code = secrets.newSecret();
                const expiresAt = new Date(clock.now().getTime() + ttlMs);
                stores.access.addLink(secretHash(code), session, expiresAt);
                return ok({ code, expiresAt });
            });
        },

        async claimFacilitator({ session, code, identity }) {
            return uow.transaction((stores) => {
                if (stores.sessions.load(session)?.state !== 'Open') return err({ type: 'LinkInvalid' });
                const now = clock.now();
                // a code for another session is used up all the same: it was shown to the wrong place
                if (stores.access.useLink(secretHash(code), now) !== session) return err({ type: 'LinkInvalid' });
                const previous = stores.access.facilitator(session);
                stores.access.setFacilitator(session, { provider: identity.provider, subject: identity.subject }, now);
                return ok({ previous });
            });
        },

        async facilitator(session) {
            return uow.transaction((stores) => stores.access.facilitator(session));
        },

        async signIn({ session, identity }) {
            const secret = secrets.newSecret();
            await uow.transaction((stores) => stores.access.addSignIn(secretHash(secret), { session, identity }, clock.now()));
            return secret;
        },

        async signedIn(secret) {
            return uow.transaction((stores) => stores.access.signIn(secretHash(secret)));
        },

        async signOut(secret) {
            return uow.transaction((stores) => stores.access.revokeSignIn(secretHash(secret), clock.now()));
        },

        async signOutAll(session) {
            return uow.transaction((stores) => stores.access.revokeSignIns(session, clock.now()));
        },
    };
}
