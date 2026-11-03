// The page's frame (app/shell.tsx): the app bar across the top, the pillars under it.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import type { Panes } from './panes';
import { AppShell } from './shell';

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the shell reads of the panes
const panes = {
    explorerOpen: true,
    explorerWidth: 260,
    leftView: 'problems',
    inspectorOpen: true,
    inspectorDock: 'right',
    inspectorWidth: 320,
    inspectorHeight: 320,
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
            inspector={() => null}
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

    test('the activity bar keeps the tree and the changes', () => {
        const rail = html.slice(html.indexOf('class="activity-bar"'));
        expect([...rail.slice(0, rail.indexOf('</div>')).matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1])).toEqual(['サイドバーの一覧', '木', '差分']);
    });
});
