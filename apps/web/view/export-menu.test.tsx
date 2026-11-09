// The canvas toolbars' 書き出し and the catalog view bar's 印刷.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { CanvasControls } from './canvas-controls';
import type { DiagramCanvas } from './diagram';
import { ExportMenu, PrintButton, type ExportControl } from './export-menu';
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
    test('the catalog keeps 印刷 in its view bar', () => {
        expect(render(<PrintButton onPrint={() => {}} />)).toContain('印刷');
    });

    test('on a narrow toolbar its remaining buttons are icons: their labels hidden by a container query, their names kept', () => {
        const styles = readFileSync(join(import.meta.dir, '..', 'styles.css'), 'utf8');
        expect(styles).toMatch(/\.view-toolbar \{\n\s+container: view-toolbar \/ inline-size;/);
        expect(styles).toMatch(/@container view-toolbar \(max-width: [\d.]+rem\) \{\s+\.toolbar-end-label \{\s+display: none;/);
        const buttons = [
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
        expect(buttons[1]).toContain('<span class="filter-count">1</span>');
    });

    test('both diagram menus open upward: the main offers print and formats, the inspector image formats', () => {
        const main = render(<ExportMenu control={control({ preparing: false, onPrint: () => {} })} onDone={() => {}} up />);
        expect(items(main)).toEqual(['印刷', 'PDF（印刷画面から保存）', 'PNG', 'SVG']);
        expect(main).toContain('見出しを含める');
        expect(main).toContain('凡例を含める');
        expect(main).toContain('motion-pop-up');
        const inspector = render(<ExportMenu control={control()} onDone={() => {}} up />);
        expect(items(inspector)).toEqual(['PNG', 'SVG']);
        expect(inspector).toContain('motion-pop-up');
    });
});

describe("the canvas's controls", () => {
    const canvas = { getZoom: () => 1, selectedIds: () => [] } as unknown as DiagramCanvas;

    test('the main canvas: zoom, fit, layout, fullscreen, then export', () => {
        const html = render(
            <CanvasControls
                canvas={canvas}
                fitAll={() => {}}
                legend={null}
                compact={{ on: false, onToggle: () => {} }}
                focus={{ active: false, onToggle: () => {} }}
                exporting={control({ preparing: false, onPrint: () => {} })}
                keys
            />,
        );
        for (const label of ['縮小', '拡大', '全体を表示（Shift+1）', '詰めて表示']) expect(html).toContain(`aria-label="${label}"`);
        expect(html).not.toContain('キャンバスの操作を畳む');
        expect(html).not.toContain('キャンバスの操作を表示');
        expect(html.indexOf('aria-label="画面いっぱいに表示"')).toBeLessThan(html.indexOf('aria-label="書き出し"'));
        expect(html).toContain('aria-haspopup="menu"');
        expect(
            render(<CanvasControls canvas={canvas} fitAll={() => {}} legend={null} exporting={control({ preparing: true, onPrint: () => {} })} />),
        ).toContain('aria-label="印刷の準備中…"');
    });

    test('the state diagram uses the same order', () => {
        const html = render(
            <CanvasControls canvas={canvas} fitAll={() => {}} legend={null} focus={{ active: false, onToggle: () => {} }} exporting={control()} />,
        );
        expect(html).toContain('aria-label="書き出し"');
        expect(html.indexOf('aria-label="画面いっぱいに表示"')).toBeLessThan(html.indexOf('aria-label="書き出し"'));
    });

    test('the diagram focus action lives in its canvas toolbar and changes to return when focused', () => {
        const props = { canvas, fitAll: () => {}, legend: null, focus: { active: false, onToggle: () => {} } };
        expect(render(<CanvasControls {...props} />)).toContain('aria-label="画面いっぱいに表示"');
        expect(render(<CanvasControls {...props} focus={{ ...props.focus, active: true }} />)).toContain('aria-label="元の表示に戻す"');
    });
});
