// The request composer's targets and mentions (web/session/mentions.ts): the chips as the one source of the targets,
// mentions kept in step with them, the keys (IME composition included) and the `@` candidates.
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { analyze } from '@domaintrail/modeling/core/analyze';
import type { DomainModel } from '@domaintrail/modeling/model/model';
import { parseStormings } from '@domaintrail/modeling/storming/parse';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { loadWorkspace } from '@domaintrail/workspace/infrastructure/files';
import {
    addChips,
    bodyText,
    composerKey,
    editText,
    EMPTY_COMPOSER,
    insertMention,
    matchCandidates,
    MAX_REQUEST_TARGETS,
    mentionCandidates,
    mentionName,
    mentionQuery,
    parseBody,
    removeChip,
    type ComposerValue,
} from '@domaintrail/web/session/mentions';
import type { TargetDraft } from '@domaintrail/web/session/targets';
import { EXAMPLES } from './helpers.js';

const el = (element: string): TargetDraft => ({ target: { kind: 'DtElement', element }, label: element });
const order = el('Sales.Order');
const customer = el('Sales.Customer');
const invoice = el('Billing.Invoice');

/** Types `typed` at the end of the text, then picks `target` for the `@query` before the caret. */
function pick(value: ComposerValue, typed: string, target: TargetDraft, name: string): ComposerValue {
    const text = value.text + typed;
    const q = mentionQuery(text, text.length);
    if (!q) throw new Error(`no @query in ${text}`);
    const picked = insertMention({ ...value, text }, { start: q.start, end: text.length }, target, name);
    if (!picked) throw new Error('not picked');
    return picked.value;
}

describe('mentions in a body', () => {
    test('are @name[n] for a target the request has; the rest is text, never markup', () => {
        expect(parseBody('@注文[1] に @顧客[2] を <b>持たせる</b> @謎[3] a@b[1]', 2)).toEqual([
            { kind: 'mention', name: '注文', index: 0 },
            { kind: 'text', text: ' に ' },
            { kind: 'mention', name: '顧客', index: 1 },
            { kind: 'text', text: ' を <b>持たせる</b> @謎[3] a' },
            { kind: 'mention', name: 'b', index: 0 },
        ]);
        expect(parseBody('＠注文[1]', 1)).toEqual([{ kind: 'mention', name: '注文', index: 0 }]);
        expect(parseBody('no mention', 0)).toEqual([{ kind: 'text', text: 'no mention' }]);
        expect(bodyText('@注文[1] と @謎[3]', 1)).toBe('@注文 と @謎[3]');
        expect(mentionName('注文 (Order)')).toBe('注文(Order)');
        expect(mentionName('a[b]@c')).toBe('abc');
    });

    test('the @query is from the @ (or ＠) to the caret, not in an e-mail address nor across spaces or a finished mention', () => {
        expect(mentionQuery('注文と@ちゅう', 7)).toEqual({ start: 3, query: 'ちゅう' });
        expect(mentionQuery('＠注文', 3)).toEqual({ start: 0, query: '注文' });
        expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
        expect(mentionQuery('mail a@b', 8)).toBeUndefined();
        expect(mentionQuery('@注文 です', 6)).toBeUndefined();
        expect(mentionQuery('@注文[1]', 6)).toBeUndefined();
        expect(mentionQuery('@注文 です', 3)).toEqual({ start: 0, query: '注文' });
    });
});

describe('chips and mentions in step', () => {
    test('picking a candidate writes @name[n] and adds chip n; picking it again reuses the number', () => {
        let v = pick(EMPTY_COMPOSER, '@ちゅう', order, '注文');
        expect(v).toEqual({ text: '@注文[1] ', chips: [{ target: order, mentioned: true }] });
        v = pick(v, 'と@cus', customer, '顧客');
        v = pick(v, 'の@注', order, '注文');
        expect(v.text).toBe('@注文[1] と@顧客[2] の@注文[1] ');
        expect(v.chips.map((c) => c.target)).toEqual([order, customer]);
    });

    test('deleting a mention removes its chip unless another mention of it is left; the numbers follow', () => {
        let v = pick(pick(pick(EMPTY_COMPOSER, '@a', order, '注文'), '@b', customer, '顧客'), '@c', invoice, '請求書');
        v = pick(v, ' と @x', order, '注文');
        expect(v.text).toBe('@注文[1] @顧客[2] @請求書[3]  と @注文[1] ');
        // one of the two mentions of 注文 gone: it stays
        v = editText(v, v.text.replace('@注文[1] @顧客', '@顧客'));
        expect(v.chips.map((c) => c.target)).toEqual([order, customer, invoice]);
        // the mention of 顧客 gone: its chip goes, 請求書 becomes 2
        v = editText(v, v.text.replace('@顧客[2] ', ''));
        expect(v).toEqual({
            text: '@請求書[2]  と @注文[1] ',
            chips: [
                { target: order, mentioned: true },
                { target: invoice, mentioned: true },
            ],
        });
        // a mention broken while editing counts as deleted
        v = editText(v, v.text.replace('@請求書[2]', '@請求書[2'));
        expect(v.chips.map((c) => c.target)).toEqual([order]);
    });

    test('removing a chip turns its mentions into plain text and numbers the others down', () => {
        const v = pick(pick(pick(EMPTY_COMPOSER, '@a', order, '注文'), '@b', customer, '顧客'), '@c', order, '注文');
        expect(removeChip(v, 0)).toEqual({ text: '注文 @顧客[1] 注文 ', chips: [{ target: customer, mentioned: true }] });
    });

    test('chips added from the selection stay without a mention, each once, up to 20; a mention of one marks it', () => {
        let { value: v, skipped } = addChips(EMPTY_COMPOSER, [order, customer, order]);
        expect([v.chips, skipped]).toEqual([
            [
                { target: order, mentioned: false },
                { target: customer, mentioned: false },
            ],
            0,
        ]);
        v = editText({ ...v, text: 'plain' }, 'plain text');
        expect(v.chips).toHaveLength(2);
        v = pick(v, ' @c', customer, '顧客');
        expect(v.chips[1]).toEqual({ target: customer, mentioned: true });
        const many = Array.from({ length: 25 }, (_, i) => el(`Sales.E${i}`));
        const full = addChips(EMPTY_COMPOSER, many);
        expect([full.value.chips.length, full.skipped]).toEqual([MAX_REQUEST_TARGETS, 5]);
        const text = '@x';
        expect(insertMention({ ...full.value, text }, { start: 0, end: 2 }, order, '注文')).toBeUndefined();
        // a target already a chip can still be mentioned at the limit
        expect(insertMention({ ...full.value, text }, { start: 0, end: 2 }, many[3], 'E3')?.value.text).toBe('@E3[4] ');
    });
});

