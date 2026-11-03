// The request composer's targets and mentions (ADR 0026, appendix "Requests with several targets", and amendment
// "mentions of people"), without React.
//
// A request has 0 to 20 targets: the composer's chips, the single source of truth (no chip: the whole workspace). The
// body mentions a target as `#name[n]`, n its number among the request's targets (from 1): picking a candidate after
// `#` adds a chip and writes the mention; deleting every mention of a chip that came from a mention removes the chip;
// removing a chip turns its mentions into plain text; the numbers follow the chips. A body written before `#` named
// elements has `@name[n]`: still read as a target. The body mentions a person as `@name[pN]`, the N-th of the people
// it mentions (`people`, sent as `mentions`): picking one after `@` adds them, deleting their mentions removes them.
// The body stays plain text: the stream reads the tokens back with `parseBody` (`domain/body.ts`) and renders them as
// text and links, never as HTML. The composer's editor shows the tokens as chips (`composer-text.ts`).
import { commandsOf, contextOf, statesOf } from '@domaintrail/modeling';
import { declarations, firstDeclarations } from '@domaintrail/storming';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { MAX_REQUEST_MENTIONS, MAX_REQUEST_TARGETS, parseBody, renumberTokens, tokenName, tokensIn } from '@domaintrail/collaboration';
import { labelOrName, nameIn, shownLabel } from '../model-utils';
import { targetKey, targetName, targetOfSelection, type NamingContext, type TargetDraft } from './targets';

export { MAX_REQUEST_MENTIONS, MAX_REQUEST_TARGETS };
export { type BodySegment, parseBody } from '@domaintrail/collaboration';

/** A target of the request being written: `mentioned` once the body mentioned it (then deleting its mentions removes it). */
export interface ComposerChip {
    readonly target: TargetDraft;
    readonly mentioned: boolean;
}

/** The request being written: its text, its targets, and the people it mentions (participant IDs, `@name[pN]` the N-th). */
export interface ComposerValue {
    readonly text: string;
    readonly chips: readonly ComposerChip[];
    readonly people: readonly string[];
}

export const EMPTY_COMPOSER: ComposerValue = { text: '', chips: [], people: [] };

/** A request's target as a body's token reads it: only what tells a state or a command from an element. */
export interface TokenTarget {
    readonly target: { readonly kind: string; readonly element?: string };
}

/**
 * A token's name for its target on one line: the target's own name, as the chips show it — a state or a command
 * (`Agg#State`, `Agg:cmd`), written with its aggregate (`請求書.支払済み`), without it; anything else as written.
 */
