// The request composer's targets and mentions (apps/web/session/mentions.ts): the chips as the one source of the targets,
// mentions kept in step with them, the people mentioned likewise, the keys (IME composition included), the `#`
// candidates (elements) and the `@` ones (people).
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { type DomainModel } from '@domaintrail/modeling';
import { analyze } from '@domaintrail/analysis';
import type { StormingView } from '@domaintrail/visualization/protocol';
import {
    addChips,
    bodyText,
    composerKey,
    editText,
    EMPTY_COMPOSER,
    matchCandidates,
    matchPeople,
    MAX_REQUEST_MENTIONS,
    MAX_REQUEST_TARGETS,
    mentionCandidates,
    mentionName,
    mentionQuery,
    parseBody,
    removeChip,
    type ComposerValue,
    type PersonCandidate,
} from './mentions';
import type { TargetDraft } from './targets';
import { composerLines, composerValue, mentionFits, type ComposerMention } from './composer-text';
import { exampleSources } from '../test-helpers';

const el = (element: string): TargetDraft => ({ target: { kind: 'DtElement', element }, label: element });
const order = el('Sales.Order');
const customer = el('Sales.Customer');
const invoice = el('Billing.Invoice');

/** Types `typed` at the end of the text, then picks `mention` for the query before the caret, as the editor does. */
function pickAt(value: ComposerValue, typed: string, mention: ComposerMention): ComposerValue {
    const text = value.text + typed;
    const q = mentionQuery(text, text.length);
    if (q?.sign !== (mention.kind === 'element' ? '#' : '@')) throw new Error(`no ${mention.kind} query in ${text}`);
    if (!mentionFits(value, mention)) throw new Error('not picked');
    const lines = composerLines({ ...value, text: text.slice(0, q.start) });
    lines[lines.length - 1].push(mention, { kind: 'text', text: ' ' });
    return composerValue(value, lines);
}

/** Types `typed` at the end of the text, then picks `target` for the `#query` before the caret. */
const pick = (value: ComposerValue, typed: string, target: TargetDraft, name: string): ComposerValue => pickAt(value, typed, { kind: 'element', name, target });

/** Types `typed` at the end of the text, then picks `person` for the `@query` before the caret. */
const pickPerson = (value: ComposerValue, typed: string, person: string, name: string): ComposerValue => pickAt(value, typed, { kind: 'person', name, person });

describe('mentions in a body', () => {
    test('#name[n] (and @name[n], as written before) for a target the request has, @name[pN] a person; the rest is text', () => {
        expect(parseBody('#注文[1] に @顧客[2] を <b>持たせる</b> #謎[3] @佐藤[p1] a#b[1]', { targets: 2, people: 1 })).toEqual([
            { kind: 'element', name: '注文', index: 0 },
            { kind: 'text', text: ' に ' },
            { kind: 'element', name: '顧客', index: 1 },
            { kind: 'text', text: ' を <b>持たせる</b> #謎[3] ' },
            { kind: 'person', name: '佐藤', index: 0 },
            { kind: 'text', text: ' a' },
            { kind: 'element', name: 'b', index: 0 },
        ]);
        expect(parseBody('＃注文[1]', { targets: 1, people: 0 })).toEqual([{ kind: 'element', name: '注文', index: 0 }]);
        expect(parseBody('no mention', { targets: 0, people: 0 })).toEqual([{ kind: 'text', text: 'no mention' }]);
        // on one line: elements as #name (an old @name[n] too), people as @name
        const order = { target: { kind: 'DtElement', element: 'Sales.Order' } };
        expect(bodyText('#注文[1] と @顧客[1] と #謎[3] を @佐藤[p1]', [order])).toBe('#注文 と #顧客 と #謎[3] を @佐藤');
        // a state or a command by its own name, as the chips show it
        const paid = { target: { kind: 'DtElement', element: 'Billing.Invoice#Paid' } };
        expect(bodyText('#請求書.支払済み[1] に @佐藤[p1]', [paid])).toBe('#支払済み に @佐藤');
        expect(bodyText('#請求書.支払済み[1] に @佐藤[p1]', [paid], 1, true)).toBe('支払済み に 佐藤');
        expect(mentionName('注文 (Order)')).toBe('注文(Order)');
        expect(mentionName('a[b]@c#d')).toBe('abcd');
    });

    test('the query is from its # or @ (full-width too) to the caret, not in a word nor across spaces or a finished mention', () => {
        expect(mentionQuery('注文と#ちゅう', 7)).toEqual({ sign: '#', start: 3, query: 'ちゅう' });
        expect(mentionQuery('＃注文', 3)).toEqual({ sign: '#', start: 0, query: '注文' });
        expect(mentionQuery('＠さと', 3)).toEqual({ sign: '@', start: 0, query: 'さと' });
        expect(mentionQuery('@', 1)).toEqual({ sign: '@', start: 0, query: '' });
        expect(mentionQuery('#', 1)).toEqual({ sign: '#', start: 0, query: '' });
        expect(mentionQuery('mail a@b', 8)).toBeUndefined();
        expect(mentionQuery('see x.html#top', 14)).toBeUndefined();
        expect(mentionQuery('#注文 です', 6)).toBeUndefined();
        expect(mentionQuery('#注文[1]', 6)).toBeUndefined();
        expect(mentionQuery('@佐藤[p1]', 7)).toBeUndefined();
        expect(mentionQuery('#注文 です', 3)).toEqual({ sign: '#', start: 0, query: '注文' });
    });
});

