import { describe, expect, test } from 'bun:test';
import { healthOf, workspaceName } from './health';
import { COLLAPSE_LEFT_BELOW, effectiveLayout, keptOverrides, NO_OVERRIDES } from './responsive';

describe('the layout on a narrow window', () => {
    const saved = { left: true, overrides: NO_OVERRIDES };

    test("the reader's choice while the conversation is closed, whatever the width", () => {
        expect(effectiveLayout({ ...saved, width: 800, conversationOpen: false })).toMatchObject({ left: true });
    });

    test('the detail (in the left column) and the chat are seen together on the usual widths, down to 1024px', () => {
        for (const width of [1800, 1400, 1180, 1024]) expect(effectiveLayout({ ...saved, width, conversationOpen: true })).toMatchObject({ left: true });
    });

    test('with the conversation open: the left column collapsed below the threshold', () => {
        expect(effectiveLayout({ ...saved, width: COLLAPSE_LEFT_BELOW, conversationOpen: true })).toMatchObject({ left: true });
        expect(effectiveLayout({ ...saved, width: COLLAPSE_LEFT_BELOW - 1, conversationOpen: true })).toEqual({ left: false, forced: { left: true } });
    });

    test('what the reader chooses meanwhile is shown, and forgotten once the window is wide again; the saved choice is kept', () => {
        const overrides = { left: true };
        expect(effectiveLayout({ ...saved, overrides, width: 900, conversationOpen: true })).toMatchObject({ left: true });
        expect(keptOverrides(overrides, { left: true })).toBe(overrides);
        expect(keptOverrides(overrides, { left: false })).toEqual({});
        // a saved choice to keep the left column collapsed stays so when the window is wide
        expect(effectiveLayout({ ...saved, left: false, width: 1600, conversationOpen: true })).toMatchObject({ left: false });
    });
});

describe('the head and the foot of the left pane', () => {
    test("the workspace's name is the last folder of its root", () => {
        expect(workspaceName('/Users/me/shop')).toBe('shop');
        expect(workspaceName('/Users/me/shop/')).toBe('shop');
        expect(workspaceName('C:\\work\\billing')).toBe('billing');
    });

    test('the health: an error when the server is gone or the model does not validate, a warning while it is uncertain', () => {
        const ok = { status: 'ok' as const, connection: 'open' as const, stale: false, warnings: 0 };
        expect(healthOf(ok)).toBe('ok');
        expect(healthOf({ ...ok, connection: 'closed' })).toBe('error');
        expect(healthOf({ ...ok, status: 'invalid' })).toBe('error');
        expect(healthOf({ ...ok, status: 'syntax-error', stale: true })).toBe('error');
        expect(healthOf({ ...ok, connection: 'connecting' })).toBe('warning');
        expect(healthOf({ ...ok, status: undefined })).toBe('warning');
        expect(healthOf({ ...ok, status: 'empty' })).toBe('warning');
        expect(healthOf({ ...ok, warnings: 2 })).toBe('warning');
    });
});

describe('the text size (文字の大きさ)', () => {
    test('標準 leaves the root at the browser default; the others scale it', async () => {
        const { rootFontSize, TEXT_SCALES, TEXT_SIZES, isTextSize } = await import('./text-size');
        expect(TEXT_SIZES).toEqual(['small', 'standard', 'large', 'xlarge']);
        expect(TEXT_SCALES).toEqual({ small: 0.9, standard: 1, large: 1.15, xlarge: 1.3 });
        expect(rootFontSize('standard')).toBe('');
        expect(rootFontSize('small')).toBe('90%');
        expect(rootFontSize('large')).toBe('115%');
        expect(rootFontSize('xlarge')).toBe('130%');
        expect(isTextSize('large')).toBe(true);
        expect(isTextSize('huge')).toBe(false);
        expect(isTextSize(null)).toBe(false);
    });

    test("the UI scale is the root font size against 16px (the browser's default and the chosen size together)", async () => {
        const { uiScale } = await import('./text-size');
        expect(uiScale(16)).toBe(1);
        expect(uiScale(20.8)).toBeCloseTo(1.3);
        // a browser set to 20px with 標準
        expect(uiScale(20)).toBe(1.25);
        expect(uiScale(Number.NaN)).toBe(1);
        expect(uiScale(0)).toBe(1);
    });

    test("the panes' default sizes follow the UI scale; a dragged size is kept", async () => {
        const { DEFAULT_PANE_SIZES, paneSize } = await import('./panes');
        expect(paneSize(null, DEFAULT_PANE_SIZES.explorerWidth, 1)).toBe(280);
        expect(paneSize(null, DEFAULT_PANE_SIZES.conversationWidth, 1)).toBe(380);
        expect(paneSize(null, DEFAULT_PANE_SIZES.explorerWidth, 1.3)).toBe(364);
        expect(paneSize(null, DEFAULT_PANE_SIZES.conversationWidth, 0.9)).toBe(342);
        expect(paneSize(300, DEFAULT_PANE_SIZES.explorerWidth, 1.3)).toBe(300);
    });

    test('the narrow-window threshold grows with the UI scale', () => {
        const saved = { left: true, overrides: NO_OVERRIDES, conversationOpen: true };
        // 1300px fits the left column beside the conversation at 標準, not at 特大
        expect(effectiveLayout({ ...saved, width: 1300 })).toMatchObject({ left: true });
        expect(effectiveLayout({ ...saved, width: 1300, scale: 1.3 })).toMatchObject({ left: false });
    });

    test("the UI's font sizes in styles.css are in rem (the canvas's shapes keep px: the zoom scales them)", async () => {
        const css = await Bun.file(new URL('../styles.css', import.meta.url)).text();
        const sections = css.split(/(?=\/\* -{10} )/);
        const pxFonts = (s: string): string[] => s.match(/(?:font-size|font|line-height):\s*[\d.]+px[^;]*/g) ?? [];
        const ui = sections.filter((s) => !s.startsWith('/* ---------- canvas shapes'));
        expect(ui.flatMap(pxFonts)).toEqual([]);
        expect(pxFonts(sections.find((s) => s.startsWith('/* ---------- canvas shapes')) ?? '').length).toBeGreaterThan(0);
    });

    test("the explorer's rows: the first level one step inside the section titles, in rem so that it grows with the text size", async () => {
        const { indent } = await import('../explorer');
        expect(indent(0)).toEqual({ '--depth': 0 });
        expect(indent(3)).toEqual({ '--depth': 3 });
        const css = await Bun.file(new URL('../styles.css', import.meta.url)).text();
        const rule = (selector: string): string => css.slice(css.indexOf(`${selector} {`)).split('}')[0] ?? '';
        expect(rule('.explorer-section-title')).toContain('padding: 4px 12px 4px 8px;');
        const padding = /padding-left: calc\(([\d.]+)rem \+ \(var\(--depth, 0\) \+ 1\) \* ([\d.]+)rem\);/.exec(rule('.tree-group'));
        if (!padding) throw new Error('no rem padding-left with --depth on .tree-item, .tree-group');
        // at 標準 (16px): the section titles' 8px, then 14px a level, starting one level in
        const px = (depth: number): number => (Number(padding[1]) + (depth + 1) * Number(padding[2])) * 16;
        expect([0, 1, 2, 3].map(px)).toEqual([22, 36, 50, 64]);
    });
});
