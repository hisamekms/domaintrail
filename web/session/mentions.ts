// The request composer's targets and mentions (ADR 0026, appendix "Requests with several targets"), without React.
//
// A request has 0 to 20 targets: the composer's chips, the single source of truth (no chip: the whole workspace). The
// body can mention a target as `@name[n]`, n its number among the request's targets (from 1): picking a candidate after
// `@` adds a chip and writes the mention; deleting every mention of a chip that came from a mention removes the chip;
// removing a chip turns its mentions into plain text; the numbers follow the chips. The body stays plain text: the
// stream reads the mentions back with `parseBody` and renders them as text and links, never as HTML.
import { declarations } from '@domaintrail/modeling/storming/ir';
import { firstDeclarations } from '@domaintrail/visualization/domain/storming/semantic';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { MAX_REQUEST_TARGETS } from '@domaintrail/collaboration/domain/targets';
import { nameIn } from '../model-utils';
import { targetKey, targetName, targetOfSelection, type NamingContext, type TargetDraft } from './targets';

export { MAX_REQUEST_TARGETS };

/** A target of the request being written: `mentioned` once the body mentioned it (then deleting its mentions removes it). */
export interface ComposerChip {
    readonly target: TargetDraft;
    readonly mentioned: boolean;
}

/** The request being written: its text and its targets. */
export interface ComposerValue {
    readonly text: string;
    readonly chips: readonly ComposerChip[];
}

export const EMPTY_COMPOSER: ComposerValue = { text: '', chips: [] };

/** `@name[n]` (or the full-width `＠` a Japanese IME types): a name without spaces, brackets or `@`, and a number 1–99. */
const MENTION = /[@＠]([^\s@＠[\]]{1,80})\[([1-9]\d?)\]/gu;

/** A piece of a body: text, or a mention of target `index` (0-based) written with `name`. */
export type BodySegment = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'mention'; readonly name: string; readonly index: number };

/**
 * A body as text and mentions. Only mentions of a target the request has (`index < count`) are mentions; anything
 * else stays text as it was written.
 */
