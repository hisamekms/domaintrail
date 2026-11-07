// The Worker's read-only page (page.tsx): the detail at the right shows only for a selected sticky; nothing while no
// sticky is selected, with no line saying what selecting does.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, MESSAGES } from '../i18n';
import { NO_FILTERS } from '../knowledge/model';
import { KnowledgeContext, type KnowledgeView } from '../knowledge/useKnowledge';
import { StickyDetail } from './page';

const view: KnowledgeView = {
    available: true,
    version: 0,
    marks: new Map(),
    lit: [],
    setLit: () => undefined,
    undoable: undefined,
    remove: async () => undefined,
    retire: async () => undefined,
    unretire: async () => undefined,
    undo: async () => undefined,
    proposals: [],
    approve: async () => undefined,
    dismiss: async () => undefined,
    changed: () => undefined,
    label: (s: string) => `label of ${s}`,
    select: () => undefined,
    extraction: undefined,
    setExtraction: async () => undefined,
    error: undefined,
    setError: () => undefined,
    filters: NO_FILTERS,
    setFilters: () => undefined,
    filterByLabel: () => undefined,
};

const render = (sticky: string | undefined): string =>
    renderToStaticMarkup(
        <I18nProvider lang="ja">
            <KnowledgeContext.Provider value={view}>
                <StickyDetail sticky={sticky} onClose={() => undefined} />
            </KnowledgeContext.Provider>
        </I18nProvider>,
    );

describe("the published page's detail", () => {
    test('nothing while no sticky is selected', () => {
        expect(render(undefined)).toBe('');
        expect(MESSAGES.ja.published).not.toHaveProperty('pick');
        expect(MESSAGES.en.published).not.toHaveProperty('pick');
    });

    test("a selected sticky's name, with ✕ to close it", () => {
        const html = render('Ordering.Placed');
        expect(html).toContain('<aside class="published-detail">');
        expect(html).toContain('<h2>label of Ordering.Placed</h2>');
        expect(html).toMatch(/<button[^>]*class="icon-button"[^>]*aria-label="閉じる"/);
    });
});
