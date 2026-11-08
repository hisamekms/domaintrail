// 探す (search/find.ts): what a query finds, in what order, and how the list is made of the two worlds.
import { describe, expect, test } from 'bun:test';
import { paletteRows, type PaletteItem } from '../shared/palette';
import { findIn, markRanges, matchActions, matchFindable, PER_SECTION, queryWords, searchSections, shownText, type Findable } from './find';

const sticky = (name: string, label: string | undefined, place: string, extra: Partial<Findable> = {}): Findable => ({
    key: `es/${place}/${name}`,
    world: 'storming',
    kind: 'event',
    name,
    label,
    kindName: 'イベント',
    place,
    run: () => {},
    ...extra,
});
const element = (name: string, label: string | undefined, place: string, extra: Partial<Findable> = {}): Findable => ({
    key: name,
    world: 'model',
    kind: 'aggregate',
    name,
    label,
    kindName: '集約',
    place,
    run: () => {},
    ...extra,
});
const keys = (items: readonly Findable[], query: string, mode: 'label' | 'name' | 'both' = 'label'): string[] =>
    findIn(items, queryWords(query), mode).map((h) => h.item.key);

describe('what a query finds', () => {
    const items = [
        sticky('OrderPlaced', '注文を受け付けた', '注文から入金まで'),
        sticky('InvoicePaid', '請求書が支払われた', '注文から入金まで'),
        sticky('ReturnRequested', '返品が依頼された', '返品'),
        sticky('RefundPaid', '返金した', '返品'),
    ];

    test('the label and the name (an ID) find it', () => {
        expect(keys(items, '注文')).toEqual(['es/注文から入金まで/OrderPlaced']);
        expect(keys(items, 'invoicepaid')).toEqual(['es/注文から入金まで/InvoicePaid']);
    });

    test('the place alone finds nothing; with another word it narrows', () => {
        // 「注文から入金まで」 holds 注文 and 入金, but only one sticky's label holds 注文
        expect(keys(items, '入金')).toEqual([]);
        expect(keys(items, '返品')).toEqual(['es/返品/ReturnRequested']);
        expect(keys(items, '返品 依頼')).toEqual(['es/返品/ReturnRequested']);
        expect(keys(items, '返品 paid')).toEqual(['es/返品/RefundPaid']);
        expect(keys(items, '注文から入金まで paid')).toEqual(['es/注文から入金まで/InvoicePaid']);
    });

    test('the kind never finds it', () => {
        expect(keys(items, 'イベント')).toEqual([]);
        expect(keys([element('Sales.Order', '注文', '販売')], '集約')).toEqual([]);
    });

    test('case and the width of the letters are ignored (NFKC)', () => {
        expect(keys(items, 'ＯＲＤＥＲ')).toEqual(['es/注文から入金まで/OrderPlaced']);
        expect(keys([sticky('Cart', 'ｶｰﾄ', 'S')], 'カート')).toEqual(['es/S/Cart']);
    });

    test('in 名前 the name is what is shown and the label what is found besides (nameIn)', () => {
        const order = sticky('OrderPlaced', '注文を受け付けた', 'S');
        expect(shownText(order, 'label')).toEqual({ text: '注文を受け付けた', name: 'OrderPlaced' });
        expect(shownText(order, 'both')).toEqual({ text: '注文を受け付けた', name: 'OrderPlaced' });
        expect(shownText(order, 'name')).toEqual({ text: 'OrderPlaced', name: '注文を受け付けた' });
        expect(matchFindable(order, ['order'], 'label')).toMatchObject({ rank: 3, onText: [], onName: ['order'] });
        expect(matchFindable(order, ['order'], 'name')).toMatchObject({ rank: 1, onText: ['order'], onName: [] });
        expect(matchFindable(order, ['注文'], 'name')).toMatchObject({ rank: 3, onText: [], onName: ['注文'] });
        // without a label, the name is both
        expect(shownText(sticky('X', undefined, 'S'), 'label')).toEqual({ text: 'X', name: 'X' });
    });
});

