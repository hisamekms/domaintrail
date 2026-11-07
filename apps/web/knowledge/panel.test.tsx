// The session's extraction in the app bar (panel.tsx, ExtractionSwitch): the facilitator's switch, pressed while on;
// the others' mark while on and nothing while off; nothing without a store. A conflict's box and the hotspot's box, their
// cards by their titles. An item: its title and labels' line while closed; opened, its text as Markdown (outside its
// head's button) and its labels as the list's chips, a press of one filtering the list by it.
import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { workerKnowledgeApi } from '../published/api';
import { KnowledgeApiContext, sessionKnowledgeApi } from './api';
import { ConflictBox, ExtractionSwitch, HotspotBox, ItemRow, KnowledgeList, KnowledgeNotice } from './panel';
import { NO_FILTERS, pairKey, type ClearedReason, type KnowledgeItem, type LabelChip } from './model';
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
        retire: async () => undefined,
        unretire: async () => undefined,
        undo: async () => undefined,
        proposals: [],
        approve: async () => undefined,
        dismiss: async () => undefined,
        changed: () => undefined,
        label: (s: string) => s,
        select: () => undefined,
        extraction,
        setExtraction: async () => undefined,
        error: undefined,
        setError: () => undefined,
        filters: NO_FILTERS,
        setFilters: () => undefined,
        filterByLabel: () => undefined,
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
            content: {
                title: `the title of ${id}`,
                text: `the finding of ${id}`,
                labels: { when: 'as_is', kind: 'rule', origin: 'said' },
                about: ['Ordering.Placed'],
            },
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
        // each card by its title, not its text
        expect(html).toMatch(/class="knowledge-side"[^>]*>.*<span class="knowledge-item-title">the title of kn_00000002<\/span>/s);
        expect(html).not.toContain('the finding of');
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
        content: {
            title: '受注は Order のこと',
            text: '受注と Order は同じ',
            labels: { when: 'none', kind: 'term', origin: 'investigated' },
            about: ['O.Placed', 'O.Order'],
        },
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

describe("an item: its title and labels' line while closed, its text as Markdown and its label chips once opened", () => {
    const text = '# 締め\n\n- **月末**は @{es:O/Placed} の翌日\n- 例外あり\n\n![伝票](image:img_0000abcd)\n\n![外](https://e.com/x.png)';
    const item = {
        state: 'Live',
        id: 'kn_00000003',
        content: { title: '締めは月末の翌日', text, labels: { when: 'as_is', kind: 'rule', origin: 'said', perspective: '営業' }, about: ['O.Placed'] },
        sources: [],
        version: 1,
        conflictsWith: [],
        createdAt: new Date('2026-11-05T09:10:00Z'),
        updatedAt: new Date('2026-11-05T09:10:00Z'),
    } as unknown as KnowledgeItem;
    const api = { ...sessionKnowledgeApi, imageUrl: (id: string) => `/images/${id}` };
    const row = (open: boolean, filterByLabel: (chip: LabelChip) => void = () => undefined): string =>
        renderToStaticMarkup(
            <I18nProvider lang="ja">
                <KnowledgeApiContext.Provider value={api}>
                    <KnowledgeContext.Provider value={{ ...view(true), label: (s: string) => (s === 'O.Placed' ? '受注した' : s), filterByLabel }}>
                        <ItemRow item={item} from="O.Placed" open={open} onToggle={() => undefined} />
                    </KnowledgeContext.Provider>
                </KnowledgeApiContext.Provider>
            </I18nProvider>,
        );

    /** The head: the row's button, whatever is in it. */
    const head = (h: string): string => /<button type="button" class="knowledge-item-head"[^>]*>(.*?)<\/button>/s.exec(h)?.[1] ?? '';

    test("closed: the head holds its kind and its title only; the labels' line under it; no text, no chip", () => {
        const h = row(false);
        expect(head(h)).toBe('<span class="knowledge-kind">ルール</span><span class="knowledge-item-title">締めは月末の翌日</span>');
        expect(h).toMatch(/<div class="knowledge-fold">.*<span class="knowledge-meta"><span>AS-IS<\/span>.*<span>発言<\/span>.*<span>営業<\/span>/s);
        expect(h).not.toContain('月末は');
        expect(h).not.toContain('<img');
        expect(h).not.toContain('knowledge-chip');
    });

    test('opened: the head unchanged, the text as Markdown outside it (its heading a paragraph, the sticky a link, the attached image drawn from the page)', () => {
        const h = row(true);
        expect(head(h)).toBe('<span class="knowledge-kind">ルール</span><span class="knowledge-item-title">締めは月末の翌日</span>');
        expect(h).toMatch(/<\/button>.*<div class="knowledge-body markdown"><p>締め<\/p>/s);
        expect(h).toContain('<ul><li><strong>月末</strong>は <a class="reply-element">受注した</a> の翌日</li><li>例外あり</li></ul>');
        expect(h).toContain('<img class="md-image" src="/images/img_0000abcd" alt="伝票" loading="lazy"/>');
        expect(h).toContain('外 (https://e.com/x.png)');
        // the labels' line folds away
        expect(h).toContain('<div class="knowledge-fold shut" aria-hidden="true">');
    });

    test("opened: its labels as the ナレッジ list's chips (when, kind, origin, perspective), each filtering by itself", () => {
        const h = row(true);
        const chips = [...h.matchAll(/<button type="button" class="knowledge-chip" data-tooltip="([^"]*)">([^<]*)<\/button>/g)].map((m) => [m[2], m[1]]);
        expect(chips).toEqual([
            ['AS-IS', 'このいつの話で絞り込む'],
            ['ルール', 'この種類で絞り込む'],
            ['発言', 'この出どころで絞り込む'],
            ['営業', 'この立場で絞り込む'],
        ]);
    });

    test("on the Worker's page, the image comes from the Worker", () => {
        const h = renderToStaticMarkup(
            <I18nProvider lang="ja">
                <KnowledgeApiContext.Provider value={workerKnowledgeApi('shop')}>
                    <KnowledgeContext.Provider value={view(true)}>
                        <ItemRow item={item} from={undefined} open onToggle={() => undefined} />
                    </KnowledgeContext.Provider>
                </KnowledgeApiContext.Provider>
            </I18nProvider>,
        );
        expect(h).toContain(`src="${workerKnowledgeApi('shop').imageUrl('img_0000abcd')}"`);
        expect(h).toContain('src="/v1/projects/shop/images/img_0000abcd"');
    });
});

