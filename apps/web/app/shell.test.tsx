// The page's frame (app/shell.tsx): the app bar across the top, the pillars under it.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import type { Panes } from './panes';
import { AppShell } from './shell';

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the shell reads of the panes
const panes = {
    explorerOpen: true,
    explorerWidth: 280,
    leftView: 'problems',
    inspectorOpen: true,
    detailHeight: 300,
    conversationOpen: false,
    conversationWidth: 380,
} as unknown as Panes;

const html = renderToStaticMarkup(
    <I18nProvider lang="ja">
        <AppShell
            panes={panes}
            workspaceName="shop"
            world={<div className="world-slot" />}
            sessionSlot={() => {}}
            lists={{
                tree: { count: 0, content: null },
                problems: { count: 2, badge: <span className="activity-badge badge-error">2</span>, content: null },
                changes: { count: 0, content: null },
            }}
            health={null}
            settings={null}
            banners={null}
            workspace={null}
            inspector={<div className="inspector-slot" />}
            overlays={null}
        />
    </I18nProvider>,
);
const appBar = html.slice(html.indexOf('<header class="app-bar">'), html.indexOf('</header>'));

describe('the app bar', () => {
    test('the brand and the workspace, the world switch, then 問題 and the session’s place at the right end', () => {
        expect(appBar).toContain('<span class="brand">DomainTrail</span>');
        expect(appBar).toContain('>shop</span>');
        const order = ['brand', 'world-slot', 'app-bar-space', 'app-bar-problems', 'app-bar-session'].map((c) => appBar.indexOf(c));
        expect(order.every((at) => at >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    test('問題 shows its count and opens the problems list (pressed while it is shown)', () => {
        expect(appBar).toMatch(/class="activity app-bar-problems active" aria-pressed="true" aria-label="問題（2）"/);
        expect(appBar).toContain('<span class="activity-badge badge-error">2</span>');
    });

    test('on the first display the panes do not move (no motion until the person acts)', () => {
        expect(html).toContain('<div class="app motion-none">');
    });

    test('the activity bar keeps the tree and the changes', () => {
        const rail = html.slice(html.indexOf('class="activity-bar"'));
        expect([...rail.slice(0, rail.indexOf('</div>')).matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1])).toEqual(['サイドバーの一覧', '木', '差分']);
    });
});

describe('the left column', () => {
    const left = html.slice(html.indexOf('<div class="left open"'), html.indexOf('<div class="main">'));

    // not laid out here: the column is not measured, so the detail has no height yet (the first frame takes the measured one)
    test('the navigator on top, then the splitter, then the detail (the inspector), its height left to the measure', () => {
        const order = ['class="navigator"', 'class="resizer resizer-y resizer-grip"', 'class="detail open"><div class="rail"', 'inspector-slot'].map((c) =>
            left.indexOf(c),
        );
        expect(order.every((at) => at >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        // the canvas column holds no inspector any more
        expect(html.slice(html.indexOf('<div class="main">'))).not.toContain('inspector-slot');
    });

    test('the splitter is a focusable horizontal separator with its value', () => {
        const splitter = /<div class="resizer resizer-y resizer-grip"[^>]*>/.exec(left)?.[0] ?? '';
        expect(splitter).toContain('role="separator"');
        expect(splitter).toContain('tabindex="0"');
        expect(splitter).toContain('aria-orientation="horizontal"');
        expect(splitter).toContain('aria-valuenow="140"');
        expect(splitter).toContain('aria-valuemin="140"');
        expect(splitter).toContain('aria-label="詳細の高さ');
    });

    test("the column's own edge is a vertical separator after it", () => {
        const edge = html.slice(html.indexOf('<div class="left-foot">'), html.indexOf('<div class="main">'));
        expect(edge).toMatch(
            /<div class="resizer resizer-x" role="separator" tabindex="0" aria-label="左の列の幅[^"]*" aria-orientation="vertical" aria-valuenow="280"/,
        );
    });
});

describe('the right column', () => {
    const withChat = renderToStaticMarkup(
        <I18nProvider lang="ja">
            <AppShell
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the shell reads of the panes
                panes={{ ...panes, conversationOpen: true } as Panes}
                workspaceName="shop"
                world={null}
                sessionSlot={() => {}}
                lists={{ tree: { count: 0, content: null }, problems: { count: 0, content: null }, changes: { count: 0, content: null } }}
                health={null}
                settings={null}
                banners={null}
                workspace={null}
                inspector={<div className="inspector-slot" />}
                conversation={{ content: <div className="chat-slot" />, launcher: <div className="launcher" /> }}
                overlays={null}
            />
        </I18nProvider>,
    );

    test('the chat is a column of its own after the canvas, with the detail still in the left column', () => {
        const order = ['inspector-slot', 'class="main"', 'aria-label="チャットの幅', 'class="conversation open" style="width:380px"', 'chat-slot'].map((c) =>
            withChat.indexOf(c),
        );
        expect(order.every((at) => at >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        // open, it needs no launcher over the canvas
        expect(withChat).not.toContain('class="launcher"');
    });

    test('its edge is a focusable vertical separator with its width', () => {
        expect(withChat).toMatch(
            /<div class="resizer resizer-x" role="separator" tabindex="0" aria-label="チャットの幅[^"]*" aria-orientation="vertical" aria-valuenow="380"/,
        );
    });
});