export function ownTokenName(name: string, target: TokenTarget | undefined): string {
    const member = target?.target.kind === 'DtElement' && /[#:]/.test(target.target.element ?? '');
    const dot = name.indexOf('.');
    return member && dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : name;
}

/**
 * A body as one reads it on one line: each element as `#name` (its own name, `ownTokenName`), each person as `@name`,
 * without their numbers (`bare`: the names alone). Only the targets the request has are elements; people are read
 * whatever their number (a run's frozen request does not keep whom it mentioned).
 */
export function bodyText(text: string, targets: readonly TokenTarget[], people = MAX_REQUEST_MENTIONS, bare = false): string {
    return parseBody(text, { targets: targets.length, people })
        .map((seg) => {
            if (seg.kind === 'text') return seg.text;
            const name = seg.kind === 'element' ? ownTokenName(seg.name, targets[seg.index]) : seg.name;
            return bare ? name : `${seg.kind === 'element' ? '#' : '@'}${name}`;
        })
        .join('');
}

/** The numbers (0-based) of the targets, and of the people, a text mentions. */
function mentionedIn(text: string): { readonly targets: Set<number>; readonly people: Set<number> } {
    const targets = new Set<number>();
    const people = new Set<number>();
    for (const t of tokensIn(text)) (t.kind === 'element' ? targets : people).add(t.index);
    return { targets, people };
}

/** A name as a mention writes it: no spaces, brackets, `#` or `@`, at most 80 characters. */
export const mentionName = tokenName;

/** What the caret is in: `#query` (an element) or `@query` (a person), from its sign to the caret. */
export interface MentionQuery {
    readonly sign: '#' | '@';
    readonly start: number;
    readonly query: string;
}

/** The `#query` or `@query` the caret is in, if any: what the candidates are matched with. */
export function mentionQuery(text: string, caret: number): MentionQuery | undefined {
    const before = text.slice(0, caret);
    const at = Math.max(...['#', '＃', '@', '＠'].map((c) => before.lastIndexOf(c)));
    if (at < 0) return undefined;
    const query = before.slice(at + 1);
    if (query.length > 40 || /[\s#＃@＠[\]]/u.test(query)) return undefined;
    // not inside a word such as an e-mail address or a URL's fragment
    if (at > 0 && /[A-Za-z0-9._%+\-/]/.test(before[at - 1])) return undefined;
    return { sign: before[at] === '#' || before[at] === '＃' ? '#' : '@', start: at, query };
}

/** Removes the chip at `index`: its mentions become plain text and the mentions after it are numbered down. */
export function removeChip(value: ComposerValue, index: number): ComposerValue {
    return {
        ...value,
        text: renumberTokens(value.text, 'element', (n) => (n === index ? undefined : n > index ? n - 1 : n)),
        chips: value.chips.filter((_, i) => i !== index),
    };
}

/** Removes the chips at `indexes` (as `removeChip`, all at once). */
function removeChips(value: ComposerValue, indexes: ReadonlySet<number>): ComposerValue {
    if (indexes.size === 0) return value;
    const kept = value.chips.map((_, i) => i).filter((i) => !indexes.has(i));
    const to = new Map(kept.map((old, i) => [old, i]));
    return { ...value, text: renumberTokens(value.text, 'element', (n) => to.get(n)), chips: kept.map((i) => value.chips[i]) };
}

/** Forgets the people at `indexes` (their mentions are gone already); the mentions after them are numbered down. */
function removePeople(value: ComposerValue, indexes: ReadonlySet<number>): ComposerValue {
    if (indexes.size === 0) return value;
    const kept = value.people.map((_, i) => i).filter((i) => !indexes.has(i));
    const to = new Map(kept.map((old, i) => [old, i]));
    return { ...value, text: renumberTokens(value.text, 'person', (n) => to.get(n)), people: kept.map((i) => value.people[i]) };
}

/**
 * The text edited: a chip that came from a mention goes once no mention of it is left (as if removed with ×, but its
 * mentions are gone already); chips added otherwise stay. A person goes once no mention of them is left.
 */
export function editText(value: ComposerValue, text: string): ComposerValue {
    const mentioned = mentionedIn(text);
    const gone = new Set(value.chips.flatMap((c, i) => (c.mentioned && !mentioned.targets.has(i) ? [i] : [])));
    const away = new Set(value.people.flatMap((_, i) => (mentioned.people.has(i) ? [] : [i])));
    return removePeople(removeChips({ ...value, text }, gone), away);
}

/** The index of a target among the chips, if it is one. */
const indexOf = (chips: readonly ComposerChip[], target: TargetDraft): number => {
    const key = targetKey(target.target);
    return chips.findIndex((c) => targetKey(c.target.target) === key);
};

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

/** Something a request can be about, offered after `#`: a `.dt` element, state or command, a storming or its note. */
export interface MentionCandidate {
    readonly key: string;
    readonly target: TargetDraft;
    /** Its name in the display mode (as the chips show it). */
    readonly name: string;
    /** The name a mention writes: the label in ラベル and 両方, else the name. */
    readonly mention: string;
    /** The model ID, `Storming/Local` or the storming's ID, to tell same names apart. */
    readonly qualified: string;
    /** `.dt`: the element's kind (or `state`, `command`); `.dtes`: the note's kind, or `storming` for a whole storming. */
    readonly kind: { readonly language: 'dt' | 'dtes'; readonly kind: string };
    /** The context, or the storming, it is in (in the display mode); empty for a whole storming. */
    readonly where: string;
    /** What a query is matched with: the label, the name and the qualified name. */
    readonly search: readonly string[];
}

/** The kinds of storming declarations that are not notes. */
const NOT_NOTES = new Set(['timeline', 'group']);

/**
 * Everything `#` offers: the model's elements with their states and commands, and each storming as a whole then its
 * notes (not its timelines or groups; an occurrence is added from a timeline's view with the selection's `+`).
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
            search: [shownLabel(label) ?? '', short, qualified].filter(Boolean),
        });
    };
    if (model) {
        const contextName = (c: string): string => nameIn(mode, c, contextOf(model, c)?.label);
        for (const el of model.elements) {
            add(el.id, 'dt', el.kind, contextName(el.context), el.name, el.label);
            for (const s of statesOf(el))
                add(s.id, 'dt', 'state', contextName(el.context), `${el.name}.${s.name}`, shownLabel(s.label) && `${labelOrName(el)}.${s.label}`);
            for (const c of commandsOf(el))
                add(c.id, 'dt', 'command', contextName(el.context), `${el.name}.${c.name}`, shownLabel(c.label) && `${labelOrName(el)}.${c.label}`);
        }
    }
    for (const view of ctx.stormings) {
        const byId = firstDeclarations(view.storming);
        const where = nameIn(mode, view.id, view.storming.label);
        const target: TargetDraft = { target: { kind: 'DtesStorming', storming: view.id }, label: where };
        out.push({
            key: targetKey(target.target),
            target,
            name: where,
            mention: nameIn(labelFirst, view.id, view.storming.label),
            qualified: view.id,
            kind: { language: 'dtes', kind: 'storming' },
            where: '',
            search: [shownLabel(view.storming.label) ?? '', view.id].filter(Boolean),
        });
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

/** Someone a message can mention, offered after `@`: a participant of the session but me. */
export interface PersonCandidate {
    readonly id: string;
    readonly name: string;
    readonly role: 'facilitator' | 'participant';
    readonly online: boolean;
    readonly avatarUrl?: string;
    /** The AI (ADR 0030): offered first, drawn with its own mark. */
    readonly ai?: boolean;
}

/**
 * The people `@` offers, best first for a query: whose name starts with it, contains it, or has its letters in order;
 * among equals, those online before those away (the order they are given in). None (no one else is in the session, or
 * there is no session): `@` offers nothing.
 */
export function matchPeople(people: readonly PersonCandidate[], query: string, limit = 30): PersonCandidate[] {
    const q = query.trim().toLowerCase();
    if (!q) return people.slice(0, limit);
    const scored = people.flatMap((p, i) => {
        const best = score(p.name, q);
        return best === undefined ? [] : [{ p, best, i }];
    });
    scored.sort((a, b) => a.best - b.best || a.i - b.i);
    return scored.slice(0, limit).map(({ p }) => p);
}
