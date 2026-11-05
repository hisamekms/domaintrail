// The session's extraction in the app bar (panel.tsx, ExtractionSwitch): the facilitator's switch, pressed while on;
// the others' mark while on and nothing while off; nothing without a store.
import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { ConflictBox, ExtractionSwitch } from './panel';
import { pairKey, type KnowledgeItem } from './model';
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

const render = (extraction: boolean | undefined, node: ReactNode, making: ReadonlySet<string> = new Set()): string =>
    renderToStaticMarkup(
        <I18nProvider lang="ja">
            <KnowledgeContext.Provider value={{ ...view(extraction), makingHotspots: making }}>{node}</KnowledgeContext.Provider>
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

describe('a conflict made a hotspot (ADR 0031, section 4)', () => {
    const item = (id: string, other: string): KnowledgeItem =>
        ({
            state: 'Live',
            id,
            content: { text: `the finding of ${id}`, labels: { when: 'as_is', kind: 'rule', origin: 'said' }, about: ['Ordering.Placed'] },
            sources: [],
            version: 1,
            conflictsWith: [other],
            createdAt: new Date('2026-11-05T09:00:00Z'),
            updatedAt: new Date('2026-11-05T09:00:00Z'),
        }) as unknown as KnowledgeItem;
    const pair = { a: item('kn_00000002', 'kn_00000001'), b: item('kn_00000001', 'kn_00000002') };
    const box = <ConflictBox pair={pair} from="Ordering.Placed" isOpen={() => false} onToggle={() => undefined} />;

    test('its two buttons, until ホットスポットにする is pressed', () => {
        const html = render(true, box);
        expect(html).toContain('ホットスポットにする');
        expect(html).toContain('食い違いではない');
        expect(html).not.toContain('ホットスポットを作っています');
    });

    test('pressed (on any page): the box shows that the hotspot is being made, without its buttons', () => {
        const html = render(true, box, new Set([pairKey('kn_00000001', 'kn_00000002')]));
        expect(html).toMatch(/role="status"[^>]*>.*<button[^>]*disabled[^>]*>.*ホットスポットを作っています/s);
        expect(html).not.toContain('食い違いではない');
        expect(html).not.toContain('>ホットスポットにする<');
    });
});
