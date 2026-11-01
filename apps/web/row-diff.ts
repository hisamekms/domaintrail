/** A row of a list compared with the same list in the baseline model; a removed row is the baseline's. */
export interface DiffRow<T> {
    item: T;
    change?: RowChange;
    /** The baseline's version of a changed row. */
    before?: T;
}

export type RowChange = 'added' | 'changed' | 'removed';

/** Equal but for where they are written. */
export const sameContent = (a: unknown, b: unknown): boolean => contentOf(a) === contentOf(b);
const contentOf = (x: unknown): string => JSON.stringify(x, (k, v: unknown) => (k === 'location' ? undefined : v));

/**
 * `items` marked against `base` (matched by `key`): added and changed rows, and the baseline's removed rows where
 * they were (after the row that preceded them). Without a baseline (an added element, no baseline at all) nothing is
 * marked.
 */
export function diffRows<T>(items: readonly T[], base: readonly T[] | undefined, key: (item: T) => string): DiffRow<T>[] {
    if (!base) return items.map((item) => ({ item }));
    const present = new Set(items.map(key));
    const before = new Map(base.map((b) => [key(b), b]));
    const removedAfter = new Map<string | undefined, DiffRow<T>[]>();
    let previous: string | undefined;
    for (const b of base) {
        const k = key(b);
        if (present.has(k)) previous = k;
        else removedAfter.set(previous, [...(removedAfter.get(previous) ?? []), { item: b, change: 'removed' }]);
    }
    const out: DiffRow<T>[] = [...(removedAfter.get(undefined) ?? [])];
    for (const item of items) {
        const k = key(item);
        const old = before.get(k);
        out.push(old === undefined ? { item, change: 'added' } : sameContent(old, item) ? { item } : { item, change: 'changed', before: old });
        out.push(...(removedAfter.get(k) ?? []));
    }
    return out;
}

/** Class of a row by its change (`row-added`…), or nothing. */
export const rowClass = (change: RowChange | undefined, other = ''): string | undefined =>
    [other, change && `row-${change}`].filter(Boolean).join(' ') || undefined;
