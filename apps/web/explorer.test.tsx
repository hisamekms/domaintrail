import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Explorer, groupCount } from './explorer';
import { I18nProvider } from './i18n';
import { check } from './test-helpers';

/** localStorage of a browser, in memory. */
function storage(saved: Record<string, string> = {}): void {
    const items = new Map(Object.entries(saved));
    Object.assign(globalThis, {
        localStorage: { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) },
    });
}

describe('the model tree’s group headings', () => {
    afterEach(() => {
        Reflect.deleteProperty(globalThis, 'localStorage');
    });

    test('count their rows only while collapsed, as a muted "(n)"', async () => {
        const { model } = await check({ 'a.dt': 'context A {\n  id OrderId: UUID\n  aggregate Order {\n    id: OrderId\n  }\n}\n' });
        const tree = (): string =>
            renderToStaticMarkup(
                <I18nProvider lang="ja">
                    <Explorer
                        model={model ?? null}
                        files={[]}
                        diagnostics={[]}
                        diff={{ added: [], changed: [], removed: [] }}
                        mode="name"
                        selected={undefined}
                        onSelect={() => {}}
                        onOpen={() => {}}
                        onClose={() => {}}
                    />
                </I18nProvider>,
            );
        expect(groupCount(1)).toBe('(1)');
        storage();
        expect(tree()).toContain('集約');
        expect(tree()).not.toContain('tree-count');
        storage({ 'domaintrail.explorer.collapsed': JSON.stringify(['grp:A:aggregate']) });
        expect(tree()).toContain('集約<span class="muted tree-count"> (1)</span>');
    });
});

describe('the tree’s head line folds the tree over the detail', () => {
    const head = (folded: boolean): string => {
        const html = renderToStaticMarkup(
            <I18nProvider lang="ja">
                <Explorer
                    model={null}
                    files={[]}
                    diagnostics={[]}
                    diff={{ added: [], changed: [], removed: [] }}
                    mode="name"
                    selected={undefined}
                    onSelect={() => {}}
                    onOpen={() => {}}
                    onClose={() => {}}
                    fold={{ folded, label: 'ドメインモデル › Order', onToggle: () => {} }}
                />
            </I18nProvider>,
        );
        // the head line, and the body's own tag
        const body = html.indexOf('<div class="explorer-body"');
        return html.slice(html.indexOf('<div class="explorer-head">'), html.indexOf('>', body) + 1);
    };

    test('open: the filter, then ▾ (an icon button with its name and tooltip), then the button closing the sidebar', () => {
        const open = head(false);
        expect(open).toContain('class="explorer-filter"');
        expect(open).not.toContain('tree-fold-label');
        expect(open).toMatch(/<button class="icon-button tree-fold" aria-expanded="true" data-tooltip="ツリーを畳む" aria-label="ツリーを畳む">/);
        expect(open.indexOf('tree-fold')).toBeLessThan(open.indexOf('サイドバーを閉じる'));
        expect(open).toContain('<div class="explorer-body">');
    });

    test('folded: the line names what is selected in place of the filter, ▾ opens the tree, and the rows are inert', () => {
        const folded = head(true);
        expect(folded).toContain('<span class="tree-fold-label" data-tooltip="ドメインモデル › Order">ドメインモデル › Order</span>');
        expect(folded).not.toContain('explorer-filter');
        expect(folded).toMatch(/<button class="icon-button tree-fold folded" aria-expanded="false" data-tooltip="ツリーを開く" aria-label="ツリーを開く">/);
        expect(folded).toContain('<div class="explorer-body" inert="">');
    });
});
