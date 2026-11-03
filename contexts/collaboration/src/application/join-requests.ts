// The join requests of the `link` identity mode: someone who opened the session's invite link and gave a name asks to
// join, and waits until the facilitator approves or denies them. Kept in the server's memory only (they live minutes
// and die with the server): the visitor holds a secret (a cookie of the waiting page) of which only the SHA-256 is
// kept; the facilitator sees each pending request's ID and name. A request expires after `ttlMs` or with the invite it
// came through, whichever is first; an approved one is admitted once (the visitor's next look at the waiting page
// signs them in). Bounded: at most `maxPending` pending at once, `perInvite` requests in all through one invite
// (whatever the client says it is), and `perKey` requests per `windowMs` from one client key (the caller decides what a
// key is: the client's address).
import { err, ok, type Collaboration, type Result } from '../generated/index.js';
import { secretHash } from './access.js';
import type { Clock, SecretGenerator } from './ports.js';

/** How long a request waits for the facilitator, unless its invite expires first. */
export const JOIN_REQUEST_TTL_MS = 10 * 60_000;
/** Most requests pending at once. */
export const MAX_PENDING_JOIN_REQUESTS = 20;
/** Most requests from one client key per window. */
export const JOIN_REQUESTS_PER_KEY = 5;
export const JOIN_REQUEST_WINDOW_MS = 10 * 60_000;
/** Most requests through one invite, from anyone. */
export const JOIN_REQUESTS_PER_INVITE = 100;

export type JoinRequestState = 'pending' | 'approved' | 'denied';

/** A join request as the facilitator sees it: never its secret, nor the client key it came from. */
export interface JoinRequest {
    readonly id: string;
    readonly name: Collaboration.DisplayName;
    readonly requestedAt: Date;
    readonly expiresAt: Date;
    readonly state: JoinRequestState;
}

/** Too many requests are pending: the facilitator decides some first. */
export interface TooManyPending {
    readonly type: 'TooManyPending';
    readonly max: number;
}

/** Too many requests from one client key: try again later. */
export interface RateLimited {
    readonly type: 'RateLimited';
    readonly retryAfterMs: number;
}

/** As many requests were made through this invite as it takes: the facilitator makes another. */
export interface InviteExhausted {
    readonly type: 'InviteExhausted';
    readonly max: number;
}

/** The request is unknown, expired or decided already. */
export interface JoinRequestNotFound {
    readonly type: 'JoinRequestNotFound';
}

/** What the visitor's waiting page learns from its secret: the request's state, or `expired` (unknown, gone). */
export type JoinRequestStatus = { readonly state: JoinRequestState; readonly request: JoinRequest } | { readonly state: 'expired' };

export interface JoinRequests {
    /** A new pending request of `name`, from the client `key`, through an invite that expires at `inviteExpiresAt`. */
    request(input: {
        readonly name: Collaboration.DisplayName;
        readonly key: string;
        readonly inviteExpiresAt: Date;
    }): Result<{ readonly id: string; readonly secret: string }, TooManyPending | RateLimited | InviteExhausted>;
    /** The request of the visitor's secret. */
    status(secret: string): JoinRequestStatus;
    /** The pending requests, oldest first. */
    pending(): JoinRequest[];
    /** The facilitator lets the pending request `id` in. */
    approve(id: string): Result<JoinRequest, JoinRequestNotFound>;
    /** The facilitator turns the pending request `id` away. */
    deny(id: string): Result<JoinRequest, JoinRequestNotFound>;
    /** Takes the approved request of the visitor's secret, once: it is gone afterwards. */
    admit(secret: string): JoinRequest | undefined;
    /** The invite was revoked or replaced: every request still pending expires, and the count of the next invite starts. */
    expirePending(): void;
    /** Drops what expired by now: whether the pending requests changed. */
    sweep(): boolean;
}

interface Entry {
    request: JoinRequest;
    readonly secretHash: string;
}

