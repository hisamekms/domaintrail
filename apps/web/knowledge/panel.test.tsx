// The session's extraction in the app bar (panel.tsx, ExtractionSwitch): the facilitator's switch, pressed while on;
// the others' mark while on and nothing while off; nothing without a store. A conflict's box and the hotspot's box.
import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { ConflictBox, ExtractionSwitch, HotspotBox, ItemRow } from './panel';
import { pairKey, type ClearedReason, type KnowledgeItem } from './model';
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

const render = (
    extraction: boolean | undefined,
    node: ReactNode,
    making: ReadonlySet<string> = new Set(),
    cleared: ReadonlyMap<string, ClearedReason> = new Map(),
): string =>
    renderToStaticMarkup(
        <I18nProvider lang="ja">
            <KnowledgeContext.Provider value={{ ...view(extraction), makingHotspots: making, clearedHotspots: cleared }}>{node}</KnowledgeContext.Provider>
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

    test('its buttons back after a run without one hotspot: with why, until pressed again', () => {
        const key = pairKey('kn_00000001', 'kn_00000002');
        const none = render(true, box, new Set(), new Map([[key, 'none' as const]]));
        expect(none).toMatch(/class="knowledge-cleared" role="status">ホットスポットが見つかりませんでした</);
        expect(none).toContain('ホットスポットにする');
        expect(none).toContain('食い違いではない');
        expect(render(true, box, new Set(), new Map([[key, 'several' as const]]))).toContain('候補が複数ありました');
        // pressed again: only that it is being made
        expect(render(true, box, new Set([key]), new Map([[key, 'none' as const]]))).not.toContain('knowledge-cleared');
    });

    test('handed over: the items side by side in a calm box, the hotspot linked as a #chip instead of buttons', () => {
        const handed = (id: string): KnowledgeItem =>
            ({
                ...item(id, ''),
                conflictsWith: [],
                content: { ...item(id, '').content, about: ['Ordering.Placed', 'Ordering.CutOff'] },
            }) as unknown as KnowledgeItem;
        const html = renderToStaticMarkup(
            <I18nProvider lang="ja">
                <KnowledgeContext.Provider value={{ ...view(true), label: (s: string) => (s === 'Ordering.CutOff' ? '締めはいつ？' : s) }}>
                    <HotspotBox
                        group={{ hotspot: 'Ordering.CutOff', items: [handed('kn_00000002'), handed('kn_00000001')] }}
                        from="Ordering.Placed"
                        isOpen={() => false}
                        onToggle={() => undefined}
                    />
                </KnowledgeContext.Provider>
            </I18nProvider>,
        );
        expect(html).toMatch(/^<div class="knowledge-hotspot" role="group" aria-label="ホットスポット">/);
        expect(html.match(/class="knowledge-side"/g)).toHaveLength(2);
        expect(html).toMatch(/<a class="chat-chip chat-target kind-DtesElement"[^>]*><span class="chat-chip-name">#締めはいつ？<\/span><\/a>/);
        expect(html).not.toContain('knowledge-conflict');
        expect(html).not.toContain('class="act');
    });
});

describe('an item opened (the approved preview)', () => {
    const item = {
        state: 'Live',
        id: 'kn_00000001',
        content: { text: '受注と Order は同じ', labels: { when: 'none', kind: 'term', origin: 'investigated' }, about: ['O.Placed', 'O.Order'] },
        sources: [
            { session: 's_now', message: 'm1', at: new Date('2026-11-05T09:02:00Z'), quote: 'sales/order.dt を確認' },
            { session: 's_old', message: 'm9', at: new Date('2026-11-03T05:00:00Z'), quote: '画面では受注と呼ぶ' },
        ],
        version: 1,
        conflictsWith: [],
        createdAt: new Date('2026-11-05T09:10:00Z'),
        updatedAt: new Date('2026-11-05T09:10:00Z'),
    } as unknown as KnowledgeItem;
    const html = (from: string | undefined): string =>
        renderToStaticMarkup(
            <I18nProvider lang="ja">
                <KnowledgeContext.Provider
                    value={{
                        ...view(true),
                        label: (s: string) => (s === 'O.Order' ? '注文' : '注文を受け付けた'),
                        messageOf: (session: string) => (session === 's_now' ? { who: '佐藤', open: () => undefined } : undefined),
                    }}
                >
                    <ItemRow item={item} from={from} open onToggle={() => undefined} />
                </KnowledgeContext.Provider>
            </I18nProvider>,
        );

    test("its sources are the chat's reference lines: this session's by who said it (a link), another's by its date (text)", () => {
        const h = html('O.Placed');
        expect(h).toMatch(/<button class="chat-reply-ref"[^>]*>.*↩ 佐藤:.*sales\/order\.dt を確認/s);
        expect(h).toMatch(/<span class="chat-reply-ref"[^>]*>.*↩ 11\/3:.*画面では受注と呼ぶ/s);
    });

    test("the other stickies as the chat's #chips (not the sticky whose detail it is); every sticky in the list", () => {
        const inDetail = html('O.Placed');
        expect(inDetail).toContain('#注文<');
        expect(inDetail).not.toContain('#注文を受け付けた');
        expect(html(undefined)).toContain('#注文を受け付けた');
    });
});
