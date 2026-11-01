/** Selection history: a stack of selection IDs, the current one on top. */
export type History = string[];

/** Pushes a selection, unless it is already the current one. */
export const pushHistory = (h: History, id: string): History => (h[h.length - 1] === id ? h : [...h, id]);

/** Index of the entry "back" returns to: the nearest one below the top that still exists, or -1. */
export function backIndex(h: History, exists: (id: string) => boolean): number {
    for (let i = h.length - 2; i >= 0; i--) if (exists(h[i])) return i;
    return -1;
}

/** Goes back: drops the current entry, and any entries in between that no longer exist. */
export function popHistory(h: History, exists: (id: string) => boolean): History {
    const i = backIndex(h, exists);
    return i < 0 ? h : h.slice(0, i + 1);
}
