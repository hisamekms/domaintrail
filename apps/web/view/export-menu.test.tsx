// The view toolbar's 書き出し and 印刷 (view/export-menu.tsx), and the canvas's controls without them (view/canvas-controls.tsx).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { CanvasControls } from './canvas-controls';
import type { DiagramCanvas } from './diagram';
import { ExportButton, ExportMenu, PrintButton, toolbarOutput, type ExportControl } from './export-menu';
import { FilterPopover } from './toolbar';

const render = (node: ReactNode): string => renderToStaticMarkup(<I18nProvider lang="ja">{node}</I18nProvider>);
const control = (print?: ExportControl['print']): ExportControl => ({
    target: () => null,
    options: { heading: false, legend: false },
    setOptions: () => {},
    ...(print && { print }),
});
/** The texts of the menu's items, in order. */
const items = (html: string): string[] => [...html.matchAll(/role="menuitem"[^>]*>([^<]*)</g)].map((m) => m[1] ?? '');

describe("the view toolbar's right end", () => {
    test('a canvas view has 書き出し; the catalog, 印刷 alone; an empty view, nothing', () => {
        expect(toolbarOutput('contextMap')).toBe('export');
        expect(toolbarOutput('structure')).toBe('export');
        expect(toolbarOutput('storming')).toBe('export');
        expect(toolbarOutput('catalog')).toBe('print');
        expect(toolbarOutput(undefined)).toBeNull();
    });

    test('書き出し is a menu button, opening below; while printing is prepared it says so', () => {
        const html = render(<ExportButton control={control({ preparing: false, onPrint: () => {} })} />);
        expect(html).toContain('aria-haspopup="menu"');
        expect(html).toContain('aria-label="書き出し"');
        expect(render(<ExportButton control={control({ preparing: true, onPrint: () => {} })} />)).toContain('aria-label="印刷の準備中…"');
        expect(render(<PrintButton onPrint={() => {}} />)).toContain('印刷');
    });

    test('on a narrow toolbar its buttons are icons: their labels hidden by a container query, their names kept', () => {
        const styles = readFileSync(join(import.meta.dir, '..', 'styles.css'), 'utf8');
        expect(styles).toMatch(/\.view-toolbar \{\n\s+container: view-toolbar \/ inline-size;/);
        expect(styles).toMatch(/@container view-toolbar \(max-width: 40rem\) \{\s+\.toolbar-end-label \{\s+display: none;/);
        const buttons = [
            render(<ExportButton control={control()} />),
            render(<PrintButton onPrint={() => {}} />),
            render(
                <FilterPopover count={1} onClear={() => {}}>
                    {null}
                </FilterPopover>,
            ),
        ];
        for (const html of buttons) {
            expect(html).toContain('toolbar-end-label');
            expect(html).toMatch(/<button[^>]* aria-label="[^"]+"/);
        }
        expect(buttons[2]).toContain('<span class="filter-count">1</span>');
    });

    test('its menu: 印刷, PDF, PNG, SVG, then what they include; the inspector’s (no printing), PNG and SVG opening upward', () => {
        const main = render(<ExportMenu control={control({ preparing: false, onPrint: () => {} })} onDone={() => {}} />);
        expect(items(main)).toEqual(['印刷', 'PDF（印刷画面から保存）', 'PNG', 'SVG']);
        expect(main).toContain('見出しを含める');
        expect(main).toContain('凡例を含める');
        expect(main).not.toContain('motion-pop-up');
        const inspector = render(<ExportMenu control={control()} onDone={() => {}} up />);
        expect(items(inspector)).toEqual(['PNG', 'SVG']);
        expect(inspector).toContain('motion-pop-up');
    });
});

describe("the canvas's controls", () => {
    const canvas = { getZoom: () => 1, selectedIds: () => [] } as unknown as DiagramCanvas;

    test('the main canvas: the camera, 詰めて表示, the legend and «, without 印刷 or 書き出し', () => {
        const html = render(<CanvasControls canvas={canvas} fitAll={() => {}} legend={null} compact={{ on: false, onToggle: () => {} }} keys />);
        for (const label of ['縮小', '拡大', '全体を表示（Shift+1）', '詰めて表示', 'キャンバスの操作を畳む（U）'])
            expect(html).toContain(`aria-label="${label}"`);
        expect(html).not.toContain('印刷');
        expect(html).not.toContain('書き出し');
    });

    test('the inspector’s state diagram keeps its 書き出し there', () => {
        const html = render(<CanvasControls canvas={canvas} fitAll={() => {}} legend={null} exporting={control()} />);
        expect(html).toContain('aria-label="書き出し"');
    });
});
