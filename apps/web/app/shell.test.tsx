// The page's frame (app/shell.tsx): the app bar across the top, the pillars under it.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { I18nProvider } from '../i18n';
import { SearchButton } from '../search/entry';
import type { Panes } from './panes';
import { AppShell } from './shell';

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the shell reads of the panes
const panes = {
    explorerOpen: true,
    explorerWidth: 280,
    leftView: 'problems',
    treeHeight: 300,
    treeFolded: false,
    conversationOpen: false,
    conversationWidth: 380,
} as unknown as Panes;

const html = renderToStaticMarkup(
    <I18nProvider lang="ja">
        <AppShell
            panes={panes}
            workspaceName="shop"
            world={<div className="world-slot" />}
            find={<div className="find-slot" />}
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
const appBar = html.slice(html.indexOf('<header class="app-bar"'), html.indexOf('</header>'));

describe('the app bar', () => {
    test('the brand and the workspace, the world switch, 探す in the middle, then 問題 and the session’s place at the right end', () => {
        expect(appBar).toContain('<span class="brand">DomainTrail</span>');
        expect(appBar).toContain('>shop</span>');
        expect(appBar).toContain('<div class="app-bar-middle"><div class="find-slot"></div></div>');
        const order = ['brand', 'world-slot', 'app-bar-journey', 'app-bar-middle', 'app-bar-problems', 'app-bar-session'].map((c) => appBar.indexOf(c));
        expect(order.every((at) => at >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    test('問題 shows its count and opens the problems list (pressed while it is shown)', () => {
        expect(appBar).toMatch(/class="activity app-bar-problems active" aria-pressed="true" aria-label="問題（2）"/);
        expect(appBar).toContain('<span class="activity-badge badge-error">2</span>');
    });

    test('探す: 🔍, its name and its key — ⌘K on a Mac, Ctrl K elsewhere', () => {
        const button = (mac: boolean): string =>
            renderToStaticMarkup(
                <I18nProvider lang="ja">
                    <SearchButton mac={mac} onOpen={() => {}} />
                </I18nProvider>,
            );
        expect(button(true)).toMatch(/^<button type="button" class="app-bar-find" aria-label="探す" aria-keyshortcuts="Meta\+K"/);
        expect(button(true)).toContain('<span class="app-bar-find-label">探す</span><kbd>⌘K</kbd>');
        expect(button(false)).toContain('aria-keyshortcuts="Control+K"');
        expect(button(false)).toContain('<kbd>Ctrl K</kbd>');
    });

    test('on the first display the panes do not move (no motion until the person acts)', () => {
        expect(html).toContain('<div class="app motion-none">');
    });

    test('the activity bar keeps the tree and the changes', () => {
        const rail = html.slice(html.indexOf('class="activity-bar"'));
        expect([...rail.slice(0, rail.indexOf('</div>')).matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1])).toEqual(['サイドバーの一覧', '木', '差分']);
    });
});

/** The page with the left column on `leftView`, the tree folded or not. */
const shellWith = (over: Partial<Panes>, screen?: ReactNode): string =>
    renderToStaticMarkup(
        <I18nProvider lang="ja">
            <AppShell
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the shell reads of the panes
                panes={{ ...panes, ...over } as Panes}
                workspaceName="shop"
                world={null}
                sessionSlot={() => {}}
                lists={{
                    tree: { count: 0, content: <div className="tree-slot" /> },
                    problems: { count: 0, content: null },
                    changes: { count: 0, content: null },
                }}
                health={null}
                settings={null}
                banners={null}
                workspace={null}
                inspector={<div className="inspector-slot" />}
                screen={screen}
                overlays={null}
            />
        </I18nProvider>,
    );
const leftOf = (page: string): string => page.slice(page.indexOf('<div class="left open"'), page.indexOf('<div class="main">'));

test('a separate screen keeps the canvas mounted but makes its controls inert and hidden from assistive technology', () => {
    const page = shellWith({ leftView: 'tree' }, <div className="screen-slot" />);
    expect(page).toMatch(/<header class="app-bar" inert="" aria-hidden="true">/);
    expect(page).toMatch(/<div class="app-body" inert="" aria-hidden="true">/);
    expect(page).toContain('class="screen-slot"');
    expect(page).toContain('class="canvas-pane"');
});

describe('the left column', () => {
    const left = leftOf(shellWith({ leftView: 'tree' }));

    // not laid out here: the column is not measured, so the tree has no height yet (the first frame takes the measured one)
    test('the tree on top, then the splitter, then the detail (the inspector), its height left to the measure', () => {
        const order = [
            '<div class="navigator with-detail">',
            'tree-slot',
            'class="resizer resizer-y resizer-grip"',
            '<div class="detail">',
            'inspector-slot',
        ].map((c) => left.indexOf(c));
        expect(order.every((at) => at >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        // the canvas column holds no inspector
        expect(shellWith({ leftView: 'tree' }).slice(shellWith({ leftView: 'tree' }).indexOf('<div class="main">'))).not.toContain('inspector-slot');
    });

    test('the splitter is a focusable horizontal separator with the tree’s height as its value', () => {
        const splitter = /<div class="resizer resizer-y resizer-grip"[^>]*>/.exec(left)?.[0] ?? '';
        expect(splitter).toContain('role="separator"');
        expect(splitter).toContain('tabindex="0"');
        expect(splitter).toContain('aria-orientation="horizontal"');
        expect(splitter).toContain('aria-valuenow="96"');
        expect(splitter).toContain('aria-valuemin="96"');
        expect(splitter).toContain('aria-label="ツリーと詳細の仕切り');
    });

    test('folded, the tree is its head line (no height of its own) and the separator says it is at none', () => {
        const folded = leftOf(shellWith({ leftView: 'tree', treeFolded: true }));
        expect(folded).toContain('<div class="navigator with-detail folded">');
        expect(/<div class="resizer resizer-y resizer-grip"[^>]*>/.exec(folded)?.[0]).toContain('aria-valuenow="0"');
    });

    test('the other lists take the whole column: no splitter, the detail kept mounted but hidden', () => {
        const problems = leftOf(html);
        expect(problems).toContain('<div class="navigator">');
        expect(problems).not.toContain('resizer-y');
        expect(problems).toContain('<div class="detail" hidden=""><div class="inspector-slot">');
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

/** The rules of styles.css in the block that opens with `opening` (up to its closing brace at the line's start). */
function cssBlock(opening: string): string {
    const styles = readFileSync(join(import.meta.dir, '..', 'styles.css'), 'utf8');
    const start = styles.indexOf(opening);
    if (start < 0) throw new Error(`no block ${opening}`);
    return styles.slice(start, styles.indexOf('\n}', start));
}

describe('the app bar on a narrow window', () => {
    test('at 40rem 探す is its magnifier alone (and the workspace’s name goes)', () => {
        const narrow = cssBlock('@container app-bar (max-width: 40rem) {');
        expect(narrow).toMatch(/\.workspace-name \{\s+display: none;/);
        expect(narrow).toMatch(/\.app-bar-find-label,\s+\.app-bar-find kbd \{\s+display: none;/);
        expect(narrow).toMatch(/\.app-bar-find \{\s+width: 36px;/);
    });

    test('at 30rem the brand’s name, the extraction switch and the AI state’s words go (its mark stays), the gaps narrow', () => {
        const phone = cssBlock('@container app-bar (max-width: 30rem) {');
        expect(phone).toMatch(/\.app-bar-brand \.brand,\s+\.app-bar \.knowledge-extraction \{\s+display: none;/);
        expect(phone).toMatch(/\.app-bar \.chat-status-text \{\s+display: none;/);
        expect(phone).not.toContain('chat-status-mark');
        expect(cssBlock('@media (max-width: 30rem) {\n    .app-bar {')).toContain('gap: var(--space-1);');
    });

    test('a device without a keyboard shows no key', () => {
        expect(cssBlock('@media (hover: none) and (pointer: coarse) {')).toMatch(/\.app-bar-find kbd \{\s+display: none;/);
    });
});