describe('the order of the results', () => {
    test('the label equal, then starting with, then holding the query, then the name only; else as written', () => {
        const items = [
            element('Sales.OrderItem', '注文明細', '販売'),
            element('Sales.Customer', '顧客の注文', '販売'),
            element('Sales.Order', '注文', '販売'),
            element('Sales.Notice', 'お知らせ', '販売', { name: 'Sales.注文Notice' }),
            element('Sales.OrderId', '注文ID', '販売'),
        ];
        expect(keys(items, '注文')).toEqual(['Sales.Order', 'Sales.OrderItem', 'Sales.OrderId', 'Sales.Customer', 'Sales.Notice']);
    });
});

describe('the parts to mark', () => {
    test('each word where it is, in order, never overlapping; nothing when NFKC changes the length', () => {
        expect(markRanges('注文を確定する', ['確定', '注文'])).toEqual([
            { start: 0, end: 2 },
            { start: 3, end: 5 },
        ]);
        expect(markRanges('Sales.Order.confirm', ['order.c', 'order'])).toEqual([{ start: 6, end: 13 }]);
        expect(markRanges('ｶｰﾄ', ['カート'])).toEqual([{ start: 0, end: 3 }]);
        expect(markRanges('ｶﾞｰﾄﾞ', ['ガード'])).toEqual([]);
    });
});

describe('the actions on the selection', () => {
    test('found by their name only, all of them when nothing is typed', () => {
        const actions = [
            { id: 'chat', label: 'チャットに追加' },
            { id: 'copy', label: 'リンクをコピー' },
        ];
        expect(matchActions(actions, []).map((a) => a.id)).toEqual(['chat', 'copy']);
        expect(matchActions(actions, queryWords('リンク')).map((a) => a.id)).toEqual(['copy']);
        expect(matchActions(actions, queryWords('選んだ')).map((a) => a.id)).toEqual([]);
    });
});