describe('chips and mentions in step', () => {
    test('picking a candidate writes #name[n] and adds chip n; picking it again reuses the number', () => {
        let v = pick(EMPTY_COMPOSER, '#ちゅう', order, '注文');
        expect(v).toEqual({ text: '#注文[1] ', chips: [{ target: order, mentioned: true }], people: [] });
        v = pick(v, 'と#cus', customer, '顧客');
        v = pick(v, 'の#注', order, '注文');
        expect(v.text).toBe('#注文[1] と#顧客[2] の#注文[1] ');
        expect(v.chips.map((c) => c.target)).toEqual([order, customer]);
    });

    test('deleting a mention removes its chip unless another mention of it is left; the numbers follow', () => {
        let v = pick(pick(pick(EMPTY_COMPOSER, '#a', order, '注文'), '#b', customer, '顧客'), '#c', invoice, '請求書');
        v = pick(v, ' と #x', order, '注文');
        expect(v.text).toBe('#注文[1] #顧客[2] #請求書[3]  と #注文[1] ');
        // one of the two mentions of 注文 gone: it stays
        v = editText(v, v.text.replace('#注文[1] #顧客', '#顧客'));
        expect(v.chips.map((c) => c.target)).toEqual([order, customer, invoice]);
        // the mention of 顧客 gone: its chip goes, 請求書 becomes 2
        v = editText(v, v.text.replace('#顧客[2] ', ''));
        expect(v).toEqual({
            text: '#請求書[2]  と #注文[1] ',
            chips: [
                { target: order, mentioned: true },
                { target: invoice, mentioned: true },
            ],
            people: [],
        });
        // a mention broken while editing counts as deleted
        v = editText(v, v.text.replace('#請求書[2]', '#請求書[2'));
        expect(v.chips.map((c) => c.target)).toEqual([order]);
    });

    test('a draft written before # still keeps its @name[n] in step with the chips', () => {
        const v: ComposerValue = { text: '@注文[1] と @顧客[2]', chips: [order, customer].map((target) => ({ target, mentioned: true })), people: [] };
        expect(editText(v, '@顧客[2]')).toMatchObject({ text: '@顧客[1]', chips: [{ target: customer }] });
        expect(removeChip(v, 0).text).toBe('注文 と @顧客[1]');
    });

    test('removing a chip turns its mentions into plain text and numbers the others down; people stay as they are', () => {
        const v = pickPerson(pick(pick(pick(EMPTY_COMPOSER, '#a', order, '注文'), '#b', customer, '顧客'), '#c', order, '注文'), '@s', 'p:sato', '佐藤');
        expect(removeChip(v, 0)).toEqual({ text: '注文 #顧客[1] 注文 @佐藤[p1] ', chips: [{ target: customer, mentioned: true }], people: ['p:sato'] });
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
        v = pick(v, ' #c', customer, '顧客');
        expect(v.chips[1]).toEqual({ target: customer, mentioned: true });
        const many = Array.from({ length: 25 }, (_, i) => el(`Sales.E${i}`));
        const full = addChips(EMPTY_COMPOSER, many);
        expect([full.value.chips.length, full.skipped]).toEqual([MAX_REQUEST_TARGETS, 5]);
        expect(mentionFits(full.value, { kind: 'element', name: '注文', target: order })).toBe(false);
        // a target already a chip can still be mentioned at the limit
        expect(pick(full.value, '#x', many[3], 'E3').text).toBe('#E3[4] ');
    });
});

