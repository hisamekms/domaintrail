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
// text and links, never as HTML.
import { declarations } from '@domaintrail/modeling';
import { firstDeclarations } from '@domaintrail/visualization';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { MAX_REQUEST_MENTIONS, MAX_REQUEST_TARGETS, plainBody, renumberTokens, tokenName, tokensIn } from '@domaintrail/collaboration';
import { nameIn } from '../model-utils';
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

/**
 * A body as one reads it on one line: each element as `#name`, each person as `@name`, without their numbers. Only
 * the targets the request has are elements; people are read whatever their number (a run's frozen request does not
 * keep whom it mentioned).
 */
export const bodyText = (text: string, targets: number, people = MAX_REQUEST_MENTIONS): string => plainBody(text, { targets, people });

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

/** Writes `token` over the query from `start` to `end`, the caret after it. */
function write(value: ComposerValue, at: { readonly start: number; readonly end: number }, token: string): { readonly text: string; readonly caret: number } {
    return { text: value.text.slice(0, at.start) + token + value.text.slice(at.end), caret: at.start + token.length };
}

/**
 * Picks a candidate for the `#query` from `start` to `end`: writes `#name[n] ` there and makes the target chip n (the
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
    const { text, caret } = write(value, at, `#${mentionName(name)}[${index + 1}] `);
    return { value: { ...value, text, chips }, caret };
}

/**
 * Picks a person for the `@query` from `start` to `end`: writes `@name[pN] ` there, N their number among the people
 * mentioned (the one they have, or the next). Undefined when one more would pass the limit.
 */
export function insertPerson(
    value: ComposerValue,
    at: { readonly start: number; readonly end: number },
    person: string,
    name: string,
): { readonly value: ComposerValue; readonly caret: number } | undefined {
    let index = value.people.indexOf(person);
    let people = value.people;
    if (index < 0) {
        if (people.length >= MAX_REQUEST_MENTIONS) return undefined;
        index = people.length;
        people = [...people, person];
    }
    const { text, caret } = write(value, at, `@${mentionName(name)}[p${index + 1}] `);
    return { value: { ...value, text, people }, caret };
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

/** Something a request can be about, offered after `#`: a `.dt` element, state or command, or a storming's note. */
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
 * Everything `#` offers: the model's elements with their states and commands, and the stormings' notes (not their
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

/** Someone a message can mention, offered after `@`: a participant of the session but me. */
export interface PersonCandidate {
    readonly id: string;
    readonly name: string;
    readonly role: 'facilitator' | 'participant';
    readonly online: boolean;
    readonly avatarUrl?: string;
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
