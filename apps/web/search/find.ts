// 探す (docs/live-view.md, "App bar"): one field for both worlds. What can be found — the stickies of every storming
// and the domain model's contexts, elements, commands and states — is given by each feature as `Findable`s; here,
// without React, how a query finds them (on the label and the name only: the place narrows only with another word,
// the kind never), in what order, and how the palette lists them: the actions on the selection, the world shown
// first, each world's results by eight with ほか n 件, a sticky and the model element its `ref` names side by side.
import type { DisplayMode } from '@domaintrail/visualization';
import type { World } from '../view/worlds';

/** Something 探す finds and goes to: a sticky, or an item of the domain model. */
export interface Findable {
    /** Its selection ID (`es/<Storming>/<Local>`, or the model's ID). */
    readonly key: string;
    readonly world: World;
    /** Its kind, for its mark (a sticky's: `event`, …; the model's: `aggregate`, `command`, `context`, …). */
    readonly kind: string;
    /** Its name (a sticky's local ID; the model's qualified name, `Sales.Order.confirm`). */
    readonly name: string;
    readonly label?: string | undefined;
    /** Its kind's name, as the row says it. */
    readonly kindName: string;
    /** Where it is (a storming's name; a context's, `販売 › 注文` for a command or a state). */
    readonly place?: string | undefined;
    /** A sticky's: the model item its `ref` names, when the model has it (its selection ID). */
    readonly ref?: string | undefined;
    /** A resolved hotspot (its mark is quieter). */
    readonly resolved?: boolean;
    /** Goes there. */
    readonly run: () => void;
}

/** A part of a text, to mark: from `start` to before `end`. */
export interface TextRange {
    readonly start: number;
    readonly end: number;
}

/** A findable the query found: how well (`rank`, lower first), and which words it found on its text and its name. */
export interface Hit {
    readonly item: Findable;
    /** 0 the text is the query, 1 it starts with it, 2 it holds it, 3 only its name does. */
    readonly rank: 0 | 1 | 2 | 3;
    /** The words found in its text (what the row shows first). */
    readonly onText: readonly string[];
    /** The words found in its name only (the row then shows its name, at the right). */
    readonly onName: readonly string[];
}

const norm = (s: string): string => s.normalize('NFKC').toLowerCase();

/** The words of a query: case and the width of the letters ignored (NFKC). */
export const queryWords = (query: string): string[] => norm(query).split(/\s+/).filter(Boolean);

/**
 * What a row shows first and what it shows as its name, by the display mode (`nameIn`): the label then the name; in
 * 名前, the name then the label (the roles swap). Without a label, the name is both.
 */
export function shownText(item: Pick<Findable, 'name' | 'label'>, mode: DisplayMode): { text: string; name: string } {
    const label = item.label?.trim() ? item.label : undefined;
    if (mode === 'name') return { text: item.name, name: label ?? item.name };
    return { text: label ?? item.name, name: item.name };
}

/**
 * Whether `item` is found by `words`, and how: every word is in its text, its name or its place, and at least one is
 * in its text or its name (the place only narrows). Its kind is never looked at.
 */
export function matchFindable(item: Findable, words: readonly string[], mode: DisplayMode): Hit | undefined {
    if (words.length === 0) return undefined;
    const shown = shownText(item, mode);
    const text = norm(shown.text);
    const name = norm(shown.name);
    const place = norm(item.place ?? '');
    if (!words.every((w) => text.includes(w) || name.includes(w) || place.includes(w))) return undefined;
    const onText = words.filter((w) => text.includes(w));
    const onName = words.filter((w) => !text.includes(w) && name.includes(w));
    if (onText.length === 0 && onName.length === 0) return undefined;
    const rank = onText.length === 0 ? 3 : text === words.join('') ? 0 : text.startsWith(words[0] ?? '') ? 1 : 2;
    return { item, rank, onText, onName };
}

/** The findables of one world that `words` find: the text equal, then starting with, then holding them, then the name only; else as written. */
export function findIn(items: readonly Findable[], words: readonly string[], mode: DisplayMode): Hit[] {
    return items
        .map((item, order) => ({ hit: matchFindable(item, words, mode), order }))
        .filter((x): x is { hit: Hit; order: number } => x.hit !== undefined)
        .sort((a, b) => a.hit.rank - b.hit.rank || a.order - b.order)
        .map((x) => x.hit);
}

/** Where the words are in `text` (its letters as written; nothing when NFKC changes its length), in order, not overlapping. */
export function markRanges(text: string, words: readonly string[]): TextRange[] {
    const n = norm(text);
    if (n.length !== text.length) return [];
    const ranges = words.flatMap((w) => {
        const start = n.indexOf(w);
        return start < 0 ? [] : [{ start, end: start + w.length }];
    });
    ranges.sort((a, b) => a.start - b.start);
    const out: TextRange[] = [];
    for (const r of ranges) if (out.length === 0 || r.start >= (out.at(-1)?.end ?? 0)) out.push(r);
    return out;
}