describe('the list: both worlds, the one shown first', () => {
    const confirm = element('Sales.Order.confirm', '注文を確定する', '販売 › 注文', { key: 'Sales.Order:confirm', kind: 'command' });
    const order = element('Sales.Order', '注文', '販売');
    const findables = [
        sticky('PlaceOrder', '注文する', 'OtC', { kind: 'command' }),
        sticky('ConfirmOrder', '注文を確定する', 'OtC', { kind: 'command', ref: 'Sales.Order:confirm' }),
        sticky('Bill', '確定した注文に請求する', 'OtC', { kind: 'policy' }),
        order,
        confirm,
        element('Billing.Bill', '確定した注文に請求する', '請求', { kind: 'policy' }),
    ];
    const list = (query: string, world: 'storming' | 'model', expanded: ReadonlySet<string> = new Set(), more: Findable[] = []) =>
        searchSections({ query, findables: [...findables, ...more], actions: [], world, mode: 'label', history: [], expanded });

    test('the world shown is listed first, each with how many it found', () => {
        expect(list('請求', 'storming').map((s) => (s.kind === 'world' ? [s.world, s.count] : s.kind))).toEqual([
            ['storming', 1],
            ['model', 1],
        ]);
        expect(list('請求', 'model').map((s) => (s.kind === 'world' ? s.world : s.kind))).toEqual(['model', 'storming']);
    });

    test('a sticky hangs the model element its ref names, which the model’s section leaves out; one without a ref is not joined', () => {
        const [es, dt] = list('確定', 'storming');
        expect(es?.kind === 'world' && es.rows.map((r) => [r.item.key, r.mates.map((m) => m.item.key)])).toEqual([
            ['es/OtC/Bill', []],
            ['es/OtC/ConfirmOrder', ['Sales.Order:confirm']],
        ]);
        // the policy of the same label but no ref stays in the model's section; the joined command is not counted
        expect(dt?.kind === 'world' && [dt.count, dt.rows.map((r) => r.item.key)]).toEqual([1, ['Billing.Bill']]);
    });

    test('with the model first, an element hangs the stickies whose ref names it', () => {
        const [dt, es] = list('確定', 'model');
        expect(dt?.kind === 'world' && dt.rows.map((r) => [r.item.key, r.mates.map((m) => m.item.key)])).toEqual([
            ['Billing.Bill', []],
            ['Sales.Order:confirm', ['es/OtC/ConfirmOrder']],
        ]);
        expect(es?.kind === 'world' && es.rows.map((r) => r.item.key)).toEqual(['es/OtC/Bill']);
    });

    test('a hung item keeps what the query found of it, else it is plain', () => {
        const [es] = list('confirm', 'storming');
        const row = es?.kind === 'world' ? es.rows[0] : undefined;
        expect(row?.item.key).toBe('es/OtC/ConfirmOrder');
        expect(row?.nameMarks).toEqual(['confirm']);
        expect(row?.mates[0]?.nameMarks).toEqual(['confirm']);
        const [, , plain] = [...list('注文を確定する', 'storming')].flatMap((s) => (s.kind === 'world' ? s.rows : []));
        expect(plain).toBeUndefined();
    });

    test('each world lists eight, the rest on ほか n 件 until it is expanded', () => {
        const many = Array.from({ length: 11 }, (_, i) => sticky(`E${i}`, `支払${i}`, 'OtC'));
        const [es] = list('支払', 'storming', new Set(), many);
        expect(es?.kind === 'world' && [es.count, es.rows.length, es.more]).toEqual([11, PER_SECTION, 3]);
        const [all] = list('支払', 'storming', new Set(['storming']), many);
        expect(all?.kind === 'world' && [all.rows.length, all.more]).toEqual([11, 0]);
    });

    test('nothing found: no section', () => {
        expect(list('出荷', 'storming')).toEqual([]);
    });
});

describe('nothing typed: the actions on the selection and 最近', () => {
    const findables = [
        sticky('A', 'あ', 'S'),
        sticky('B', 'い', 'S'),
        element('M', 'う', 'C'),
        element('N', 'え', 'C'),
        element('O', 'お', 'C'),
        element('P', 'か', 'C'),
    ];
    test('最近 is the selections of both worlds, newest first, once each, five at most, of what can be found', () => {
        const sections = searchSections({
            query: ' ',
            findables,
            actions: [{ id: 'chat', label: 'チャットに追加' }],
            world: 'storming',
            mode: 'label',
            history: ['es/S/A', 'M', 'file:a.dt', 'es/S/B', 'N', 'O', 'M', 'P'],
            expanded: new Set(),
        });
        expect(sections.map((s) => s.kind)).toEqual(['actions', 'recent']);
        const recent = sections[1];
        expect(recent?.kind === 'recent' && recent.rows.map((r) => r.item.key)).toEqual(['P', 'M', 'O', 'N', 'es/S/B']);
    });

    test('no selection, no history: nothing', () => {
        expect(searchSections({ query: '', findables, actions: [], world: 'model', mode: 'label', history: [], expanded: new Set() })).toEqual([]);
    });
});

describe('the palette’s rows', () => {
    test('each item, the items hung under it, then its section’s ほか n 件, in the order they are drawn', () => {
        const item = (id: string, mates?: PaletteItem[]): PaletteItem => ({ id, label: id, run: () => {}, ...(mates && { mates }) });
        const rows = paletteRows([
            { id: 'storming', title: 'ES', items: [item('a', [item('a1')]), item('b')], more: 2 },
            { id: 'model', title: 'DM', items: [item('c')] },
        ]);
        expect(rows.map((r) => (r.kind === 'item' ? r.item.id : `more:${r.section}`))).toEqual(['a', 'a1', 'b', 'more:storming', 'c']);
    });
});