describe('the composer keys', () => {
    const key = (k: string, extra: object = {}): Parameters<typeof composerKey>[0] => ({ key: k, ...extra });

    test('with the candidates open: arrows move, Enter or Tab pick, Esc closes; ⌘/Ctrl+Enter sends', () => {
        expect(['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].map((k) => composerKey(key(k), true))).toEqual(['next', 'previous', 'pick', 'pick', 'close']);
        expect(composerKey(key('Enter'), false)).toBe('none');
        expect(composerKey(key('Enter', { shiftKey: true }), true)).toBe('none');
        expect(composerKey(key('Enter', { metaKey: true }), false)).toBe('send');
        expect(composerKey(key('Enter', { ctrlKey: true }), true)).toBe('send');
        expect(composerKey(key('a'), true)).toBe('none');
    });

    test('while an IME composes (@注文 being converted), no key picks a candidate nor sends', () => {
        for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
            for (const k of ['Enter', 'Tab', 'ArrowDown', 'ArrowUp', 'Escape']) expect(composerKey(key(k, ime), true)).toBe('none');
            expect(composerKey(key('Enter', { ...ime, metaKey: true }), false)).toBe('none');
            expect(composerKey(key('Enter', { ...ime, ctrlKey: true }), true)).toBe('none');
        }
        // the conversion confirmed: the same Enter picks
        expect(composerKey(key('Enter', { isComposing: false, keyCode: 13 }), true)).toBe('pick');
    });
});

const SAMPLE = await readFile(path.join(import.meta.dir, 'fixtures', 'dtes', 'delivery-cancellation.dtes'), 'utf8');
const { stormings: parsed } = await parseStormings([{ path: 'es.dtes', text: SAMPLE }]);
const stormings = [{ id: parsed[0].id, storming: parsed[0] }] as unknown as StormingView[];
const workspace = await loadWorkspace(EXAMPLES);
const model = (await analyze(workspace)).model as DomainModel;
const sources = workspace.map((f) => ({ path: f.path, text: f.text }));

describe('the @ candidates', () => {
    const candidates = mentionCandidates({ mode: 'label', model, stormings, sources });

    test('every element, state and command of the model, and every note of the stormings (not their timelines)', () => {
        const order = candidates.find((c) => c.qualified === 'Sales.Order');
        expect(order).toMatchObject({
            name: '注文',
            mention: '注文',
            kind: { language: 'dt', kind: 'aggregate' },
            target: { target: { kind: 'DtElement', element: 'Sales.Order' } },
        });
        expect(order?.target.range?.path).toBe('sales/order.dt');
        expect(candidates.find((c) => c.qualified === 'Sales.Order#Draft')).toMatchObject({ kind: { kind: 'state' }, name: '注文.下書き' });
        expect(candidates.some((c) => c.kind.kind === 'command')).toBe(true);
        const event = candidates.find((c) => c.qualified === 'DeliveryCancellation/ShipmentCancelled');
        expect(event).toMatchObject({
            kind: { language: 'dtes', kind: 'event' },
            mention: '配送がキャンセルされた',
            target: { target: { kind: 'DtesElement' } },
        });
        expect(candidates.some((c) => c.qualified === 'DeliveryCancellation/Normal')).toBe(false);
        expect(candidates.some((c) => c.target.target.kind === 'DtesOccurrence' || c.target.target.kind === 'Workspace')).toBe(false);
        expect(new Set(candidates.map((c) => c.key)).size).toBe(candidates.length);
    });

    test('a query matches the label, the name or the qualified name, best first; the display mode names them', () => {
        expect(matchCandidates(candidates, '注文')[0].qualified).toBe('Sales.Order');
        expect(matchCandidates(candidates, 'sales.ord')[0].qualified).toBe('Sales.Order');
        expect(matchCandidates(candidates, 'Order').map((c) => c.qualified)).toContain('Sales.Order');
        // letters in order (fuzzy)
        expect(matchCandidates(candidates, 'shpcncl').map((c) => c.qualified)).toContain('DeliveryCancellation/ShipmentCancelled');
        expect(matchCandidates(candidates, 'zzzz')).toEqual([]);
        const byName = mentionCandidates({ mode: 'name', model, stormings, sources }).find((c) => c.qualified === 'Sales.Order');
        expect([byName?.name, byName?.mention]).toEqual(['Order', 'Order']);
    });
});
