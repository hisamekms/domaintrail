// The knowledge as the Live View shows it (ADR 0031, section 10), without React: a sticky's reference and its
// selection, the order of a list (newest first, or by kind), the conflicts among items, the marks on the canvas, the
// filters of the ナレッジ list, the message that asks the AI to make a conflict a hotspot, and the session's extraction
// switch.
import type { Knowledge } from '@domaintrail/knowledge';
import type { SendRequestBody } from '@domaintrail/collaboration/protocol';
import { mentionName } from '../session/mentions';

export type KnowledgeItem = Knowledge.LiveKnowledgeItem;
export type Kind = Knowledge.KnowledgeKind;
export type When = Knowledge.When;
export type Origin = Knowledge.Origin;

/** The kinds in the order the 種類の順 lists them (ADR 0031, section 2). */
export const KINDS: readonly Kind[] = ['rule', 'flow', 'example', 'term', 'pain', 'want', 'decision'];
/** The filters' values: `none` of `when` is no filter's (an item about neither is shown unfiltered). */
export const WHENS: readonly When[] = ['as_is', 'to_be'];
export const ORIGINS: readonly Origin[] = ['said', 'agreed', 'investigated', 'inferred'];

/** How a list is ordered: newest first (the default), or by kind and newest first within one. */
export type Order = 'newest' | 'kind';

/** The sticky of a selection `es/<Storming>/<Local>` as knowledge refers to it (`<Storming>.<Local>`); none for another selection. */
export function stickyOfSelection(selection: string | undefined): string | undefined {
    const m = /^es\/([_a-zA-Z][_a-zA-Z0-9]*)\/([_a-zA-Z][_a-zA-Z0-9]*)$/.exec(selection ?? '');
    return m ? `${m[1]}.${m[2]}` : undefined;
}

/** The selection (the canvas's element) of a sticky `<Storming>.<Local>`. */
export function selectionOfSticky(sticky: string): string {
    const dot = sticky.indexOf('.');
    return `es/${sticky.slice(0, dot)}/${sticky.slice(dot + 1)}`;
}

const newestFirst = (a: KnowledgeItem, b: KnowledgeItem): number => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** The items in the order asked for. */
export function ordered(items: readonly KnowledgeItem[], order: Order): KnowledgeItem[] {
    const byKind = (a: KnowledgeItem, b: KnowledgeItem): number => KINDS.indexOf(a.content.labels.kind) - KINDS.indexOf(b.content.labels.kind);
    return [...items].sort((a, b) => (order === 'kind' ? byKind(a, b) || newestFirst(a, b) : newestFirst(a, b)));
}

/** A conflict between two items, each once: the newer first. */
export interface ConflictPair {
    readonly a: KnowledgeItem;
    readonly b: KnowledgeItem;
}

/**
 * The conflicts of `items` whose other side is known (`lookup`: the items listed, and those fetched for their links),
 * each pair once, the newer item first.
 */
export function conflictPairs(items: readonly KnowledgeItem[], lookup: (id: string) => KnowledgeItem | undefined): ConflictPair[] {
    const seen = new Set<string>();
    const pairs: ConflictPair[] = [];
    for (const item of items)
        for (const id of item.conflictsWith) {
            const other = lookup(id);
            const key = [item.id, id].sort().join('|');
            if (!other || seen.has(key)) continue;
            seen.add(key);
            const [a, b] = newestFirst(item, other) <= 0 ? [item, other] : [other, item];
            pairs.push({ a, b });
        }
    return pairs;
}

/** The items of a list that are in none of its conflicts shown side by side: those are listed in their box only. */
export function outsideConflicts(items: readonly KnowledgeItem[], pairs: readonly ConflictPair[]): KnowledgeItem[] {
    const paired = new Set<string>(pairs.flatMap((p) => [p.a.id, p.b.id]));
    return items.filter((i) => !paired.has(i.id));
}

/** The IDs the items link to as conflicts but are not among them: fetched to show the pair. */
export const missingConflicts = (items: readonly KnowledgeItem[]): string[] => {
    const have = new Set<string>(items.map((i) => i.id));
    return [...new Set(items.flatMap((i) => i.conflictsWith.filter((id) => !have.has(id))))];
};

/** What a sticky shows on the canvas: a dot when it has items, a mark when one of them is in a conflict. */
export type StickyMark = 'dot' | 'conflict';

/** The marks of a storming's stickies, by their canvas element (`es/<Storming>/<Local>`). */
export function marksOf(counts: readonly { readonly sticky: string; readonly hasItems: boolean; readonly hasConflict: boolean }[]): Map<string, StickyMark> {
    return new Map(counts.filter((c) => c.hasItems).map((c) => [selectionOfSticky(c.sticky), c.hasConflict ? 'conflict' : 'dot'] as const));
}

