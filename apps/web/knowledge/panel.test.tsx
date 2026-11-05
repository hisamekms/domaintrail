// The session's extraction in the app bar (panel.tsx, ExtractionSwitch): the facilitator's switch, pressed while on;
// the others' mark while on and nothing while off; nothing without a store.
import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { ExtractionSwitch } from './panel';
import { KnowledgeContext, type KnowledgeView } from './useKnowledge';

const view = (extraction: boolean | undefined): KnowledgeView =>
    ({
        available: extraction !== undefined,
        version: 0,
        marks: new Map(),
        lit: [],
        setLit: () => undefined,
        undoable: undefined,
        remove: async () => undefined,
        undo: async () => undefined,
        changed: () => undefined,
        label: (s: string) => s,
        select: () => undefined,
        extraction,
        setExtraction: async () => undefined,
        error: undefined,
        setError: () => undefined,
    }) satisfies KnowledgeView;

const render = (extraction: boolean | undefined, node: ReactNode): string =>
    renderToStaticMarkup(
        <I18nProvider lang="ja">
            <KnowledgeContext.Provider value={view(extraction)}>{node}</KnowledgeContext.Provider>
        </I18nProvider>,
    );

describe("the session's extraction in the app bar", () => {
    test('the facilitator switches it: pressed while on, its tooltip says what a press does', () => {
        const on = render(true, <ExtractionSwitch facilitator live />);
        expect(on).toMatch(/<button[^>]*class="icon-button knowledge-extraction"[^>]*aria-pressed="true"[^>]*aria-label="会話からナレッジを抽出"/);
        expect(on).toContain('押すと止める');
        const off = render(false, <ExtractionSwitch facilitator live />);
        expect(off).toMatch(/aria-pressed="false"/);
        expect(off).toContain('押すと始める');
    });

    test('a participant sees a mark while it is on, nothing while it is off', () => {
        expect(render(true, <ExtractionSwitch facilitator={false} live />)).toMatch(/<span[^>]*role="img"[^>]*aria-label="会話からナレッジを抽出しています"/);
        expect(render(false, <ExtractionSwitch facilitator={false} live />)).toBe('');
    });

    test('nothing without a store, or once the page is out of the session', () => {
        expect(render(undefined, <ExtractionSwitch facilitator live />)).toBe('');
        expect(render(true, <ExtractionSwitch facilitator live={false} />)).toBe('');
    });
});
