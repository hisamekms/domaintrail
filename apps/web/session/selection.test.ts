// The selection added to the request being written (apps/web/session/selection.ts): the chips it adds, whether it is
// added already, and the `C` key.
import { describe, expect, test } from 'bun:test';
import { MAX_REQUEST_TARGETS, type ComposerValue } from './mentions';
import { confirmSelection, isAdded, isConfirmKey, isTyping } from './selection';
import type { TargetDraft } from './targets';

const dt = (element: string): TargetDraft => ({ target: { kind: 'DtElement', element }, label: element });
const es = (local: string): TargetDraft => ({ target: { kind: 'DtesElement', storming: 'Returns', local } });
const value = (chips: TargetDraft[], text = ''): ComposerValue => ({ text, chips: chips.map((target) => ({ target, mentioned: false })), people: [] });

describe('adding the selection', () => {
    test('adds as chips what is not one yet, each once, after the chips there are', () => {
        const added = confirmSelection(value([dt('Sales.Order')]), [dt('Sales.Order'), es('ReturnRequested'), es('ReturnRequested')]);
        expect(added.value.chips.map((c) => c.target)).toEqual([dt('Sales.Order'), es('ReturnRequested')]);
        expect(added.skipped).toBe(0);
    });

    test('never passes the limit: what does not fit is skipped', () => {
        const chips = Array.from({ length: MAX_REQUEST_TARGETS - 1 }, (_, i) => dt(`Sales.E${i}`));
        const added = confirmSelection(value(chips), [dt('Sales.A'), dt('Sales.B'), dt('Sales.C')]);
        expect(added.value.chips).toHaveLength(MAX_REQUEST_TARGETS);
        expect(added.value.chips.at(-1)?.target).toEqual(dt('Sales.A'));
        expect(added.skipped).toBe(2);
    });

    test('is added once every selected target is a chip; nothing selected is not', () => {
        const v = value([dt('Sales.Order'), es('ReturnRequested')]);
        expect(isAdded(v, [es('ReturnRequested'), dt('Sales.Order')])).toBe(true);
        expect(isAdded(v, [dt('Sales.Order'), dt('Sales.Customer')])).toBe(false);
        expect(isAdded(v, [])).toBe(false);
        // adding it again changes nothing
        expect(confirmSelection(v, [dt('Sales.Order')]).value.chips).toEqual(v.chips);
    });
});

describe('the C key', () => {
    const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({
        key: k,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        isComposing: false,
        repeat: false,
        ...extra,
    });
    test('C alone, never while typing, composing or with a modifier', () => {
        expect(isConfirmKey(key('c'), false)).toBe(true);
        expect(isConfirmKey(key('C'), false)).toBe(true);
        expect(isConfirmKey(key('c'), true)).toBe(false);
        expect(isConfirmKey(key('c', { metaKey: true }), false)).toBe(false);
        expect(isConfirmKey(key('c', { ctrlKey: true }), false)).toBe(false);
        expect(isConfirmKey(key('c', { isComposing: true }), false)).toBe(false);
        expect(isConfirmKey(key('c', { repeat: true }), false)).toBe(false);
        expect(isConfirmKey(key('v'), false)).toBe(false);
    });
    test('what takes typed text', () => {
        const el = (tagName: string, attrs: Record<string, string> = {}, editable = false): Element =>
            ({ tagName, getAttribute: (a: string) => attrs[a] ?? null, isContentEditable: editable }) as unknown as Element;
        expect(isTyping(el('TEXTAREA'))).toBe(true);
        expect(isTyping(el('INPUT'))).toBe(true);
        expect(isTyping(el('INPUT', { type: 'checkbox' }))).toBe(false);
        expect(isTyping(el('DIV', {}, true))).toBe(true);
        expect(isTyping(el('DIV'))).toBe(false);
        expect(isTyping(null)).toBe(false);
    });
});