export function createJoinRequests(deps: {
    readonly clock: Clock;
    readonly secrets: SecretGenerator;
    readonly ttlMs?: number;
    readonly maxPending?: number;
    readonly perKey?: number;
    readonly windowMs?: number;
    readonly perInvite?: number;
}): JoinRequests {
    const { clock, secrets } = deps;
    const ttlMs = deps.ttlMs ?? JOIN_REQUEST_TTL_MS;
    const maxPending = deps.maxPending ?? MAX_PENDING_JOIN_REQUESTS;
    const perKey = deps.perKey ?? JOIN_REQUESTS_PER_KEY;
    const windowMs = deps.windowMs ?? JOIN_REQUEST_WINDOW_MS;
    const perInvite = deps.perInvite ?? JOIN_REQUESTS_PER_INVITE;
    /** The requests made through the current invite. */
    let madeThroughInvite = 0;
    /** By ID. */
    const entries = new Map<string, Entry>();
    /** By the hash of the visitor's secret: the ID. */
    const bySecret = new Map<string, string>();
    /** When each client key asked, within the window. */
    const asked = new Map<string, number[]>();

    const drop = (id: string): void => {
        const entry = entries.get(id);
        if (!entry) return;
        entries.delete(id);
        bySecret.delete(entry.secretHash);
    };

    const sweep = (): boolean => {
        const now = clock.now().getTime();
        let changed = false;
        for (const [id, entry] of entries)
            if (entry.request.expiresAt.getTime() <= now) {
                changed ||= entry.request.state === 'pending';
                drop(id);
            }
        for (const [key, times] of asked) {
            const recent = times.filter((t) => t > now - windowMs);
            if (recent.length) asked.set(key, recent);
            else asked.delete(key);
        }
        return changed;
    };

    const pendingOf = (id: string): Entry | undefined => {
        sweep();
        const entry = entries.get(id);
        return entry?.request.state === 'pending' ? entry : undefined;
    };

    const decide = (id: string, state: 'approved' | 'denied'): Result<JoinRequest, JoinRequestNotFound> => {
        const entry = pendingOf(id);
        if (!entry) return err({ type: 'JoinRequestNotFound' });
        entry.request = { ...entry.request, state };
        return ok(entry.request);
    };

    return {
        request({ name, key, inviteExpiresAt }) {
            sweep();
            const now = clock.now();
            if (madeThroughInvite >= perInvite) return err({ type: 'InviteExhausted', max: perInvite });
            const times = asked.get(key) ?? [];
            if (times.length >= perKey) return err({ type: 'RateLimited', retryAfterMs: Math.max(0, times[0] + windowMs - now.getTime()) });
            if ([...entries.values()].filter((e) => e.request.state === 'pending').length >= maxPending)
                return err({ type: 'TooManyPending', max: maxPending });
            asked.set(key, [...times, now.getTime()]);
            madeThroughInvite++;
            const id = secrets.newSecret().slice(0, 22);
            const secret = secrets.newSecret();
            const expiresAt = new Date(Math.min(now.getTime() + ttlMs, inviteExpiresAt.getTime()));
            const hash = secretHash(secret);
            entries.set(id, { request: { id, name, requestedAt: now, expiresAt, state: 'pending' }, secretHash: hash });
            bySecret.set(hash, id);
            return ok({ id, secret });
        },

        status(secret) {
            sweep();
            const id = bySecret.get(secretHash(secret));
            const entry = id === undefined ? undefined : entries.get(id);
            return entry ? { state: entry.request.state, request: entry.request } : { state: 'expired' };
        },

        pending() {
            sweep();
            return [...entries.values()]
                .map((e) => e.request)
                .filter((r) => r.state === 'pending')
                .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
        },

        approve: (id) => decide(id, 'approved'),
        deny: (id) => decide(id, 'denied'),

        admit(secret) {
            sweep();
            const id = bySecret.get(secretHash(secret));
            const entry = id === undefined ? undefined : entries.get(id);
            if (entry?.request.state !== 'approved') return undefined;
            drop(entry.request.id);
            return entry.request;
        },

        expirePending() {
            madeThroughInvite = 0;
            for (const [id, entry] of entries) if (entry.request.state === 'pending') drop(id);
        },

        sweep,
    };
}
