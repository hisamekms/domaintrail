import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { analyzeStormings } from '@domaintrail/storming';
import { focusBack, matchItems, type PaletteItem } from '../shared/palette';
import { outsidePressCancels } from './forms';
import { elementLink, linkedElement } from './link';
import {
    actionOfKey,
    actionsFor,
    escapeClearsSelection,
    HOTSPOT_TARGETS,
    toolbarActions,
    shortcutText,
    STICKY_ACTIONS,
    stickyOf,
    type ActionContext,
} from './registry';

const SHOP = path.join(import.meta.dir, '..', '..', '..', 'examples', 'shop', 'stormings', 'order-to-cash.dtes');
const parsed = await analyzeStormings([{ path: 'order-to-cash.dtes', text: await readFile(SHOP, 'utf8') }], undefined);
const stormings = parsed.stormings.map((s) => ({ id: s.id, storming: s }));
const sticky = (local: string) => {
    const s = stickyOf(stormings, `es/OrderToCash/${local}`);
    if (!s) throw new Error(`no sticky ${local}`);
    return s;
};
const live: ActionContext = { live: true, hasModelElement: (s) => s.ref !== undefined };
const ids = (local: string | string[], context = live): string[] => actionsFor((Array.isArray(local) ? local : [local]).map(sticky), context).map((a) => a.id);

describe("the stickies' actions (ADR 0033): one list, by kind", () => {
    test('what each kind of sticky offers in a live session', () => {
        // an event with a ref, in timelines
        expect(ids('OrderPlaced')).toEqual(['chat', 'edit', 'seeModel', 'seeTimeline', 'addHotspot', 'copyLink']);
        // an event without a ref
        expect(ids('ItemAdded')).toEqual(['chat', 'edit', 'seeTimeline', 'addHotspot', 'copyLink']);
        // a command with a ref; an actor; a policy
        expect(ids('PlaceOrder')).toEqual(['chat', 'edit', 'seeModel', 'addHotspot', 'copyLink']);
        expect(ids('Customer')).toEqual(['chat', 'edit', 'addHotspot', 'copyLink']);
        expect(ids('BillConfirmedOrder')).toEqual(['chat', 'edit', 'addHotspot', 'copyLink']);
        // a hotspot: its resolution
        expect(ids('IssuedEvent')).toEqual(['chat', 'edit', 'resolve', 'copyLink']);
    });

    test('several selected: the actions for several only; outside a session: seeing and copying only', () => {
        expect(ids(['OrderPlaced', 'PlaceOrder'])).toEqual(['chat']);
        expect(ids('OrderPlaced', { live: false, hasModelElement: () => true })).toEqual(['seeModel', 'seeTimeline', 'copyLink']);
        // the timeline shown already holds it: no way to it
        expect(ids('OrderPlaced', { ...live, timelineShown: 'Normal' })).not.toContain('seeTimeline');
        // a ref the model does not have
        expect(ids('OrderPlaced', { live: true, hasModelElement: () => false })).not.toContain('seeModel');
    });

    test('ナレッジを見る: only for a sticky with knowledge, and never without a store', () => {
        const withStore: ActionContext = { ...live, hasKnowledge: (s) => s.local === 'OrderPlaced' };
        expect(ids('OrderPlaced', withStore)).toEqual(['chat', 'edit', 'knowledge', 'seeModel', 'seeTimeline', 'addHotspot', 'copyLink']);
        expect(ids('PlaceOrder', withStore)).not.toContain('knowledge');
        expect(ids('OrderPlaced')).not.toContain('knowledge');
    });

    test("a hotspot goes on any sticky but a hotspot: the grammar's rule, kept in one place", () => {
        expect(HOTSPOT_TARGETS).not.toContain('hotspot');
        expect(HOTSPOT_TARGETS).toContain('command');
        expect(STICKY_ACTIONS.map((a) => a.id)).toEqual(['chat', 'edit', 'knowledge', 'seeModel', 'seeTimeline', 'addHotspot', 'resolve', 'copyLink']);
        // the toolbar: チャットに追加 · 編集, and for a hotspot 解決を書く too
        const bar = (local: string): string[] => toolbarActions(actionsFor([sticky(local)], live), [sticky(local)]).map((x) => x.id);
        expect(bar('OrderPlaced')).toEqual(['chat', 'edit']);
        expect(bar('IssuedEvent')).toEqual(['chat', 'edit', 'resolve']);
        expect(
            toolbarActions(actionsFor([sticky('OrderPlaced'), sticky('IssuedEvent')], live), [sticky('OrderPlaced'), sticky('IssuedEvent')]).map((x) => x.id),
        ).toEqual(['chat']);
    });

    test('a sticky is what a selection ID names: its kind, its ref, its timelines; a timeline is none', () => {
        expect(sticky('OrderConfirmed')).toEqual({
            id: 'es/OrderToCash/OrderConfirmed',
            storming: 'OrderToCash',
            local: 'OrderConfirmed',
            kind: 'event',
            label: '注文が確定した',
            ref: 'Sales.OrderConfirmed',
            timelines: ['Normal', 'PaymentRetry', 'CancelAfterConfirm'],
            resolved: false,
        });
        expect(sticky('MixedCurrencies').resolved).toBe(true);
        expect(stickyOf(stormings, 'es/OrderToCash/Normal')).toBeUndefined();
        expect(stickyOf(stormings, 'Sales.Order')).toBeUndefined();
    });

    test('the keys: Enter, F2, ⌘⇧C on a Mac and Ctrl+Shift+C elsewhere', () => {
        const all = actionsFor([sticky('OrderPlaced')], live);
        const key = (e: Partial<KeyboardEvent>, mac = true) =>
            actionOfKey({ key: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...e }, all, mac)?.id;
        expect(key({ key: 'Enter' })).toBe('chat');
        expect(key({ key: 'F2' })).toBe('edit');
        expect(key({ key: 'C', metaKey: true, shiftKey: true })).toBe('copyLink');
        expect(key({ key: 'c', ctrlKey: true, shiftKey: true }, false)).toBe('copyLink');
        expect(key({ key: 'c', ctrlKey: true, shiftKey: true })).toBeUndefined();
        expect(key({ key: 'Enter', altKey: true })).toBeUndefined();
        expect(shortcutText({ key: 'c', mod: true, shift: true }, true)).toBe('⌘⇧C');
        expect(shortcutText({ key: 'c', mod: true, shift: true }, false)).toBe('Ctrl+Shift+C');
    });
});

