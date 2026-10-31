// The few pages of a session that are not the Live View: the join form of the `dev` identity mode (a name, posted to
// `/session/join`) and the answers of the facilitator link. Self-contained HTML (no script, inline style), served with
// a restrictive Content-Security-Policy.
import type { ServerResponse } from 'node:http';

const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const STYLE = `body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#1f2328}
main{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:24px 28px;max-width:360px;width:100%}
h1{font-size:18px;margin:0 0 12px}label{display:block;margin-bottom:6px}input{width:100%;box-sizing:border-box;padding:6px 8px;font:inherit}
button{margin-top:12px;padding:6px 14px;font:inherit}.error{color:#cf222e}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}main{background:#161b22;border-color:#30363d}}`;

/** Where a page may send the browser after it: a path of this server (`/` or a facilitator link), else `/`. */
export function safeNext(next: string | null | undefined): string {
    if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
    return next === '/' || next.startsWith('/session/facilitator?') ? next : '/';
}

export function sendPage(res: ServerResponse, status: number, title: string, body: string, headers: Record<string, string | string[]> = {}): void {
    res.writeHead(status, {
        'content-type': 'text/html;charset=utf-8',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        ...headers,
    });
    res.end(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`,
    );
}

/** The join form (dev): a name, then back to `next`. */
export function joinPage(res: ServerResponse, status: number, next: string, error?: string): void {
    sendPage(
        res,
        status,
        'Join the session',
        `<h1>Join the DomainTrail session</h1>
<form method="post" action="/session/join">
<label for="name">Your name, as the others will see it</label>
<input id="name" name="name" maxlength="60" required autofocus autocomplete="nickname">
<input type="hidden" name="next" value="${escape(safeNext(next))}">
${error ? `<p class="error">${escape(error)}</p>` : ''}
<button type="submit">Join</button>
</form>`,
    );
}

export function messagePage(res: ServerResponse, status: number, title: string, message: string): void {
    sendPage(res, status, title, `<h1>${escape(title)}</h1><p>${escape(message)}</p><p><a href="/">Back to the session</a></p>`);
}