export function parseBody(text: string, count: number): BodySegment[] {
    const out: BodySegment[] = [];
    let last = 0;
    for (const m of text.matchAll(MENTION)) {
        const index = Number(m[2]) - 1;
        if (index >= count) continue;
        if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
        out.push({ kind: 'mention', name: m[1], index });
        last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
    return out;
}

/** A body as one reads it on one line: each mention as `@name`, without its number. */
export const bodyText = (text: string, count: number): string =>
    parseBody(text, count)
        .map((seg) => (seg.kind === 'text' ? seg.text : `@${seg.name}`))
        .join('');

/** The numbers (0-based) of the targets a text mentions. */
const mentionedIn = (text: string): Set<number> => new Set([...text.matchAll(MENTION)].map((m) => Number(m[2]) - 1));

/** The text with each mention's number mapped: to another number, or (undefined) to its name as plain text. */
function renumber(text: string, map: (index: number) => number | undefined): string {
    return text.replace(MENTION, (_all, name: string, n: string) => {
        const to = map(Number(n) - 1);
        return to === undefined ? name : `@${name}[${to + 1}]`;
    });
}

/** A name as a mention writes it: no spaces, brackets or `@`, at most 80 characters. */
export const mentionName = (name: string): string => name.replace(/[\s@＠[\]]/gu, '').slice(0, 80) || '?';

/** The `@query` the caret is in (from its `@` to the caret), if any: what the candidates are matched with. */
export function mentionQuery(text: string, caret: number): { readonly start: number; readonly query: string } | undefined {
    const before = text.slice(0, caret);
    const at = Math.max(before.lastIndexOf('@'), before.lastIndexOf('＠'));
    if (at < 0) return undefined;
    const query = before.slice(at + 1);
    if (query.length > 40 || /[\s@＠[\]]/u.test(query)) return undefined;
    // not inside a word such as an e-mail address
    if (at > 0 && /[A-Za-z0-9._%+-]/.test(before[at - 1])) return undefined;
    return { start: at, query };
}

/** Removes the chip at `index`: its mentions become plain text and the mentions after it are numbered down. */
export function removeChip(value: ComposerValue, index: number): ComposerValue {
    return {
        text: renumber(value.text, (n) => (n === index ? undefined : n > index ? n - 1 : n)),
        chips: value.chips.filter((_, i) => i !== index),
    };
}

/** Removes the chips at `indexes` (as `removeChip`, all at once). */
function removeChips(value: ComposerValue, indexes: ReadonlySet<number>): ComposerValue {
    if (indexes.size === 0) return value;
    const kept = value.chips.map((_, i) => i).filter((i) => !indexes.has(i));
    const to = new Map(kept.map((old, i) => [old, i]));
    return { text: renumber(value.text, (n) => to.get(n)), chips: kept.map((i) => value.chips[i]) };
}

/**
 * The text edited: a chip that came from a mention goes once no mention of it is left (as if removed with ×, but its
 * mentions are gone already); chips added otherwise stay.
 */
export function editText(value: ComposerValue, text: string): ComposerValue {
    const mentioned = mentionedIn(text);
    const gone = new Set(value.chips.flatMap((c, i) => (c.mentioned && !mentioned.has(i) ? [i] : [])));
    return removeChips({ text, chips: value.chips }, gone);
}

/** The index of a target among the chips, if it is one. */
const indexOf = (chips: readonly ComposerChip[], target: TargetDraft): number => {
    const key = targetKey(target.target);
    return chips.findIndex((c) => targetKey(c.target.target) === key);
};

/**
 * Picks a candidate for the `@query` from `start` to `end`: writes `@name[n] ` there and makes the target chip n (the
 * chip it already is, or a new one). Undefined when a new chip would pass the limit.
 */
export function insertMention(
    value: ComposerValue,
    at: { readonly start: number; readonly end: number },
    target: TargetDraft,
    name: string,
): { readonly value: ComposerValue; readonly caret: number } | undefined {
    let index = indexOf(value.chips, target);
    let chips = value.chips;
    if (index < 0) {
        if (chips.length >= MAX_REQUEST_TARGETS) return undefined;
        index = chips.length;
        chips = [...chips, { target, mentioned: true }];
    } else if (!chips[index].mentioned) {
        chips = chips.map((c, i) => (i === index ? { ...c, mentioned: true } : c));
    }
    const token = `@${mentionName(name)}[${index + 1}] `;
    const text = value.text.slice(0, at.start) + token + value.text.slice(at.end);
    return { value: { text, chips }, caret: at.start + token.length };
}

/** Adds targets as chips (the selection's `+`): each once, up to the limit. `skipped`: how many did not fit. */
export function addChips(value: ComposerValue, targets: readonly TargetDraft[]): { readonly value: ComposerValue; readonly skipped: number } {
    let chips = value.chips;
    let skipped = 0;
    for (const target of targets) {
        if (indexOf(chips, target) >= 0) continue;
        if (chips.length >= MAX_REQUEST_TARGETS) {
            skipped++;
            continue;
        }
        chips = [...chips, { target, mentioned: false }];
    }
    return { value: { ...value, chips }, skipped };
}

/** What a key does in the composer. */
export type ComposerKey = 'none' | 'next' | 'previous' | 'pick' | 'close' | 'send';

/** The fields of a keyboard event the composer reads. */
export interface KeyInput {
    readonly key: string;
    readonly keyCode?: number;
    readonly isComposing?: boolean;
    readonly metaKey?: boolean;
    readonly ctrlKey?: boolean;
    readonly shiftKey?: boolean;
    readonly altKey?: boolean;
}

/**
 * The composer's keys: with the candidates open, ↑ ↓ move, Enter or Tab pick and Esc closes; ⌘/Ctrl+Enter sends.
 * While an IME composes (`isComposing`, or the key code 229 some browsers give instead), no key does anything: its
 * Enter confirms the conversion, never picks a candidate nor sends.
 */
export function composerKey(e: KeyInput, menuOpen: boolean): ComposerKey {
    if (e.isComposing || e.keyCode === 229) return 'none';
    const modified = e.metaKey || e.ctrlKey || e.altKey;
    if (menuOpen && !modified) {
        if (e.key === 'ArrowDown') return 'next';
        if (e.key === 'ArrowUp') return 'previous';
        if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) return 'pick';
        if (e.key === 'Escape') return 'close';
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return 'send';
    return 'none';
}

/** Something a request can be about, offered after `@`: a `.dt` element, state or command, or a storming's note. */
export interface MentionCandidate {
    readonly key: string;
    readonly target: TargetDraft;
    /** Its name in the display mode (as the chips show it). */
    readonly name: string;
    /** The name a mention writes: the label in ラベル and 両方, else the name. */
    readonly mention: string;
    /** The model ID or `Storming/Local`, to tell same names apart. */
    readonly qualified: string;
    /** `.dt`: the element's kind (or `state`, `command`); `.dtes`: the note's kind. */
    readonly kind: { readonly language: 'dt' | 'dtes'; readonly kind: string };
    /** The context, or the storming, it is in (in the display mode). */
    readonly where: string;
    /** What a query is matched with: the label, the name and the qualified name. */
    readonly search: readonly string[];
}

/** The kinds of storming declarations that are not notes. */
const NOT_NOTES = new Set(['timeline', 'group']);

/**
 * Everything `@` offers: the model's elements with their states and commands, and the stormings' notes (not their
 * timelines or groups; an occurrence is added from a timeline's view with the selection's `+`).
 */
export function mentionCandidates(
    ctx: NamingContext & { readonly stormings: readonly StormingView[]; readonly sources: readonly { readonly path: string; readonly text: string }[] },
): MentionCandidate[] {
    const out: MentionCandidate[] = [];
    const { mode, model } = ctx;
    const labelFirst = mode === 'name' ? 'name' : 'label';
    const selection = { model, stormings: ctx.stormings, sources: ctx.sources };
    const add = (selected: string, language: 'dt' | 'dtes', kind: string, where: string, short: string, label: string | undefined): void => {
        const target = targetOfSelection({ ...selection, selected });
        if (!target) return;
        const qualified = language === 'dt' ? selected : selected.slice('es/'.length);
        out.push({
            key: targetKey(target.target),
            target,
            name: targetName(target.target, ctx) ?? qualified,
            mention: nameIn(labelFirst, short, label),
            qualified,
            kind: { language, kind },
            where,
            search: [label ?? '', short, qualified].filter(Boolean),
        });
    };
    if (model) {
        const contextName = (c: string): string => nameIn(mode, c, model.contextLabels[c]);
        for (const el of Object.values(model.elements)) {
            add(el.id, 'dt', el.kind, contextName(el.context), el.name, el.label);
            for (const s of el.states ?? [])
                add(s.id, 'dt', 'state', contextName(el.context), `${el.name}.${s.name}`, s.label && `${el.label ?? el.name}.${s.label}`);
            for (const c of el.commands ?? [])
                add(c.id, 'dt', 'command', contextName(el.context), `${el.name}.${c.name}`, c.label && `${el.label ?? el.name}.${c.label}`);
        }
    }
    for (const view of ctx.stormings) {
        const byId = firstDeclarations(view.storming);
        const where = nameIn(mode, view.id, view.storming.label);
        for (const d of declarations(view.storming)) {
            if (NOT_NOTES.has(d.kind) || byId.get(d.id) !== d) continue;
            add(`es/${view.id}/${d.id}`, 'dtes', d.kind, where, d.id, d.label);
        }
    }
    return out;
}

/** How well a field matches a query (lower is better): starts with it, contains it, has its letters in order. */
function score(field: string, q: string): number | undefined {
    const f = field.toLowerCase();
    if (f.startsWith(q)) return 0;
    if (f.includes(q)) return 1;
    let i = 0;
    for (const ch of f) if (ch === q[i]) i++;
    return i === q.length ? 2 : undefined;
}

/** The candidates for a query, best first: fuzzy over the label, the name and the qualified name. */
export function matchCandidates(candidates: readonly MentionCandidate[], query: string, limit = 30): MentionCandidate[] {
    const q = query.trim().toLowerCase();
    if (!q) return candidates.slice(0, limit);
    const scored = candidates.flatMap((c) => {
        const best = Math.min(...c.search.map((f) => score(f, q) ?? Infinity));
        return best === Infinity ? [] : [{ c, best }];
    });
    scored.sort((a, b) => a.best - b.best || a.c.name.length - b.c.name.length || a.c.name.localeCompare(b.c.name));
    return scored.slice(0, limit).map(({ c }) => c);
}
