// Who sends a request to a session (ADR 0026, S4): the identity of the configured mode, and the participant and role
// it stands for. `dev`: the session cookie (`dt_session`, opaque, HttpOnly, SameSite=Strict) of a sign-in made with a
// picked name; `access`: the Cloudflare Access token (`Cf-Access-Jwt-Assertion` header, else the `CF_Authorization`
// cookie when configured), verified by the `IdentityProvider` on every request. The facilitator is the identity that used a facilitator link.
import type { IncomingHttpHeaders } from 'node:http';
import { randomUUID } from 'node:crypto';
import { secretHash, type LinkInvalid, type SessionAccess } from '@domaintrail/collaboration/application/access';
import {
    FACILITATOR_PARTICIPANT,
    participantOf,
    sameIdentity,
    type Identity,
    type IdentityKey,
    type IdentityMode,
    type IdentityProvider,
} from '@domaintrail/collaboration/application/identity';
import type { SignIn } from '@domaintrail/collaboration/application/ports';
import type { CollaborationUseCases } from '@domaintrail/collaboration/application/use-cases';
import { Collaboration, err, ok, type Result } from '@domaintrail/collaboration/generated/index';
import type { Role } from '@domaintrail/collaboration/protocol';
import type { SessionParticipant } from '../http/access.js';

/** The cookie of a `dev` sign-in. */
export const DEV_COOKIE = 'dt_session';
/** The header and the cookie Cloudflare Access puts its token in. */
export const ACCESS_HEADER = 'cf-access-jwt-assertion';
export const ACCESS_COOKIE = 'CF_Authorization';

/** A secret of `SecretGenerator` (base64url of 32 bytes); anything else is not looked up. */
const SECRET = /^[A-Za-z0-9_-]{43}$/;

export interface Identified {
    readonly participant: SessionParticipant;
    readonly role: Role;
}

/** The session has as many participants as it admits. */
export interface SessionFull {
    readonly type: 'SessionFull';
    readonly maxParticipants: number;
}

export type SignInError = SessionFull | Collaboration.SessionNotFound | Collaboration.SessionAlreadyClosed;

export interface SessionIdentities {
    readonly mode: IdentityMode;
    /** Who sent these headers, if anyone; in `access` mode an identity seen for the first time joins the session. */
    identify(headers: IncomingHttpHeaders): Promise<Identified | undefined>;
    /** `dev`: a new identity named `name` joins the session; the cookie's secret, given once. */
    signIn(name: Collaboration.DisplayName): Promise<Result<{ readonly secret: string; readonly identified: Identified }, SignInError>>;
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

/** The `dev` cookie's secret of a request, when it has the shape of one. */
export function devSecret(headers: IncomingHttpHeaders): string | undefined {
    const secret = cookies(headers).get(DEV_COOKIE);
    return secret && SECRET.test(secret) ? secret : undefined;
}

const keyOf = (identity: IdentityKey): IdentityKey => ({ provider: identity.provider, subject: identity.subject });

export function createSessionIdentities(deps: SessionIdentitiesDeps): SessionIdentities {
    const { session, mode, access, collaboration, maxParticipants } = deps;
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
        const holder = await facilitatorKey();
        if (holder && sameIdentity(holder, identity)) return { participant: { id: FACILITATOR_PARTICIPANT, identity }, role: 'facilitator' };
        return { participant: { id: participantOf(identity), identity }, role: 'participant' };
    };

    /** Joins `identity` unless it did; refused when the session is full or not open. */
    const join = async (identity: Identity): Promise<Result<Collaboration.ParticipantId, SignInError>> => {
        if (closed) return err({ type: 'SessionAlreadyClosed' });
        const id = participantOf(identity);
        if (joined.has(id)) return ok(id);
        const state = await collaboration.sessionState({ session });
        if (!state.ok) return err({ type: 'SessionNotFound' });
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

        async identify(headers) {
            // a closed session identifies no one: neither a cached sign-in, nor the facilitator, nor a joined identity
            if (!(await isOpen())) return undefined;
            if (mode === 'dev') {
                const secret = devSecret(headers);
                if (!secret) return undefined;
                const hash = secretHash(secret);
                const signIn = signIns.get(hash) ?? (await access.signedIn(secret));
                if (!signIn || signIn.session !== session) return undefined;
                signIns.set(hash, signIn);
                return identified(signIn.identity);
            }
            const token = accessToken(headers, deps.acceptAccessCookie ?? false);
            const identity = token ? await deps.provider?.verify(token) : undefined;
            if (!identity) return undefined;
            const who = await identified(identity);
            if (who.role === 'facilitator') return who;
            return (await join(identity)).ok ? who : undefined;
        },

        async signIn(name) {
            if (mode !== 'dev') throw new Error('Only the dev identity mode signs in with a name');
            if (!(await isOpen())) return err({ type: 'SessionAlreadyClosed' });
            const identity: Identity = { provider: 'dev', subject: randomUUID(), displayName: name };
            const joinedAs = await join(identity);
            if (!joinedAs.ok) return joinedAs;
            const secret = await access.signIn({ session, identity });
            signIns.set(secretHash(secret), { session, identity });
            return ok({ secret, identified: await identified(identity) });
        },

        async signOut(headers) {
            const secret = devSecret(headers);
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