describe('a link to an element', () => {
    test('its fragment names the selection, and reads back', () => {
        const link = elementLink('http://127.0.0.1:4321/?x=1#old', 'es/OrderToCash/OrderPlaced');
        expect(link).toBe('http://127.0.0.1:4321/?x=1#select=es%2FOrderToCash%2FOrderPlaced');
        expect(linkedElement(new URL(link).hash)).toBe('es/OrderToCash/OrderPlaced');
        expect(linkedElement('')).toBeUndefined();
        expect(linkedElement('#other=1')).toBeUndefined();
    });
});

describe('the command palette', () => {
    const item = (label: string, detail?: string): PaletteItem => ({ id: label, label, ...(detail !== undefined && { detail }), section: 's', run: () => {} });
    test('every word typed is in the label or the detail, ignoring case and width', () => {
        const items = [item('注文を受け付けた', 'イベント · OrderPlaced'), item('リンクをコピー'), item('Ｃｈａｔ')];
        expect(matchItems(items, '').map((i) => i.id)).toEqual(['注文を受け付けた', 'リンクをコピー', 'Ｃｈａｔ']);
        expect(matchItems(items, 'orderplaced 注文').map((i) => i.id)).toEqual(['注文を受け付けた']);
        expect(matchItems(items, 'chat').map((i) => i.id)).toEqual(['Ｃｈａｔ']);
        expect(matchItems(items, 'なし')).toEqual([]);
    });
});

describe('Escape after a pick (the palette, the menu, a window closed)', () => {
    const esc = { key: 'Escape', isComposing: false };
    test('with the focus nowhere and stickies selected, Escape clears them; never while a window or menu is open, nor elsewhere', () => {
        expect(escapeClearsSelection(esc, { focusNowhere: true, selected: 1, open: false })).toBe(true);
        expect(escapeClearsSelection(esc, { focusNowhere: false, selected: 1, open: false })).toBe(false);
        expect(escapeClearsSelection(esc, { focusNowhere: true, selected: 0, open: false })).toBe(false);
        expect(escapeClearsSelection(esc, { focusNowhere: true, selected: 1, open: true })).toBe(false);
        expect(escapeClearsSelection({ key: 'Escape', isComposing: true }, { focusNowhere: true, selected: 1, open: false })).toBe(false);
        expect(escapeClearsSelection({ key: 'Enter', isComposing: false }, { focusNowhere: true, selected: 1, open: false })).toBe(false);
    });

    test('the palette closed without a pick gives the focus back to what had it, if it is still there and not the page', () => {
        const body = { id: 'body' } as unknown as Element;
        const field = { id: 'field' } as unknown as Element;
        const doc = (inPage: boolean) => ({ body, contains: () => inPage });
        expect(focusBack(field, doc(true))).toBe(field);
        expect(focusBack(field, doc(false))).toBeUndefined();
        expect(focusBack(body, doc(true))).toBeUndefined();
        expect(focusBack(null, doc(true))).toBeUndefined();
    });
});

describe('a press outside a sticky window', () => {
    test('cancels it, as Escape does; not a press inside (a text selection dragged out starts inside), nor while composing', () => {
        expect(outsidePressCancels({ inside: false, composing: false })).toBe(true);
        expect(outsidePressCancels({ inside: true, composing: false })).toBe(false);
        expect(outsidePressCancels({ inside: false, composing: true })).toBe(false);
    });
});
