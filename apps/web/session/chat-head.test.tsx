// The right column's head (session/chat-head.tsx): チャット and AI の作業 as tabs, then ✕.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MESSAGES } from '../i18n';
import { ChatHead, type ChatView } from './chat-head';

const tx = MESSAGES.ja.session;
const render = (view: ChatView, unfinished: number): string =>
    renderToStaticMarkup(<ChatHead view={view} onView={() => {}} unfinished={unfinished} onClose={() => {}} tx={tx} />);
/** The visible text of some markup, its tags dropped. */
const text = (html: string): string =>
    html
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

describe("the right column's head", () => {
    test('two tabs, チャット then AI の作業, the one shown selected; then ✕', () => {
        const html = render('chat', 0);
        expect([...html.matchAll(/role="tab" aria-selected="(true|false)"[^>]*>([^<]+)/g)].map((m) => [m[1], m[2]])).toEqual([
            ['true', 'チャット'],
            ['false', 'AI の作業'],
        ]);
        expect(html).toContain('role="tablist" aria-label="チャットと AI の作業"');
        expect(html.indexOf('aria-label="チャットを閉じる"')).toBeGreaterThan(html.indexOf('AI の作業'));
        expect(text(render('history', 0))).toBe('チャット AI の作業');
        expect(render('history', 0)).toMatch(/aria-selected="true"[^>]*>AI の作業/);
    });

    test('AI の作業 counts what is not finished, whichever tab is shown; nothing when all is done', () => {
        expect(text(render('chat', 2))).toBe('チャット AI の作業 2');
        expect(render('chat', 0)).not.toContain('chat-views-badge');
    });
});
