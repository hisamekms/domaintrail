// The selection as suggested targets of the request being written (apps/web/session/suggestions.ts): merged with the
// confirmed chips, dismissed until the selection changes, within the limit of targets, and the `C` key.
import { describe, expect, test } from 'bun:test';
import { MAX_REQUEST_TARGETS, type ComposerValue } from './mentions';
import { confirmSelection, dismiss, isConfirmKey, isTyping, NO_DISMISSALS, suggestions, targetsToSend } from './suggestions';
import type { TargetDraft } from './targets';

const dt = (element: string): TargetDraft => ({ target: { kind: 'DtElement', element }, label: element });
const es = (local: string): TargetDraft => ({ target: { kind: 'DtesElement', storming: 'Returns', local } });
const value = (chips: TargetDraft[], text = ''): ComposerValue => ({ text, chips: chips.map((target) => ({ target, mentioned: false })), people: [] });
const names = (ts: readonly TargetDraft[]): string[] =>
    ts.map((t) => (t.target.kind === 'DtElement' ? t.target.element : t.target.kind === 'DtesElement' ? t.target.local : ''));

describe('suggested targets', () => {
    test('the selection not confirmed yet, each once, after the confirmed chips when sent', () => {
        const v = value([dt('Sales.Order')], '#注文[1] を直す');
        const s = suggestions(v, [dt('Sales.Order'), es('ReturnRequested'), es('ReturnRequested'), dt('Sales.Customer')], NO_DISMISSALS);
        expect(names(s.targets)).toEqual(['ReturnRequested', 'Sales.Customer']);
        // the confirmed ones keep their numbers (the text's mentions), the suggestions follow
        expect(names(targetsToSend(v, s))).toEqual(['Sales.Order', 'ReturnRequested', 'Sales.Customer']);
        expect(suggestions(value([]), [], NO_DISMISSALS)).toEqual({ targets: [], overLimit: 0 });
    });

    test('a dismissed suggestion stays dismissed for that selection only; another selection replaces the suggestions', () => {
        const selection = [dt('Sales.Order'), dt('Sales.Customer')];
        const d = dismiss(NO_DISMISSALS, selection, dt('Sales.Order'));
        expect(names(suggestions(value([]), selection, d).targets)).toEqual(['Sales.Customer']);
        const both = dismiss(d, selection, dt('Sales.Customer'));
        expect(suggestions(value([]), selection, both).targets).toEqual([]);
        // the selection changed: nothing is dismissed any more, and the confirmed chips stay
        const v = value([dt('Sales.Invoice')]);
        expect(names(suggestions(v, [dt('Sales.Order')], both).targets)).toEqual(['Sales.Order']);
        expect(names(targetsToSend(v, suggestions(v, [dt('Sales.Order')], both)))).toEqual(['Sales.Invoice', 'Sales.Order']);
    });

    test('confirmed and suggested together never pass the limit', () => {
        const confirmed = Array.from({ length: MAX_REQUEST_TARGETS - 1 }, (_, i) => dt(`Sales.E${i}`));
        const s = suggestions(value(confirmed), [dt('Sales.A'), dt('Sales.B'), dt('Sales.C')], NO_DISMISSALS);
        expect(names(s.targets)).toEqual(['Sales.A']);
        expect(s.overLimit).toBe(2);
        expect(targetsToSend(value(confirmed), s)).toHaveLength(MAX_REQUEST_TARGETS);
    });

    test('confirming the selection makes solid chips of what is not one yet', () => {
        const confirmed = confirmSelection(value([dt('Sales.Order')]), [dt('Sales.Order'), es('ReturnRequested')]);
        expect(confirmed.value.chips.map((c) => c.target)).toEqual([dt('Sales.Order'), es('ReturnRequested')]);
        expect(confirmed.skipped).toBe(0);
        expect(suggestions(confirmed.value, [dt('Sales.Order'), es('ReturnRequested')], NO_DISMISSALS).targets).toEqual([]);
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
