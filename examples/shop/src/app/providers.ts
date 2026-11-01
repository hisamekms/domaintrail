// IDs and time come from here, never from the commands: a command is pure, so everything it would have to generate
// or read from the clock is a parameter, and the application passes it in.
export interface Providers {
    /** A new ID, a UUID; `kind` (`order`, `event`, …) only numbers the IDs of `fixedProviders` apart. */
    newId(kind: string): string;
    now(): Date;
}

export const systemProviders: Providers = { newId: () => crypto.randomUUID(), now: () => new Date() };

/**
 * Repeatable UUIDs, numbered per kind (`00000002-0000-4000-8000-000000000003` is the third ID of the second kind asked
 * for), and a clock that advances one minute per call: for the demo and tests.
 */
export function fixedProviders(start = new Date('2026-10-24T09:00:00Z')): Providers {
    const counts = new Map<string, number>();
    const kinds: string[] = [];
    let minutes = 0;
    return {
        newId: (kind) => {
            if (!kinds.includes(kind)) kinds.push(kind);
            const n = (counts.get(kind) ?? 0) + 1;
            counts.set(kind, n);
            const k = kinds.indexOf(kind) + 1;
            return `${String(k).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
        },
        now: () => new Date(start.getTime() + minutes++ * 60_000),
    };
}
