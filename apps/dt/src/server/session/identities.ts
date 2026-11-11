// Who sends a request to a session (ADR 0026, S4): the identity of the configured mode, and the participant and role
// it stands for. `dev`: the session cookie (`dt_session`, opaque, HttpOnly, SameSite=Strict) of a sign-in made with a
// picked name; `access`: the Cloudflare Access token (`Cf-Access-Jwt-Assertion` header, else the `CF_Authorization`
// cookie when configured), verified by the `IdentityProvider` on every request; `link`: a session cookie as in `dev`,
// but of a name chosen when the server starts (`__Host-dt_link_<random>`, Secure) and given only once the facilitator
// approved a join request (`../session/link-join.ts`), or to whoever signs in with a facilitator link. The facilitator
// is the identity that used a facilitator link.
import type { IncomingHttpHeaders } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
    actorOf,
    Collaboration,
    type CollaborationUseCases,
    err,
    type Identity,
    type IdentityKey,
    type IdentityMode,
    type IdentityProvider,
    type LinkInvalid,
    ok,
    participantOf,
    type Result,
    sameIdentity,
    secretHash,
    type SessionAccess,
    type SignIn,
} from '@domaintrail/collaboration';
import type { Identified } from '../http/access.js';

/** The cookie of a `dev` sign-in. */
export const DEV_COOKIE = 'dt_session';
/** The header and the cookie Cloudflare Access puts its token in. */
export const ACCESS_HEADER = 'cf-access-jwt-assertion';
export const ACCESS_COOKIE = 'CF_Authorization';

/** A secret of `SecretGenerator` (base64url of 32 bytes); anything else is not looked up. */
const SECRET = /^[A-Za-z0-9_-]{43}$/;

export type { Identified };

/** The session has as many participants as it admits. */
export interface SessionFull {
    readonly type: 'SessionFull';
    readonly maxParticipants: number;
}

export type SignInError = SessionFull | Collaboration.SessionNotFound | Collaboration.SessionAlreadyClosed | Collaboration.SoloSession;

/** The participant cannot be removed: unknown, the facilitator, or not of a mode that signs in with a cookie. */
export interface NotRemovable {
    readonly type: 'NotRemovable';
}

export interface SessionIdentities {
    readonly mode: IdentityMode;
    /** The name of the cookie a sign-in sets (`dev`, `link`). */
    readonly cookieName: string;
    /** Who sent these headers, if anyone; in `access` mode an identity seen for the first time joins the session. */
    identify(headers: IncomingHttpHeaders): Promise<Identified | undefined>;
    /** `dev`, `link`: a new identity named `name` joins the session; the cookie's secret, given once. */
    signIn(name: Collaboration.DisplayName): Promise<Result<{ readonly secret: string; readonly identified: Identified }, SignInError>>;
    /**
     * `link`: a new identity named `name` signs in holding the facilitator role, with a facilitator link's `code` (used
     * up): the cookie's secret, given once, and the previous holder, if any. Nothing is signed in when the code is not valid.
     */
    signInFacilitator(
        name: Collaboration.DisplayName,
        code: string,
    ): Promise<Result<{ readonly secret: string; readonly identified: Identified; readonly previous: IdentityKey | undefined }, LinkInvalid | SignInError>>;
    /** `link`: revokes every sign-in of a participant (removed by the facilitator): the identity it was. */
    remove(participant: string): Promise<Result<IdentityKey, NotRemovable>>;
    /** `dev`: revokes the sign-in of these headers' cookie: the identity it was, if any. */
    signOut(headers: IncomingHttpHeaders): Promise<IdentityKey | undefined>;
    /** Uses a facilitator link: the identity holds the facilitator role from now on; the previous holder, if any. */
    claimFacilitator(code: string, identity: IdentityKey): Promise<Result<{ readonly previous: IdentityKey | undefined }, LinkInvalid>>;
    /** The participant the identity holding the facilitator role is outside the role (`dev:…`, `access:…`), if one claimed it. */
    facilitatorParticipant(): Promise<Collaboration.ParticipantId | undefined>;
    /** The session closed: every sign-in is revoked, and from now on no one is identified; the identities that were signed in. */
    closeAll(): Promise<IdentityKey[]>;
}

