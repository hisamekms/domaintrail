// How a reply shows in the stream, alike for people and the AI: one right under what it replies to (nothing in
// between) stays at its level and hangs on a thin line in the avatar column from that row's avatar down to its own,
// with no line quoting it; the replies that follow it, each to the same row or to a reply already hanging there, hang
// on the same line. A reply with something in between quotes what it replies to on its first line (「↩ 名前: …」, a
// click goes there). Solo puts the AI's card and its answer (or its run card) right under the message, so they hang on
// it; Collab keeps the stream by time, so only the replies that happen to come right after hang.

import type { ChatEntry, StreamItem } from './stream';

/** A row of the stream, as far as replies go: what it shows (`message:<id>`, `card:<key>`, `ai:<id>`) and what it replies to. */
export interface ThreadLine {
    readonly key: string;
    /** The key of the row it replies to (a message's, or the card of a run); none for a row that replies to nothing. */
    readonly to: string | undefined;
}

/** How a row stands among the replies. */
export interface ReplyLook {
    /** It hangs on the line of this row (the one replied to first), right under it or under the replies already on it. */
    readonly hangsOn: string | undefined;
    /** Replies hang on its line: the line starts under its avatar. */
    readonly head: boolean;
    /** It hangs, and another reply hangs on the same line below it: the line goes on past it. */
    readonly more: boolean;
    /** It replies to a row not right above (nor on the line right above): the line quoting it. */
    readonly quote: boolean;
}

/** How each row stands among the replies, in the stream's order. */
export function replyLooks(lines: readonly ThreadLine[]): ReplyLook[] {
    const hangs: (string | undefined)[] = [];
    // the rows on each line: its head and the replies hanging on it
    const members = new Map<string, Set<string>>();
    lines.forEach((line, i) => {
        const prev = i > 0 ? lines[i - 1] : undefined;
        const above = i > 0 ? hangs[i - 1] : undefined;
        let on: string | undefined;
        if (line.to !== undefined && prev) {
            // right under what it replies to: on its line, or on the line it hangs on itself (one line, never nested)
            if (prev.key === line.to) on = above ?? prev.key;
            // right under the line it replies on: to its head or to a reply already on it
            else if (above !== undefined && members.get(above)?.has(line.to)) on = above;
        }
        hangs.push(on);
        if (on === undefined) return;
        const set = members.get(on) ?? new Set([on]);
        set.add(line.key);
        members.set(on, set);
    });
    return lines.map((line, i) => {
        const on = hangs[i];
        return {
            hangsOn: on,
            head: on === undefined && hangs[i + 1] === line.key,
            more: on !== undefined && hangs[i + 1] === on,
            quote: line.to !== undefined && on === undefined,
        };
    });
}

/**
 * The stream's rows as `replyLooks` reads them: a message replies to its message, or to the card of its run; the AI's
 * card under a message in Solo (`slot`), and the answer or the run card in its place, reply to that message.
 */
export function threadLines(entries: readonly ChatEntry[]): ThreadLine[] {
    const cardOf = new Map<string, string>();
    const items = entries.flatMap((e): StreamItem[] => (e.kind === 'item' ? [e.item] : e.content.kind === 'item' ? [e.content.item] : []));
    for (const i of items) if (i.kind === 'card') for (const { run } of i.unit.runs) cardOf.set(run.id, i.key);
    const toOf = (item: StreamItem): string | undefined => {
        if (item.kind !== 'message') return undefined;
        const to = item.request.replyTo;
        if (to?.kind === 'Message') return `message:${to.request}`;
        return to?.kind === 'Run' ? cardOf.get(to.run) : undefined;
    };
    return entries.map((e): ThreadLine => {
        if (e.kind === 'item') return { key: e.item.key, to: toOf(e.item) };
        const key = e.content.kind === 'item' ? e.content.item.key : `ai:${e.request}`;
        return { key, to: `message:${e.request}` };
    });
}
