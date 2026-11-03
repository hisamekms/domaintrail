// How what arrives in the chat is revealed, without React: which long texts are clamped to a few lines with 続きを表示
// (only those already there when the page loaded, its history, everything before the viewer joined included; what
// arrives while the page is open is shown in full, and a text opened stays open), and where the stream scrolls when
// something arrives (at the bottom: down to it, but not past its head; scrolled up: not at all, a pill tells it).
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';

/**
 * The keys of the texts a session's state holds, as the stream names them (`message:<id>`, `proposal:<id>`, and
 * `run:<id>` for a run's reply): a run still queued or running has none yet, its reply is still to come.
 */
export function revealKeys(state: Pick<SessionStateBody, 'requests' | 'proposals' | 'runs'>): string[] {
    return [
        ...state.requests.map((r) => `message:${r.id}`),
        ...(state.proposals ?? []).map((p) => `proposal:${p.id}`),
        ...state.runs.filter((r) => r.state !== 'Queued' && r.state !== 'Running').map((r) => `run:${r.id}`),
    ];
}

/** Whether a text is clamped: it was there when the page loaded (`history`) and the reader did not open it. */
export const clamps = (key: string, history: ReadonlySet<string>, opened: ReadonlySet<string>): boolean => history.has(key) && !opened.has(key);

/** The page's record of what was there at load and what the reader opened, per session: it lasts until a reload. */
export interface RevealStore {
    /** The texts there when the page first had the session's state (`keys`: what it holds now; only the first call counts). */
    history(session: string, keys: () => readonly string[]): ReadonlySet<string>;
    /** The texts the reader opened (続きを表示): they stay open as the chat is shown again. */
    readonly opened: Set<string>;
}

export function createRevealStore(): RevealStore {
    const histories = new Map<string, ReadonlySet<string>>();
    return {
        history(session, keys) {
            let known = histories.get(session);
            if (!known) {
                known = new Set(keys());
                histories.set(session, known);
            }
            return known;
        },
        opened: new Set(),
    };
}

/** This page's record (a reload starts a new one: everything there then is history). */
export const PAGE_REVEAL: RevealStore = createRevealStore();

/** What the stream does when something arrives (a message, the AI's answer in place of its card). */
export type Arrival =
    /** The reader is at the bottom: the stream follows it down, as far as its head (`followTop`). */
    | 'follow'
    /** The reader scrolled up and its head is out of sight: the stream stays, a pill tells it (AI's answers). */
    | 'pill'
    /** The reader scrolled up and sees its head already: nothing to do. */
    | 'none';

export function arrival(atBottom: boolean, headInView: boolean): Arrival {
    if (atBottom) return 'follow';
    return headInView ? 'none' : 'pill';
}

/** The room kept above the head of what arrived when the stream stops at it. */
export const HEAD_MARGIN = 8;

/**
 * Where the stream scrolls while it follows what arrived: to the bottom (`max`: the furthest it scrolls), but no
 * further than its head (`head`: the scroll that puts it at the top, none: no head to keep), and never back up (`top`:
 * where it is).
 */
export function followTop(top: number, max: number, head: number | undefined): number {
    if (head === undefined) return max;
    return Math.max(top, Math.min(max, head));
}
