/** A name that could have been meant: `name` is what to write, `key` what the unresolved name is compared with. */
export interface Candidate {
    name: string;
    key?: string;
}

/** At most this many names are suggested. */
const MAX_SUGGESTIONS = 3;

/**
 * The candidates closest to `name`, best first: by edit distance (letter case ignored, a swap of two neighboring letters
 * counts once), within a third of the name's length (at least 1). When the key of some candidates matches exactly
 * (or in another letter case), e.g. a name of another context written without its qualifier, only those are suggested.
 */
export function closest(name: string, candidates: readonly (Candidate | string)[]): string[] {
    const query = name.toLowerCase();
    const limit = Math.max(1, Math.floor(name.length / 3));
    const scored = new Map<string, number>();
    for (const c of candidates) {
        const { name: label, key = label } = typeof c === 'string' ? { name: c } : c;
        if (label === name) continue;
        const d = key === name ? -1 : distance(query, key.toLowerCase());
        if (d > limit || d >= Math.max(name.length, key.length)) continue;
        const prev = scored.get(label);
        if (prev === undefined || d < prev) scored.set(label, d);
    }
    const best = Math.min(...scored.values());
    return [...scored]
        .filter(([, d]) => best > 0 || d <= 0)
        .sort(([a, x], [b, y]) => x - y || a.localeCompare(b))
        .slice(0, MAX_SUGGESTIONS)
        .map(([label]) => label);
}

/** `did you mean 'A'?` / `did you mean 'A' or 'B'?` for the closest candidates, if any is close enough. */
export function didYouMean(name: string, candidates: readonly (Candidate | string)[]): string | undefined {
    const names = closest(name, candidates).map((n) => `'${n}'`);
    if (!names.length) return undefined;
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
    return `did you mean ${list}?`;
}

/** The suggestion for `name` if there is one, else the few names there are (`use a state of 'Order': Draft, Confirmed`). */
export function suggestFrom(name: string, candidates: readonly string[], what: string): string | undefined {
    const hint = didYouMean(name, candidates);
    if (hint || !candidates.length || candidates.length > 10) return hint;
    return `use ${what}: ${[...new Set(candidates)].join(', ')}`;
}

/** Optimal string alignment distance: insertions, deletions, substitutions and swaps of neighboring letters. */
export function distance(a: string, b: string): number {
    const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) rows[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let d = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2][j - 2] + 1);
            rows[i][j] = d;
        }
    }
    return rows[a.length][b.length];
}