describe('retiring (廃止, ADR 0031 section 12)', () => {
    const base = {
        state: 'Live',
        id: 'kn_00000001',
        content: { title: '締めは前日17時', text: '本文', labels: { when: 'as_is', kind: 'rule', origin: 'said' }, about: ['Ordering.Placed'] },
        sources: [],
        version: 1,
        conflictsWith: [],
        createdAt: new Date('2026-11-05T09:00:00Z'),
        updatedAt: new Date('2026-11-05T09:00:00Z'),
    };
    const retired = {
        ...base,
        retirement: { reason: 'replaced', replacedBy: 'kn_00000002', by: 'guest:Ada', at: new Date('2026-11-07T09:00:00Z') },
    } as unknown as KnowledgeItem;

    test('a retired item is faded, its reason first on its line; one not retired is neither', () => {
        const html = render(true, <ItemRow item={retired} from={undefined} open={false} onToggle={() => undefined} />);
        expect(html).toMatch(/<li class="knowledge-item retired">/);
        expect(html).toContain('<span class="knowledge-retired-label">廃止: 置き換わった</span>');
        const live = render(true, <ItemRow item={base as unknown as KnowledgeItem} from={undefined} open={false} onToggle={() => undefined} />);
        expect(live).not.toContain('retired');
    });

    test('the list: 廃止の候補 n at its head with 承認 and 却下 each, and the filter 廃止も表示', () => {
        const proposal = {
            state: 'Open',
            id: 'rp_00000001',
            item: 'kn_00000001',
            action: 'retire',
            reason: 'obsolete',
            explanation: 'もうやっていないと話に出た',
            evidence: [{ kind: 'Said', session: 's2', message: 'm1', quote: 'もうやっていない' }],
            proposedBy: { kind: 'Extraction', extraction: { session: 's2', number: 1 } },
            proposedAt: new Date('2026-11-07T09:00:00Z'),
        };
        const html = renderToStaticMarkup(
            <I18nProvider lang="ja">
                <KnowledgeContext.Provider value={{ ...view(true), proposals: [proposal] as unknown as KnowledgeView['proposals'] }}>
                    <KnowledgeList onClose={() => undefined} closeLabel="閉じる" />
                </KnowledgeContext.Provider>
            </I18nProvider>,
        );
        expect(html).toContain('<summary>廃止の候補 1</summary>');
        expect(html).toContain('もうやっていないと話に出た');
        expect(html).toContain('当てはまらなくなった');
        expect(html).toMatch(/class="act act-decide"[^>]*>承認</);
        expect(html).toMatch(/class="act act-danger"[^>]*>却下</);
        expect(html).toMatch(/<button[^>]*class="knowledge-chip"[^>]*aria-pressed="false"[^>]*>廃止も表示</);
        // no proposals, no section
        expect(render(true, <KnowledgeList onClose={() => undefined} closeLabel="閉じる" />)).not.toContain('廃止の候補');
    });

    test('元に戻す after 廃止する, said as such', () => {
        const html = renderToStaticMarkup(
            <I18nProvider lang="ja">
                <KnowledgeContext.Provider value={{ ...view(true), undoable: { id: 'kn_00000001', what: 'retired' } }}>
                    <KnowledgeNotice />
                </KnowledgeContext.Provider>
            </I18nProvider>,
        );
        expect(html).toContain('廃止しました');
        expect(html).toContain('元に戻す');
    });
});
