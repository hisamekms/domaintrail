// IDs and time come from here, never from the commands: a command is pure, so everything it would have to generate
// or read from the clock is a parameter, and the application passes it in.
export interface Providers {
    /** A new ID; `kind` (`order`, `event`, …) only makes the IDs of `fixedProviders` readable. */
    newId(kind: string): string;
    now(): Date;
}

export const systemProviders: Providers = { newId: () => crypto.randomUUID(), now: () => new Date() };

/** Readable, repeatable IDs (`order-1`, …) and a clock that advances one minute per call: for the demo and tests. */
export function fixedProviders(start = new Date('2026-10-24T09:00:00Z')): Providers {
    const counts = new Map<string, number>();
    let minutes = 0;
    return {
        newId: (kind) => {
            const n = (counts.get(kind) ?? 0) + 1;
            counts.set(kind, n);
            return `${kind}-${n}`;
        },
        now: () => new Date(start.getTime() + minutes++ * 60_000),
    };
}