export interface SessionIdentitiesDeps {
    readonly session: Collaboration.SessionId;
    readonly mode: IdentityMode;
    /** The verifier of the `access` mode. */
    readonly provider?: IdentityProvider;
    /** `access`: whether the `CF_Authorization` cookie stands in for an absent `Cf-Access-Jwt-Assertion` header. */
    readonly acceptAccessCookie?: boolean;
    readonly access: SessionAccess;
    readonly collaboration: CollaborationUseCases;
    readonly maxParticipants: number;
    /** The cookie of a sign-in (`dev`, `link`). Default: `DEV_COOKIE`. */
    readonly cookieName?: string;
    /**
     * `access`: an identity seen for the first time joined while being identified (no route of its own publishes it):
     * e.g. send the join to the pages, awaited before the request goes on.
     */
    readonly joined?: (participant: Collaboration.ParticipantId) => Promise<void>;
}

/** The cookies of a request by name (the first of a name wins). */
export function cookies(headers: IncomingHttpHeaders): Map<string, string> {
    const jar = new Map<string, string>();
    for (const part of (headers.cookie ?? '').split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const name = part.slice(0, eq).trim();
        if (name && !jar.has(name)) jar.set(name, part.slice(eq + 1).trim());
    }
    return jar;
}

/** The Access token of a request: the header Access adds, else (only when `acceptCookie`) its cookie. */
export function accessToken(headers: IncomingHttpHeaders, acceptCookie: boolean): string | undefined {
    const header = headers[ACCESS_HEADER];
    if (typeof header === 'string' && header) return header;
    return acceptCookie ? cookies(headers).get(ACCESS_COOKIE) || undefined : undefined;
}

/** The sign-in cookie's secret of a request (`DEV_COOKIE` unless named), when it has the shape of one. */
export function devSecret(headers: IncomingHttpHeaders, cookieName: string = DEV_COOKIE): string | undefined {
    const secret = cookies(headers).get(cookieName);
    return secret && SECRET.test(secret) ? secret : undefined;
}

/** The identity a participant ID of a cookie sign-in stands for (`link:<subject>`, `dev:<subject>`), if it is one. */
function identityOfParticipant(participant: string, provider: IdentityMode): IdentityKey | undefined {
    const prefix = `${provider}:`;
    const subject = participant.startsWith(prefix) ? participant.slice(prefix.length) : '';
    return /^[0-9a-f-]{36}$/.test(subject) ? { provider, subject } : undefined;
}

const keyOf = (identity: IdentityKey): IdentityKey => ({ provider: identity.provider, subject: identity.subject });

