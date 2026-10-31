// The others' presence as the page holds it (ADR 0026, Presence): ephemeral, one entry per page of a participant
// (`connection`), replaced by each update and dropped when the page leaves. Cursors are drawn only for a page whose
// location equals this page's; the others are listed as on another view. Presence never starts anything.
import type { Cursor, Presence, SessionServerMessage, ViewLocation } from '@domaintrail/collaboration/protocol';
import { hasCanvas, sameLocation } from './location';

/** The others' pages by connection. */
export type Peers = ReadonlyMap<string, Presence>;

export const NO_PEERS: Peers = new Map();

/** The peers after a presence message; any other message leaves them as they are. */
export function receivePresence(peers: Peers, message: SessionServerMessage): Peers {
    switch (message.type) {
        case 'presence.snapshot':
            return new Map(message.peers.map((p) => [p.connection, p]));
        case 'presence.update':
            return new Map(peers).set(message.presence.connection, message.presence);
        case 'presence.leave': {
            if (!peers.has(message.connection)) return peers;
            const next = new Map(peers);
            next.delete(message.connection);
            return next;
        }
        default:
            return peers;
    }
}

/** A cursor to draw: whose, where, in which color. */
export interface PeerCursor {
    readonly connection: string;
    readonly name: string;
    readonly color: string;
    readonly at: Cursor;
}

/** The cursors of the pages on the same view as `mine` (none when this page shows no canvas). */
export function cursorsOn(peers: Peers, mine: ViewLocation | undefined): PeerCursor[] {
    if (!mine || !hasCanvas(mine)) return [];
    return [...peers.values()].flatMap((p) =>
        p.cursor && sameLocation(p.location, mine)
            ? [{ connection: p.connection, name: p.participant.name, color: participantColor(p.participant.id), at: p.cursor }]
            : [],
    );
}

/** Where a participant is, seen from this page. */
export type Whereabouts = 'here' | 'same-view' | 'another-view' | 'away';

/** Each participant's whereabouts: on this view when one of their pages is, else on another view while connected. */
export function whereabouts(peers: Peers, mine: ViewLocation | undefined): Map<string, Exclude<Whereabouts, 'here' | 'away'>> {
    const out = new Map<string, Exclude<Whereabouts, 'here' | 'away'>>();
    for (const p of peers.values()) {
        const same = sameLocation(p.location, mine);
        if (same) out.set(p.participant.id, 'same-view');
        else if (!out.has(p.participant.id)) out.set(p.participant.id, 'another-view');
    }
    return out;
}

/** A stable color per participant (a hue from the hash of the ID). */
export function participantColor(id: string): string {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 70% 45%)`;
}

/** Up to two initials of a name (when there is no avatar). */
export function initials(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    const chars = words.length > 1 ? [words[0][0], words[words.length - 1][0]] : Array.from(words[0]).slice(0, 2);
    return chars.join('').toUpperCase();
}

/** Calls `send` at most once per `interval` ms, always with the latest value (the last one is never lost). */
export function throttle<T>(interval: number, send: (value: T) => void, now: () => number = Date.now): { push(value: T): void; cancel(): void } {
    let last = -Infinity;
    let pending: { value: T } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => {
        timer = undefined;
        if (!pending) return;
        const { value } = pending;
        pending = undefined;
        last = now();
        send(value);
    };
    return {
        push(value) {
            pending = { value };
            if (timer !== undefined) return;
            const wait = last + interval - now();
            if (wait <= 0) flush();
            else timer = setTimeout(flush, wait);
        },
        cancel() {
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
            pending = undefined;
        },
    };
}