describe('people and their mentions in step', () => {
    test('picking a person writes @name[pN] and adds them; again, the same number; deleting every mention forgets them', () => {
        let v = pickPerson(EMPTY_COMPOSER, '@さ', 'p:sato', '佐藤 花子');
        expect(v).toEqual({ text: '@佐藤花子[p1] ', chips: [], people: ['p:sato'] });
        v = pickPerson(v, 'と@す', 'p:suzuki', '鈴木');
        v = pickPerson(v, 'と@さ', 'p:sato', '佐藤');
        expect(v.text).toBe('@佐藤花子[p1] と@鈴木[p2] と@佐藤[p1] ');
        expect(v.people).toEqual(['p:sato', 'p:suzuki']);
        // one mention of 佐藤 left: kept; then none: forgotten, 鈴木 becomes p1
        v = editText(v, v.text.replace('@佐藤花子[p1] ', ''));
        expect(v.people).toEqual(['p:sato', 'p:suzuki']);
        v = editText(v, v.text.replace('と@佐藤[p1] ', ''));
        expect(v).toEqual({ text: 'と@鈴木[p1] ', chips: [], people: ['p:suzuki'] });
    });

    test('at most 20 people; someone already mentioned can be mentioned again at the limit', () => {
        const people = Array.from({ length: MAX_REQUEST_MENTIONS }, (_, i) => `p:${i}`);
        const full: ComposerValue = { ...EMPTY_COMPOSER, text: people.map((_, i) => `@n${i}[p${i + 1}] `).join(''), people };
        expect(mentionFits(full, { kind: 'person', name: 'New', person: 'p:new' })).toBe(false);
        expect(pickPerson(full, '@x', 'p:3', 'Three').text).toEndWith(' @Three[p4] ');
    });

    test('the people offered: by name (start, contains, letters in order), in the order given among equals', () => {
        const people: PersonCandidate[] = [
            { id: 'a', name: 'Ann', role: 'participant', online: true },
            { id: 'h', name: 'Hanako', role: 'facilitator', online: true },
            { id: 'b', name: 'Bob', role: 'participant', online: false },
        ];
        expect(matchPeople(people, '').map((p) => p.id)).toEqual(['a', 'h', 'b']);
        expect(matchPeople(people, 'an').map((p) => p.id)).toEqual(['a', 'h']);
        expect(matchPeople(people, 'hk').map((p) => p.id)).toEqual(['h']);
        expect(matchPeople([], 'a')).toEqual([]);
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

    test('while an IME composes (#注文 being converted), no key picks a candidate nor sends', () => {
        for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
            for (const k of ['Enter', 'Tab', 'ArrowDown', 'ArrowUp', 'Escape']) expect(composerKey(key(k, ime), true)).toBe('none');
            expect(composerKey(key('Enter', { ...ime, metaKey: true }), false)).toBe('none');
            expect(composerKey(key('Enter', { ...ime, ctrlKey: true }), true)).toBe('none');
        }
        // the conversion confirmed: the same Enter picks
        expect(composerKey(key('Enter', { isComposing: false, keyCode: 13 }), true)).toBe('pick');
    });
});

const SAMPLE = await readFile(path.join(import.meta.dir, '..', '..', '..', 'test', 'fixtures', 'dtes', 'delivery-cancellation.dtes'), 'utf8');
const { stormings: parsed } = (await analyze([{ path: 'es.dtes', text: SAMPLE }])).stormings;
const stormings = [{ id: parsed[0].id, storming: parsed[0] }] as unknown as StormingView[];
const workspace = await exampleSources();
const model = (await analyze(workspace)).model as DomainModel;
const sources = workspace.map((f) => ({ path: f.path, text: f.text }));

describe('the # candidates', () => {
    const candidates = mentionCandidates({ mode: 'label', model, stormings, sources });

    test('every element, state and command of the model, every storming and its notes (not their timelines)', () => {
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
        // a storming as a whole, by its title
        expect(candidates.find((c) => c.qualified === 'DeliveryCancellation')).toMatchObject({
            name: '配送キャンセル',
            mention: '配送キャンセル',
            kind: { language: 'dtes', kind: 'storming' },
            target: { target: { kind: 'DtesStorming', storming: 'DeliveryCancellation' } },
        });
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

    test('an element without a label (empty or blank) is named and mentioned by its name', async () => {
        const text =
            'context S " " {\n  id AId: UUID\n  aggregate A "" {\n    id: AId\n    state Open "  "\n    state Done "完了"\n    command close() "" Open -> Done\n  }\n}\n';
        const blank = (await analyze([{ path: 's.dt', text }])).model as DomainModel;
        const found = mentionCandidates({ mode: 'label', model: blank, stormings: [], sources: [{ path: 's.dt', text }] });
        const of = (q: string) => found.find((c) => c.qualified === q);
        expect([of('S.A')?.name, of('S.A')?.mention, of('S.A')?.where]).toEqual(['A', 'A', 'S']);
        expect([of('S.A#Open')?.name, of('S.A#Open')?.mention]).toEqual(['A.Open', 'A.Open']);
        expect([of('S.A#Done')?.name, of('S.A#Done')?.mention]).toEqual(['A.完了', 'A.完了']);
        expect([of('S.A:close')?.name, of('S.A:close')?.mention]).toEqual(['A.close', 'A.close']);
        expect(of('S.A')?.search.every((s) => s.trim() !== '')).toBe(true);
    });
});