export function createSessionIdentities(deps: SessionIdentitiesDeps): SessionIdentities {
    const { session, mode, access, collaboration, maxParticipants } = deps;
    const cookieName = deps.cookieName ?? DEV_COOKIE;
    const withCookie = mode === 'dev' || mode === 'link';
    if (mode === 'access' && !deps.provider) throw new Error('The access identity mode needs an identity provider');

    /** Sign-ins by their secret's hash, as looked up (revoked ones are dropped). */
    const signIns = new Map<string, SignIn>();
    /** The participants known to have joined. */
    const joined = new Set<string>();
    let facilitator: Promise<IdentityKey | undefined> | undefined;
    /** Set when the session closed: no one is identified any more, whatever is cached. */
    let closed = false;
    /** Whether the session is still the workspace's open one (asked on every identification, not cached). */
    const isOpen = async (): Promise<boolean> => !closed && (await collaboration.currentSession())?.id === session;
    const facilitatorKey = (): Promise<IdentityKey | undefined> => (facilitator ??= access.facilitator(session));

    const identified = async (identity: Identity): Promise<Identified> => {
        // the collaboration's application binds the identity to a participant and a role
        const actor = actorOf(identity, await facilitatorKey());
        return { participant: { id: actor.participant, identity }, role: actor.role === 'Facilitator' ? 'facilitator' : 'participant', actor };
    };

    /** Joins `identity` unless it did; refused when the session is full or not open. */
    const join = async (identity: Identity): Promise<Result<Collaboration.ParticipantId, SignInError>> => {
        if (closed) return err({ type: 'Collaboration.SessionAlreadyClosed' });
        const id = participantOf(identity);
        if (joined.has(id)) return ok(id);
        const state = await collaboration.sessionState({ session });
        if (!state.ok) return err({ type: 'Collaboration.SessionNotFound' });
        const participants = state.value.session.participants;
        if (!participants.some((p) => p.id === id) && participants.length >= maxParticipants) return err({ type: 'SessionFull', maxParticipants });
        const name = Collaboration.makeDisplayName(identity.displayName.slice(0, 200));
        if (!name.ok) throw new Error('An identity without a display name');
        const result = await collaboration.joinSession({ session, participant: id, name: name.value });
        if (!result.ok) return result;
        joined.add(id);
        return ok(id);
    };

    return {
        mode,
        cookieName,

        async identify(headers) {
            // a closed session identifies no one: neither a cached sign-in, nor the facilitator, nor a joined identity
            if (!(await isOpen())) return undefined;
            if (withCookie) {
                const secret = devSecret(headers, cookieName);
                if (!secret) return undefined;
                const hash = secretHash(secret);
                const signIn = signIns.get(hash) ?? (await access.signedIn(secret));
                // a sign-in of another mode (a `dev` one in a `link` session, or the other way round) is no one
                if (!signIn || signIn.session !== session || signIn.identity.provider !== mode) return undefined;
                signIns.set(hash, signIn);
                return identified(signIn.identity);
            }
            const token = accessToken(headers, deps.acceptAccessCookie ?? false);
            const identity = token ? await deps.provider?.verify(token) : undefined;
            if (!identity) return undefined;
            const who = await identified(identity);
            if (who.role === 'facilitator') return who;
            const known = joined.has(participantOf(identity));
            const joinedAs = await join(identity);
            if (!joinedAs.ok) return undefined;
            // the others' pages learn of a newcomer from the join's event: published now, not with the next change
            if (!known) await deps.joined?.(joinedAs.value);
            return who;
        },

        async signIn(name) {
            if (!withCookie) throw new Error('Only the dev and link identity modes sign in with a name');
            if (!(await isOpen())) return err({ type: 'Collaboration.SessionAlreadyClosed' });
            const identity: Identity = { provider: mode, subject: randomUUID(), displayName: name };
            const joinedAs = await join(identity);
            if (!joinedAs.ok) return joinedAs;
            const secret = await access.signIn({ session, identity });
            signIns.set(secretHash(secret), { session, identity });
            return ok({ secret, identified: await identified(identity) });
        },

        async signInFacilitator(name, code) {
            if (mode !== 'link') throw new Error('Only the link identity mode signs the facilitator in with a link');
            if (!(await isOpen())) return err({ type: 'Collaboration.SessionAlreadyClosed' });
            const identity: Identity = { provider: mode, subject: randomUUID(), displayName: name };
            // the code first: nothing is signed in with a code that is not valid
            const claimed = await access.claimFacilitator({ session, code, identity: keyOf(identity) });
            if (!claimed.ok) return claimed;
            facilitator = Promise.resolve(keyOf(identity));
            const secret = await access.signIn({ session, identity });
            signIns.set(secretHash(secret), { session, identity });
            return ok({ secret, identified: await identified(identity), previous: claimed.value.previous });
        },

        async remove(participant) {
            if (mode !== 'link') return err({ type: 'NotRemovable' });
            const identity = identityOfParticipant(participant, mode);
            const holder = await facilitatorKey();
            if (!identity || (holder && sameIdentity(holder, identity))) return err({ type: 'NotRemovable' });
            await access.signOutIdentity({ session, identity });
            for (const [hash, signIn] of signIns) if (sameIdentity(signIn.identity, identity)) signIns.delete(hash);
            joined.delete(participantOf(identity));
            return ok(identity);
        },

        async signOut(headers) {
            const secret = devSecret(headers, cookieName);
            if (!secret) return undefined;
            const hash = secretHash(secret);
            const signIn = signIns.get(hash) ?? (await access.signedIn(secret));
            signIns.delete(hash);
            if (!signIn || signIn.session !== session) return undefined;
            return (await access.signOut(secret)) ? keyOf(signIn.identity) : undefined;
        },

        async claimFacilitator(code, identity) {
            const claimed = await access.claimFacilitator({ session, code, identity: keyOf(identity) });
            if (claimed.ok) facilitator = Promise.resolve(keyOf(identity));
            return claimed;
        },

        async facilitatorParticipant() {
            if (closed) return undefined;
            const holder = await facilitatorKey();
            return holder && participantOf(holder);
        },

        async closeAll() {
            closed = true;
            signIns.clear();
            joined.clear();
            facilitator = undefined;
            return access.signOutAll(session);
        },
    };
}
