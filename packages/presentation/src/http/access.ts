import type { IncomingHttpHeaders } from 'node:http';

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

/**
 * Host names the server answers to; anything else (e.g. a DNS-rebinding domain) is rejected.
 * Binding to a wildcard address is an explicit opt-in to network access, so any Host is accepted then.
 */
export function hostAllowList(bind: string): (hostname: string) => boolean {
    if (bind === '0.0.0.0' || bind === '::') return () => true;
    return (hostname) => LOOPBACK.includes(hostname) || hostname === bind;
}

/**
 * The one access check of the Live View, for every `/api/*` request and the `/ws` upgrade (see `createViewHttpServer`).
 * The model may be confidential: reject requests whose Host is unexpected (DNS rebinding) and cross-origin
 * browser requests (browsers do not apply the same-origin policy to WebSockets). Non-browser clients send no Origin.
 * A later authorization is added here.
 */
export function checkAccess(headers: IncomingHttpHeaders, allowedHost: (hostname: string) => boolean): 'ok' | 'forbidden' {
    const host = headers.host;
    if (!host) return 'forbidden';
    try {
        if (!allowedHost(new URL(`http://${host}`).hostname)) return 'forbidden';
    } catch {
        return 'forbidden';
    }
    const origin = headers.origin;
    if (!origin) return 'ok';
    try {
        return new URL(origin).host === host ? 'ok' : 'forbidden';
    } catch {
        return 'forbidden';
    }
}
