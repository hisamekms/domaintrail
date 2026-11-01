// The selection as suggested targets of the request being written (ADR 0026, the composer): select an element, then
// type. What is selected (on the canvas or in the explorer) shows as dashed chips after the confirmed ones; sending
// takes them as targets, `×` dismisses one until the selection changes, the 💬 button or `C` confirms them. Suggestions
// are never stored: the draft keeps the confirmed chips only. Pure: no React.
import { addChips, MAX_REQUEST_TARGETS, type ComposerValue } from './mentions';
import { targetKey, type TargetDraft } from './targets';

/** The suggestions dismissed with `×`, for one selection: a new selection forgets them. */
export interface Dismissals {
    readonly selection: string;
    readonly keys: ReadonlySet<string>;
}

export const NO_DISMISSALS: Dismissals = { selection: '', keys: new Set() };

/** A key equal for equal selections (the targets in order). */
export const selectionKey = (selection: readonly TargetDraft[]): string => selection.map((s) => targetKey(s.target)).join('\n');

/** The dismissals that still hold for `selection`: none once it changed. */
export const dismissalsFor = (d: Dismissals, selection: readonly TargetDraft[]): ReadonlySet<string> =>
    d.selection === selectionKey(selection) ? d.keys : new Set();

/** One more suggestion dismissed for `selection`. */
export function dismiss(d: Dismissals, selection: readonly TargetDraft[], target: TargetDraft): Dismissals {
    const key = selectionKey(selection);
    const keys = new Set(d.selection === key ? d.keys : []);
    keys.add(targetKey(target.target));
    return { selection: key, keys };
}

/** What the composer suggests: the selection's targets not confirmed yet, nor dismissed, each once, within the limit. */
export interface Suggestions {
    readonly targets: readonly TargetDraft[];
    /** Selected targets left out because confirmed and suggested ones would pass the limit. */
    readonly overLimit: number;
}

export function suggestions(value: ComposerValue, selection: readonly TargetDraft[], d: Dismissals): Suggestions {
    const dismissed = dismissalsFor(d, selection);
    const taken = new Set(value.chips.map((c) => targetKey(c.target.target)));
    const room = Math.max(0, MAX_REQUEST_TARGETS - value.chips.length);
    const targets: TargetDraft[] = [];
    let overLimit = 0;
    for (const s of selection) {
        const key = targetKey(s.target);
        if (taken.has(key) || dismissed.has(key)) continue;
        taken.add(key);
        if (targets.length < room) targets.push(s);
        else overLimit++;
    }
    return { targets, overLimit };
}

/** The targets a request is sent with: the confirmed chips (as numbered in the text), then the suggestions. */
export function targetsToSend(value: ComposerValue, suggested: Suggestions): TargetDraft[] {
    return [...value.chips.map((c) => c.target), ...suggested.targets].slice(0, MAX_REQUEST_TARGETS);
}

/** The selection confirmed as chips (the 💬 button, `C`): what fits; `skipped` did not. */
export function confirmSelection(value: ComposerValue, selection: readonly TargetDraft[]): { readonly value: ComposerValue; readonly skipped: number } {
    return addChips(value, selection);
}

/** Whether a key press confirms the selection: `C` alone, outside anything one types in. */
export function isConfirmKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing' | 'repeat'>, typing: boolean): boolean {
    return !typing && !e.isComposing && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'c' || e.key === 'C');
}

/** Whether an element takes typed text (an input, a text area, a select, something editable). */
export function isTyping(el: Element | null): boolean {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
        const type = (el.getAttribute('type') ?? 'text').toLowerCase();
        return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type);
    }
    return 'isContentEditable' in el && el.isContentEditable === true;
}
