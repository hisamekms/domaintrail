import type { IncomingHttpHeaders } from 'node:http';
import type { Actor, Collaboration, Identity } from '@domaintrail/collaboration';
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

/** Who sent a request: their participant and role, and the `Actor` the collaboration's use cases take. */
export interface Identified {
    readonly participant: SessionParticipant;
    readonly role: Role;
    readonly actor: Actor;
}

/**
 * What the access check decides about a request: refused (unexpected Host or Origin), let in without an identity
 * (always so in the read-only Live View; in a session, someone who has not signed in), or a participant with their role.
 */
export type Authorization = { readonly kind: 'forbidden' } | { readonly kind: 'anonymous' } | ({ readonly kind: 'participant' } & Identified);

/** Who sent a request whose Host and Origin passed, or `undefined` (no identity). */
export type Identify = (headers: IncomingHttpHeaders) => Promise<Identified | undefined>;

/** What the access check applies. */
export interface AccessPolicy {
    /** The Host names answered to (see `hostAllowList`). */
    readonly allowedHost: (hostname: string) => boolean;
    /** Whether a browser's `Origin` may call; default: the same host as the request's `Host`. */
    readonly allowedOrigin?: (origin: URL, host: string) => boolean;
    /** A session's identities; absent in the read-only Live View, where everyone admitted is anonymous. */
    readonly identify?: Identify;
    /**
     * Whether a request that changes something (any method but GET and HEAD, and the WebSocket's upgrade) must carry an
     * allowed `Origin`: a session open to the internet (`link`) refuses one without it, so that only its own pages make
     * them (the CSRF check, with the SameSite=Strict cookie). Default: false (non-browser clients send no Origin).
     */
    readonly requireOrigin?: boolean;
}

const sameHost = (origin: URL, host: string): boolean => origin.host === host;

/**
 * The one access check of the Live View and of a session, for every request it guards and the `/ws` upgrade (see
 * `createViewHttpServer`). The model may be confidential: reject requests whose Host is unexpected (DNS rebinding) and
 * cross-origin browser requests (browsers do not apply the same-origin policy to WebSockets); non-browser clients send
 * no Origin. Then, in a session, who is asking. The read-only Live View has no identities: its answers are `forbidden` and
 * `anonymous`, as `'forbidden'` and `'ok'` were before.
 */
export async function checkAccess(headers: IncomingHttpHeaders, policy: AccessPolicy, changes = false): Promise<Authorization> {
    if (!hostAndOriginAllowed(headers, policy)) return { kind: 'forbidden' };
    if (changes && policy.requireOrigin && !headers.origin) return { kind: 'forbidden' };
    if (!policy.identify) return { kind: 'anonymous' };
    const who = await policy.identify(headers);
    return who ? { kind: 'participant', participant: who.participant, role: who.role, actor: who.actor } : { kind: 'anonymous' };
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

/** Whether a request of `method` changes something: anything but a read (the `requireOrigin` check). */
export const changesState = (method: string | undefined): boolean => method !== 'GET' && method !== 'HEAD';

/** Whether a socket's remote address is this machine (IPv4, IPv6, or IPv4 mapped into IPv6). */
export const isLoopbackAddress = (address: string | undefined): boolean =>
    address !== undefined && (address === '::1' || /^(::ffff:)?127\.\d+\.\d+\.\d+$/.test(address));

/** The header the local `cloudflared` puts the visitor's address in. */
const CONNECTING_IP = 'cf-connecting-ip';

/**
 * Who a request comes from, as a key for a rate limit: the socket's remote address, unless `trustForwarded` (this
 * process started the `cloudflared` quick tunnel itself: `dt collab --tunnel`), that address is this machine and the
 * request carries `CF-Connecting-IP` (the visitor's address, as that `cloudflared` forwards it). Otherwise the header is
 * never read: a local reverse proxy or any other local client could say anything in it.
 */
export function clientKey(remoteAddress: string | undefined, headers: IncomingHttpHeaders, trustForwarded = false): string {
    const forwarded = headers[CONNECTING_IP];
    if (trustForwarded && isLoopbackAddress(remoteAddress) && typeof forwarded === 'string' && /^[0-9a-f.:]{2,45}$/i.test(forwarded.trim()))
        return forwarded.trim().toLowerCase();
    return remoteAddress ?? 'unknown';
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