/** An action on the selection (a sticky's), as the palette lists it: found by its name only. */
export interface FoundAction {
    readonly id: string;
    readonly label: string;
}

/** The actions whose name holds every word (all of them when nothing is typed). */
export const matchActions = <A extends FoundAction>(actions: readonly A[], words: readonly string[]): A[] =>
    actions.filter((a) => words.every((w) => norm(a.label).includes(w)));

/** How many results of a world are listed before ほか n 件. */
export const PER_SECTION = 8;

/** How many items 最近 lists. */
export const RECENT = 5;

/** A row of a result: the findable, the words to mark in its text, and its name when it was found by it. */
export interface ResultRow {
    readonly item: Findable;
    readonly textMarks: readonly string[];
    /** The words found in its name only: the row shows its name with them marked. */
    readonly nameMarks: readonly string[];
    /** The other world's item it is joined to by `ref`, hung under it. */
    readonly mates: readonly ResultRow[];
}

/** A section of the palette's list. */
export type ResultSection<A extends FoundAction = FoundAction> =
    | { readonly kind: 'actions'; readonly actions: readonly A[] }
    | { readonly kind: 'recent'; readonly rows: readonly ResultRow[] }
    | {
          readonly kind: 'world';
          readonly world: World;
          /** How many it found (after the ones joined to the section above are left out). */
          readonly count: number;
          readonly rows: readonly ResultRow[];
          /** How many more there are, listed on ほか n 件. */
          readonly more: number;
      };

const plainRow = (item: Findable): ResultRow => ({ item, textMarks: [], nameMarks: [], mates: [] });

const rowOf = (hit: Hit, mates: readonly ResultRow[] = []): ResultRow => ({ item: hit.item, textMarks: hit.onText, nameMarks: hit.onName, mates });

/**
 * The palette's list for `query`. Nothing typed: the actions on the selection, then 最近 (the selections, newest
 * first, of both worlds). Typed: the actions whose name holds it, then each world's results, the world shown first;
 * a result of the first world hangs the other world's item it is joined to by `ref` (a sticky's `ref`; for an item of
 * the model, the stickies whose `ref` name it), which the second world's section leaves out. Each world lists eight,
 * unless `expanded` holds it.
 */
export function searchSections<A extends FoundAction>(input: {
    readonly query: string;
    readonly findables: readonly Findable[];
    readonly actions: readonly A[];
    /** The world shown: its results first. */
    readonly world: World;
    readonly mode: DisplayMode;
    /** The selections, oldest first (the navigation's history). */
    readonly history: readonly string[];
    /** The worlds whose ほか n 件 was picked (`World`s). */
    readonly expanded: ReadonlySet<string>;
}): ResultSection<A>[] {
    const { findables, world, mode } = input;
    const words = queryWords(input.query);
    const out: ResultSection<A>[] = [];
    const actions = matchActions(input.actions, words);
    if (actions.length) out.push({ kind: 'actions', actions });
    const byKey = new Map(findables.map((f) => [f.key, f]));
    if (words.length === 0) {
        const recent = [...new Set([...input.history].reverse())].flatMap((k) => byKey.get(k) ?? []).slice(0, RECENT);
        if (recent.length) out.push({ kind: 'recent', rows: recent.map(plainRow) });
        return out;
    }
    const other: World = world === 'storming' ? 'model' : 'storming';
    /** The other world's items joined to `item` by `ref`. */
    const matesOf = (item: Findable): Findable[] =>
        item.world === 'storming'
            ? [item.ref !== undefined ? byKey.get(item.ref) : undefined].filter((f): f is Findable => f !== undefined)
            : findables.filter((f) => f.world === 'storming' && f.ref === item.key);
    const joined = new Set<string>();
    for (const w of [world, other]) {
        let hits = findIn(
            findables.filter((f) => f.world === w),
            words,
            mode,
        );
        if (w === other) hits = hits.filter((h) => !joined.has(h.item.key));
        if (hits.length === 0) continue;
        const shown = input.expanded.has(w) ? hits : hits.slice(0, PER_SECTION);
        const rows = shown.map((h) => {
            if (w === other) return rowOf(h);
            const mates = matesOf(h.item).map((m) => {
                joined.add(m.key);
                const found = matchFindable(m, words, mode);
                return found ? rowOf(found) : plainRow(m);
            });
            return rowOf(h, mates);
        });
        out.push({ kind: 'world', world: w, count: hits.length, rows, more: hits.length - shown.length });
    }
    return out;
}
