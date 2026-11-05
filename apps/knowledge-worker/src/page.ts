// The read-only page (ADR 0031, section 11): the files of `page/`, built from apps/web/published by DomainTrail's build
// and deployed with the Worker as its static assets. Every request reaches the Worker first (`run_worker_first`), so
// that the page, like the API, is served only to a caller whose Access token verifies (access.ts). The page holds no
// data; it reads the API of the same origin with the reader's Access cookie.
import { identify, type AccessSettings, type AccessTokenVerifier } from './access.js';
import type { Env } from './env.js';

/**
 * What the page's answers carry: its scripts and styles from its own origin only (React Flow sets inline styles), the
 * images of the knowledge from the API, never framed.
 */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
    'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
};

const text = (status: number, body: string): Response =>
    new Response(`${body}\n`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...PAGE_HEADERS } });

/** A request outside `/v1`: the page's files, to a caller Access let through. */
export async function servePage(request: Request, env: Env, verifier?: (settings: AccessSettings) => AccessTokenVerifier): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'The page is read with GET.');
    const caller = await identify(request, env, verifier);
    if (!('kind' in caller)) return text(caller.status, caller.message);
    if (!env.ASSETS) return text(404, 'This Worker was deployed without its page (the `assets` of wrangler.jsonc).');
    const url = new URL(request.url);
    // one page: every path without a file's extension is the page, its state in the query
    const file = /\.[A-Za-z0-9]+$/.test(url.pathname) ? url.pathname : '/';
    const res = await env.ASSETS.fetch(new Request(new URL(file, url.origin), { method: request.method, headers: request.headers }));
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(PAGE_HEADERS)) headers.set(k, v);
    // the page's HTML is read again on each visit (a new version after an upgrade); its hashed files are kept
    headers.set('Cache-Control', file === '/' ? 'no-cache' : 'private, max-age=31536000, immutable');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
