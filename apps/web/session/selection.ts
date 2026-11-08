// The selection added to the request being written (ADR 0026, the composer): selecting changes nothing in the
// composer; the 💬 next to the selection (on the canvas, or in the inspector's heading) or `C` adds it as chips. Pure:
// no React.
import { addChips, type ComposerValue } from './mentions';
import { targetKey, type TargetDraft } from './targets';

/** The selection added as chips (the 💬 button, `C`): what fits; `skipped` did not. */
export function confirmSelection(value: ComposerValue, selection: readonly TargetDraft[]): { readonly value: ComposerValue; readonly skipped: number } {
    return addChips(value, selection);
}

/** Whether every selected target already is a chip: the 💬 then shows as added, and adds nothing. */
export function isAdded(value: ComposerValue, selection: readonly TargetDraft[]): boolean {
    const taken = new Set(value.chips.map((c) => targetKey(c.target.target)));
    return selection.length > 0 && selection.every((s) => taken.has(targetKey(s.target)));
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