/** The ナレッジ list's filters: each axis, the values chosen (none: every value). */
export interface Filters {
    readonly q: string;
    readonly when: readonly When[];
    readonly kind: readonly Kind[];
    readonly origin: readonly Origin[];
}

export const NO_FILTERS: Filters = { q: '', when: [], kind: [], origin: [] };

/** A value of an axis chosen or no longer chosen. */
export function toggled<K extends 'when' | 'kind' | 'origin'>(filters: Filters, axis: K, value: Filters[K][number]): Filters {
    const now = filters[axis] as readonly string[];
    const next = now.includes(value) ? now.filter((v) => v !== value) : [...now, value];
    return { ...filters, [axis]: next };
}

/** The query of `GET /api/session/knowledge` for the filters. */
export function queryOf(filters: Filters, cursor?: string): URLSearchParams {
    const params = new URLSearchParams();
    for (const w of filters.when) params.append('when', w);
    for (const k of filters.kind) params.append('kind', k);
    for (const o of filters.origin) params.append('origin', o);
    if (filters.q.trim() !== '') params.set('q', filters.q.trim());
    if (cursor !== undefined) params.set('cursor', cursor);
    return params;
}

/** The text of an item without its images' lines (shown apart), for the list's two lines. */
export const plainText = (text: string): string =>
    text
        .replace(/!\[[^\]]*\]\(image:img_[0-9a-z]+\)/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

/** The images an item's text refers to, in order. */
export const imagesOf = (text: string): string[] => [...new Set([...text.matchAll(/\(image:(img_[0-9a-z]+)\)/g)].map((m) => m[1] ?? ''))].filter(Boolean);

/**
 * ホットスポットにする: a message to the AI (mentioned, so that a Collab session addresses it) asking it to make the
 * conflict a hotspot in the storming, with the stickies both items are about as its targets (as 聞くことをメモ does,
 * `askBody`). The facilitator's goes to the runner; a participant's becomes a proposal the facilitator approves.
 */
export function hotspotBody(input: {
    readonly pair: ConflictPair;
    /** The stickies' labels as the canvas names them. */
    readonly label: (sticky: string) => string;
    readonly revision: string;
    readonly aiName: string;
    readonly text: (targets: string, a: string, b: string) => string;
}): SendRequestBody {
    const { pair, revision } = input;
    const stickies = [...new Set([...pair.a.content.about, ...pair.b.content.about])].slice(0, 20);
    const targets = stickies.map((s) => {
        const dot = s.indexOf('.');
        return {
            target: { kind: 'DtesElement' as const, storming: s.slice(0, dot), local: s.slice(dot + 1) },
            label: input.label(s),
            sourceRevision: revision,
        };
    });
    const mentions = targets.map((t, i) => `#${mentionName(t.label)}[${i + 1}]`).join(' ');
    const quote = (i: KnowledgeItem): string => plainText(i.content.text).replace(/\s+/g, ' ').slice(0, 300);
    return { targets, body: `@${mentionName(input.aiName)}[p1] ${input.text(mentions, quote(pair.a), quote(pair.b))}`, mentions: ['ai'] };
}

/** A conflict's key, whichever side comes first. */
export const pairKey = (a: string, b: string): string => [a, b].sort().join('|');

/** A press of ホットスポットにする still waiting for its run (ADR 0031, section 4): its message and the two items. */
export interface HandOver {
    readonly request: string;
    readonly items: readonly [string, string];
}

/** The conflicts being made hotspots, by `pairKey`. */
export const makingHotspots = (handOvers: readonly HandOver[]): ReadonlySet<string> => new Set(handOvers.map((h) => pairKey(h.items[0], h.items[1])));

/** Whether the session extracts its knowledge, from a message of dt's WebSocket (`knowledge.extraction`); none for another. */
export function extractionOfMessage(message: { readonly type: string }): boolean | undefined {
    if (message.type !== 'knowledge.extraction') return undefined;
    const enabled: unknown = Reflect.get(message, 'enabled');
    return typeof enabled === 'boolean' ? enabled : undefined;
}

/**
 * What a page shows of the session's extraction (ADR 0031, section 3): the facilitator a switch; the others a mark
 * while it is on (their talk is being turned into knowledge), nothing while it is off; nothing at all without a
 * knowledge store (`enabled` unknown) or once the page is out of the session.
 */
export type ExtractionControl = 'switch' | 'on' | 'none';

export function extractionControl(input: { readonly enabled: boolean | undefined; readonly facilitator: boolean; readonly live: boolean }): ExtractionControl {
    const { enabled, facilitator, live } = input;
    if (enabled === undefined || !live) return 'none';
    if (facilitator) return 'switch';
    return enabled ? 'on' : 'none';
}
