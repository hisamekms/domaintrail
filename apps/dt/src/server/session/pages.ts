// The few pages of a session that are not the Live View: the join form of the `dev` identity mode (a name, posted to
// `/session/join`) and the answers of the facilitator link. Self-contained HTML (no script, inline style), served with
// a restrictive Content-Security-Policy, in the browser's language (English or Japanese; the texts are `page-texts.ts`).
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { Collaboration } from '@domaintrail/collaboration';
import { cookies } from './identities.js';
import { displayName } from './input.js';
import { type JoinError, PAGE_TEXTS, type PageLanguage, type PageMessage } from './page-texts.js';

export type { JoinError, PageLanguage, PageMessage } from './page-texts.js';

/** The cookie that remembers the name a browser last joined with, offered by the next join form (on any port of the host). */
export const NAME_COOKIE = 'dt_name';
/** How long the browser remembers the name. */
const NAME_MAX_AGE = 365 * 24 * 60 * 60;

const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const STYLE = `:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#1f2328}
main{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:24px 28px;max-width:360px;width:100%}
h1{font-size:18px;margin:0 0 12px}label{display:block;margin-bottom:6px}input{width:100%;box-sizing:border-box;padding:6px 8px;font:inherit}
button{margin-top:12px;padding:6px 14px;font:inherit}.error{color:#cf222e}a{color:#0969da}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}main{background:#161b22;border-color:#30363d}a{color:#4493f8}.error{color:#ff7b72}}`;

/**
 * The language of a page from the request's `Accept-Language`: the supported language (`ja` and any `ja-*`, `en` and
 * any `en-*`, `*` as English) of the highest q-value, the first listed on a tie; English when none is, or without the
 * header.
 */
export function pageLanguage(acceptLanguage: string | undefined): PageLanguage {
    let best: { readonly language: PageLanguage; readonly q: number } | undefined;
    for (const entry of (acceptLanguage ?? '').split(',')) {
        const [tag = '', ...params] = entry.split(';').map((p) => p.trim().toLowerCase());
        const language = tag === 'ja' || tag.startsWith('ja-') ? 'ja' : tag === 'en' || tag.startsWith('en-') || tag === '*' ? 'en' : undefined;
        if (!language) continue;
        const qParam = params.find((p) => p.startsWith('q='));
        const q = qParam === undefined ? 1 : Number(qParam.slice(2));
        if (!Number.isFinite(q) || q <= 0 || q > 1) continue;
        if (!best || q > best.q) best = { language, q };
    }
    return best?.language ?? 'en';
}

/** The name the browser of these headers last joined with (`NAME_COOKIE`), when it is still a valid name. */
export function rememberedName(headers: IncomingHttpHeaders): Collaboration.DisplayName | undefined {
    const raw = cookies(headers).get(NAME_COOKIE);
    if (!raw) return undefined;
    let decoded: string;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        return undefined;
    }
    const name = displayName(decoded);
    return name.ok ? name.value : undefined;
}

/** The cookie that remembers `name` for the next join form (`Secure` as the session's cookie is). */
export function nameCookie(name: Collaboration.DisplayName, secure: boolean): string {
    const parts = [`${NAME_COOKIE}=${encodeURIComponent(name)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${NAME_MAX_AGE}`];
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

/** Where a page may send the browser after it: a path of this server (`/` or a facilitator link), else `/`. */
export function safeNext(next: string | null | undefined): string {
    if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
    return next === '/' || next.startsWith('/session/facilitator?') ? next : '/';
}

export function sendPage(
    res: ServerResponse,
    language: PageLanguage,
    status: number,
    title: string,
    body: string,
    headers: Record<string, string | string[]> = {},
): void {
    res.writeHead(status, {
        'content-type': 'text/html;charset=utf-8',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        // the language is the browser's
        vary: 'Accept-Language',
        // not `no-referrer`: under it a browser posts the join form with `Origin: null`, which the Origin check refuses
        'referrer-policy': 'same-origin',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        ...headers,
    });
    res.end(
        `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`,
    );
}

/** The join form (dev): a name (the remembered one, if any), then back to `next`. */
export function joinPage(
    res: ServerResponse,
    language: PageLanguage,
    status: number,
    next: string,
    options: { readonly name?: string; readonly error?: JoinError } = {},
): void {
    const t = PAGE_TEXTS[language].join;
    sendPage(
        res,
        language,
        status,
        t.title,
        `<h1>${escape(t.heading)}</h1>
<form method="post" action="/session/join">
<label for="name">${escape(t.name)}</label>
<input id="name" name="name" maxlength="60" required autofocus autocomplete="nickname"${options.name ? ` value="${escape(options.name)}"` : ''}>
<input type="hidden" name="next" value="${escape(safeNext(next))}">
${options.error ? `<p class="error">${escape(t.errors[options.error])}</p>` : ''}
<button type="submit">${escape(t.submit)}</button>
</form>`,
    );
}

export function messagePage(res: ServerResponse, language: PageLanguage, status: number, message: PageMessage): void {
    const texts = PAGE_TEXTS[language];
    const { title, message: text } = texts.messages[message];
    sendPage(res, language, status, title, `<h1>${escape(title)}</h1><p>${escape(text)}</p><p><a href="/">${escape(texts.backToSession)}</a></p>`);
}
