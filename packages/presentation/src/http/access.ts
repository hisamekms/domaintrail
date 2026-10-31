import type { IncomingHttpHeaders } from 'node:http';
import type { Identity } from '@domaintrail/collaboration/application/identity';
import type { Collaboration } from '@domaintrail/collaboration/generated/index';
import type { Role } from '@domaintrail/collaboration/protocol';

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

/** Whether `hostname` (as `URL.hostname` gives it) names this machine. */
export const isLoopbackHost = (hostname: string): boolean => LOOPBACK.includes(hostname);

/** Whether a bind address is a loopback address (a session in `dev` mode binds nothing else). */
export const isLoopbackBind = (bind: string): boolean => bind === 'localhost' || bind === '::1' || /^127\.\d+\.\d+\.\d+$/.test(bind);

/**
 * Host names the server answers to; anything else (e.g. a DNS-rebinding domain) is rejected.
 * Binding to a wildcard address is an explicit opt-in to network access, so any Host is accepted then.
 */
export function hostAllowList(bind: string): (hostname: string) => boolean {
    if (bind === '0.0.0.0' || bind === '::') return () => true;
    return (hostname) => LOOPBACK.includes(hostname) || hostname === bind;
}

/** A participant of the session, as the server knows them after the access check. */
export interface SessionParticipant {
    readonly id: Collaboration.ParticipantId;
    readonly identity: Identity;
}

/**
 * What the access check decides about a request: refused (unexpected Host or Origin), let in without an identity
 * (always so in `dt view`; in a session, someone who has not signed in), or a participant with their role.
 */
export type Authorization =
    | { readonly kind: 'forbidden' }
    | { readonly kind: 'anonymous' }
    | { readonly kind: 'participant'; readonly participant: SessionParticipant; readonly role: Role };

/** Who sent a request whose Host and Origin passed: their participant and role, or `undefined` (no identity). */
export type Identify = (headers: IncomingHttpHeaders) => Promise<{ readonly participant: SessionParticipant; readonly role: Role } | undefined>;

/** What the access check applies. */
export interface AccessPolicy {
    /** The Host names answered to (see `hostAllowList`). */
    readonly allowedHost: (hostname: string) => boolean;
    /** Whether a browser's `Origin` may call; default: the same host as the request's `Host`. */
    readonly allowedOrigin?: (origin: URL, host: string) => boolean;
    /** A session's identities; absent in `dt view`, where everyone admitted is anonymous. */
    readonly identify?: Identify;
}

const sameHost = (origin: URL, host: string): boolean => origin.host === host;

/**
 * The one access check of the Live View and of a session, for every request it guards and the `/ws` upgrade (see
 * `createViewHttpServer`). The model may be confidential: reject requests whose Host is unexpected (DNS rebinding) and
 * cross-origin browser requests (browsers do not apply the same-origin policy to WebSockets); non-browser clients send
 * no Origin. Then, in a session, who is asking. `dt view` has no identities: its answers are `forbidden` and
 * `anonymous`, as `'forbidden'` and `'ok'` were before.
 */
export async function checkAccess(headers: IncomingHttpHeaders, policy: AccessPolicy): Promise<Authorization> {
    if (!hostAndOriginAllowed(headers, policy)) return { kind: 'forbidden' };
    if (!policy.identify) return { kind: 'anonymous' };
    const who = await policy.identify(headers);
    return who ? { kind: 'participant', participant: who.participant, role: who.role } : { kind: 'anonymous' };
}

function hostAndOriginAllowed(headers: IncomingHttpHeaders, policy: AccessPolicy): boolean {
    const host = headers.host;
    if (!host) return false;
    try {
        if (!policy.allowedHost(new URL(`http://${host}`).hostname)) return false;
    } catch {
        return false;
    }
    const origin = headers.origin;
    if (!origin) return true;
    try {
        return (policy.allowedOrigin ?? sameHost)(new URL(origin), host);
    } catch {
        return false;
    }
}

/**
 * The Host and Origin rules of a session: loopback names, plus the configured `allowedHosts`; an Origin of the same
 * host when that host is loopback, else one of the configured `allowedOrigins`. Nothing external without them.
 */
export function sessionHostPolicy(allowedHosts: readonly string[], allowedOrigins: readonly string[]): Pick<AccessPolicy, 'allowedHost' | 'allowedOrigin'> {
    const hosts = new Set(allowedHosts.map((h) => h.toLowerCase()));
    const origins = new Set(allowedOrigins);
    return {
        allowedHost: (hostname) => isLoopbackHost(hostname) || hosts.has(hostname.toLowerCase()),
        allowedOrigin: (origin, host) => (origins.has(origin.origin) && origin.host === host) || (origin.host === host && isLoopbackHost(origin.hostname)),
    };
}
