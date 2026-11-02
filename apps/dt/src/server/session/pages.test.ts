// The session's server-rendered pages: their language, the remembered name and the escaping (over HTTP:
// test/session-server.test.ts, "the join form (dev)").
import type { ServerResponse } from 'node:http';
import { describe, expect, test } from 'bun:test';
import type { Collaboration } from '@domaintrail/collaboration';
import { joinPage, messagePage, NAME_COOKIE, nameCookie, pageLanguage, rememberedName } from './pages.js';

/** What a page wrote: its status, headers and body. */
function written(render: (res: ServerResponse) => void): { status: number; headers: Record<string, unknown>; body: string } {
    const out = { status: 0, headers: {} as Record<string, unknown>, body: '' };
    const res = {
        writeHead(status: number, headers: Record<string, unknown>): void {
            out.status = status;
            out.headers = headers;
        },
        end(body: string): void {
            out.body = body;
        },
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stand-in with the two methods the pages call
    render(res as unknown as ServerResponse);
    return out;
}

const name = (s: string): Collaboration.DisplayName =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a name of the test, valid by construction
    s as Collaboration.DisplayName;

describe('the language of a page', () => {
    test('Japanese when the best supported match is ja (any ja-*), English otherwise', () => {
        expect(pageLanguage('ja')).toBe('ja');
        expect(pageLanguage('ja-JP')).toBe('ja');
        expect(pageLanguage('ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7')).toBe('ja');
        expect(pageLanguage('en-US,ja;q=0.8')).toBe('en');
        expect(pageLanguage('fr')).toBe('en');
        expect(pageLanguage('fr-FR,ja;q=0.5')).toBe('ja');
        expect(pageLanguage(undefined)).toBe('en');
        expect(pageLanguage('')).toBe('en');
    });

    test('respects q-values, the first listed on a tie; a q of 0 or a broken one is no match', () => {
        expect(pageLanguage('en;q=0.5, ja;q=0.6')).toBe('ja');
        expect(pageLanguage('ja;q=0.5, en;q=0.5')).toBe('ja');
        expect(pageLanguage('JA-jp; Q=0.4, en;q=0.3')).toBe('ja');
        expect(pageLanguage('ja;q=0, en;q=0.1')).toBe('en');
        expect(pageLanguage('ja;q=x')).toBe('en');
        expect(pageLanguage('*;q=0.9, ja;q=0.8')).toBe('en');
        expect(pageLanguage(';;,,=,q=')).toBe('en');
    });

    test('a page states its language and varies by Accept-Language', () => {
        const ja = written((res) => messagePage(res, 'ja', 404, 'notFound'));
        expect(ja.body).toContain('<html lang="ja">');
        expect(ja.body).toContain('<h1>ページがありません</h1>');
        expect(ja.body).toContain('セッションに戻る');
        expect(ja.headers.vary).toBe('Accept-Language');
        const en = written((res) => messagePage(res, 'en', 404, 'notFound'));
        expect(en.body).toContain('<html lang="en">');
        expect(en.body).toContain('Back to the session');
    });
});

describe('the join form', () => {
    test('in Japanese and English', () => {
        const ja = written((res) => joinPage(res, 'ja', 200, '/', { error: 'sessionFull' })).body;
        expect(ja).toContain('<h1>DomainTrail のセッションに参加</h1>');
        expect(ja).toContain('ほかの参加者に見える名前');
        expect(ja).toContain('>参加する</button>');
        expect(ja).toContain('セッションの参加者が上限に達しています。');
        const en = written((res) => joinPage(res, 'en', 200, '/')).body;
        expect(en).toContain('<h1>Join the DomainTrail session</h1>');
        expect(en).not.toContain('class="error"');
    });

    test('starts empty, or with the remembered name, escaped', () => {
        expect(written((res) => joinPage(res, 'en', 200, '/')).body).not.toContain(' value=""');
        expect(written((res) => joinPage(res, 'en', 200, '/')).body).toMatch(/autocomplete="nickname">/);
        const body = written((res) => joinPage(res, 'en', 200, '/', { name: `"><script>alert('x')</script>&` })).body;
        expect(body).toContain('value="&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;"');
        expect(body).not.toContain('<script>');
    });
});

describe('the remembered name', () => {
    const cookie = (value: string): { cookie: string } => ({ cookie: `dt_session=abc; ${NAME_COOKIE}=${value}` });

    test('a cookie of the name, long-lived, HttpOnly, SameSite=Lax, Secure only over https', () => {
        expect(nameCookie(name('Ada; Lovelace'), false)).toBe(`${NAME_COOKIE}=Ada%3B%20Lovelace; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
        expect(nameCookie(name('Ada'), true)).toEndWith('; Secure');
    });

    test('read back when it is a valid name, else ignored', () => {
        expect(rememberedName(cookie(encodeURIComponent('大山 進之介')))).toBe(name('大山 進之介'));
        expect(rememberedName(cookie('Ada%3B%20Lovelace'))).toBe(name('Ada; Lovelace'));
        expect(rememberedName(cookie('%20Ada%20'))).toBe(name('Ada'));
        expect(rememberedName({})).toBeUndefined();
        expect(rememberedName(cookie(''))).toBeUndefined();
        expect(rememberedName(cookie('%20'))).toBeUndefined();
        expect(rememberedName(cookie('%E0%A4%A'))).toBeUndefined();
        expect(rememberedName(cookie('Ada%0ALovelace'))).toBeUndefined();
        expect(rememberedName(cookie('x'.repeat(61)))).toBeUndefined();
    });
});
