// Who may act in a session, outside the model (ADR 0026, S4; ADR 0030, M5): the one-time facilitator link printed by
// `dt collab` (or issued again locally), the identity it binds to the facilitator, the one-time agent pairing codes
// (`dt collab agent-link`: exchanged by `dt agent --code` for the agent API's credential), and the sign-ins of the `dev`
// identity mode (an opaque cookie mapped to a picked name). Secrets leave here once, to the caller; only their SHA-256
// is kept. A pairing code is stored beside the facilitator links under a hash of its own domain (`AGENT_CODE_DOMAIN`),
// and so is a sign-in link of `dt open` issued again (`dt open link`, `OPEN_CODE_DOMAIN`): no kind is accepted as another.
// The invite link of the `link` identity mode is apart from them all (`INVITE_DOMAIN`, a table of its own): used any
// number of times until it expires or is revoked, one live per session (a new one revokes the previous).
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
    /** A new one-time agent pairing code for the open session, valid for `ttlMs`: not a facilitator link. */
    issueAgentCode(input: { readonly session: SessionId; readonly ttlMs: number }): Promise<Result<FacilitatorLink, SessionNotOpen>>;
    /** Uses an agent pairing code of the session: whether it was valid (unused, unexpired, an agent code of this session). */
    redeemAgentCode(input: { readonly session: SessionId; readonly code: string }): Promise<boolean>;
    /** A new one-time sign-in code for `dt open`'s Solo session, valid for `ttlMs`: neither a facilitator link nor an agent code. */
    issueOpenCode(input: { readonly session: SessionId; readonly ttlMs: number }): Promise<Result<FacilitatorLink, SessionNotOpen>>;
    /** Uses a sign-in code of `dt open`: whether it was valid (unused, unexpired, a sign-in code of this session). */
    redeemOpenCode(input: { readonly session: SessionId; readonly code: string }): Promise<boolean>;
    /**
     * Revokes every unused link of the session: facilitator links, agent pairing codes, `dt open`'s sign-in codes and
     * the invite (its server stops).
     */
    revokeLinks(session: SessionId): Promise<void>;
    /** A new invite link's code for the open session, valid for `ttlMs` and any number of uses; the previous one is revoked. */
    issueInvite(input: { readonly session: SessionId; readonly ttlMs: number }): Promise<Result<FacilitatorLink, SessionNotOpen>>;
    /** When the invite of `code` expires, if it is the session's and neither revoked nor expired (it is not used up). */
    checkInvite(input: { readonly session: SessionId; readonly code: string }): Promise<Date | undefined>;
    /** When the session's live invite expires, if it has one. */
    liveInvite(session: SessionId): Promise<Date | undefined>;
    /** Revokes the session's invite: whether one was live. */
    revokeInvite(session: SessionId): Promise<boolean>;
    /** Revokes every sign-in of `identity` in the session (removed by the facilitator): whether there was one. */
    signOutIdentity(input: { readonly session: SessionId; readonly identity: IdentityKey }): Promise<boolean>;
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

/** The domain an agent pairing code is hashed in, apart from the facilitator links'. */
const AGENT_CODE_DOMAIN = 'dt-agent-pairing:';
const agentCodeHash = (code: string): string => secretHash(`${AGENT_CODE_DOMAIN}${code}`);
/** The domain a sign-in code of `dt open` is hashed in. */
const OPEN_CODE_DOMAIN = 'dt-open-sign-in:';
const openCodeHash = (code: string): string => secretHash(`${OPEN_CODE_DOMAIN}${code}`);
/** The domain an invite link's code is hashed in. */
const INVITE_DOMAIN = 'dt-invite:';
const inviteHash = (code: string): string => secretHash(`${INVITE_DOMAIN}${code}`);

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

        async issueAgentCode({ session, ttlMs }) {
            return uow.transaction((stores) => {
                if (stores.sessions.load(session)?.state !== 'Open') return err({ type: 'SessionNotOpen' });
                const code = secrets.newSecret();
                const expiresAt = new Date(clock.now().getTime() + ttlMs);
                stores.access.addLink(agentCodeHash(code), session, expiresAt);
                return ok({ code, expiresAt });
            });
        },

        async redeemAgentCode({ session, code }) {
            return uow.transaction((stores) => stores.access.useLink(agentCodeHash(code), clock.now()) === session);
        },

        async issueOpenCode({ session, ttlMs }) {
            return uow.transaction((stores) => {
                const open = stores.sessions.load(session);
                if (open?.state !== 'Open' || open.mode !== 'Solo') return err({ type: 'SessionNotOpen' });
                const code = secrets.newSecret();
                const expiresAt = new Date(clock.now().getTime() + ttlMs);
                stores.access.addLink(openCodeHash(code), session, expiresAt);
                return ok({ code, expiresAt });
            });
        },

        async redeemOpenCode({ session, code }) {
            return uow.transaction((stores) => stores.access.useLink(openCodeHash(code), clock.now()) === session);
        },

        async revokeLinks(session) {
            await uow.transaction((stores) => {
                stores.access.revokeLinks(session, clock.now());
                stores.access.revokeInvites(session, clock.now());
            });
        },

        async issueInvite({ session, ttlMs }) {
            return uow.transaction((stores) => {
                const open = stores.sessions.load(session);
                if (open?.state !== 'Open' || open.mode === 'Solo') return err({ type: 'SessionNotOpen' });
                const code = secrets.newSecret();
                const now = clock.now();
                const expiresAt = new Date(now.getTime() + ttlMs);
                stores.access.addInvite(inviteHash(code), session, expiresAt, now);
                return ok({ code, expiresAt });
            });
        },

        async checkInvite({ session, code }) {
            return uow.transaction((stores) => {
                const now = clock.now();
                if (stores.sessions.load(session)?.state !== 'Open' || stores.access.invite(inviteHash(code), now) !== session) return undefined;
                return stores.access.liveInvite(session, now);
            });
        },

        async liveInvite(session) {
            return uow.transaction((stores) => stores.access.liveInvite(session, clock.now()));
        },

        async revokeInvite(session) {
            return uow.transaction((stores) => stores.access.revokeInvites(session, clock.now()));
        },

        async signOutIdentity({ session, identity }) {
            return uow.transaction((stores) => stores.access.revokeSignInsOf(session, identity, clock.now()) > 0);
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
