// Mentions of people in the page: whom `@` offers, and the messages that mention me.
import { describe, expect, test } from 'bun:test';
import type { Me, Presence, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { arrivedBelow, mentionablePeople, mentionsMe, streamItems, unreadMentions, type StreamItem } from './stream';

describe('the page: whom `@` offers, and the messages that mention me', () => {
    const at = (minute: number): string => `2026-11-01T09:${String(minute).padStart(2, '0')}:00.000Z`;
    const state = (holder?: string) =>
        ({
            session: {
                facilitator: 'f',
                participants: [
                    { id: 'f', name: 'Fumi', role: 'Facilitator' },
                    { id: 'me', name: 'Me', role: 'Participant' },
                    { id: 'b', name: 'Bob', role: 'Participant' },
                    { id: 'a', name: 'Ann', role: 'Participant' },
                ],
            },
            ...(holder && { facilitatorHolder: holder }),
            requests: [],
            runs: [],
            revisions: [],
        }) as unknown as SessionStateBody;
    const me = { session: 's', participant: { id: 'me', name: 'Me', role: 'participant' } } as unknown as Me;
    const peers = new Map([['c1', { connection: 'c1', participant: { id: 'b', name: 'Bob' } } as unknown as Presence]]);
    const message = (id: string, author: string, mentions: string[], minute: number) =>
        ({ id, session: 's', author, targets: [], body: 'x', sentAt: at(minute), state: 'Sent', mentions }) as unknown as SessionStateBody['requests'][number];

    test('the AI first, then everyone but me, online first, then by name; the facilitator too; alone: the AI; Solo: no one', () => {
        expect(mentionablePeople(state(), peers, me).map((p) => [p.id, p.online, p.role])).toEqual([
            ['ai', true, 'participant'],
            ['b', true, 'participant'],
            ['a', false, 'participant'],
            ['f', false, 'facilitator'],
        ]);
        const alone = {
            ...state(),
            session: { facilitator: 'me', participants: [{ id: 'me', name: 'Me', role: 'Facilitator' }] },
        } as unknown as SessionStateBody;
        expect(mentionablePeople(alone, new Map(), me).map((p) => [p.id, p.name, p.ai])).toEqual([['ai', 'AI', true]]);
        // dt open: every message goes to the AI already
        expect(mentionablePeople({ ...alone, session: { ...alone.session, mode: 'Solo' } } as unknown as SessionStateBody, new Map(), me)).toEqual([]);
        // holding the facilitator's role, the facilitator's row is me
        expect(mentionablePeople(state('me'), peers, me).map((p) => p.id)).not.toContain('f');
    });

    test("a message mentions me when it names me (or the facilitator while I hold the role), never when it's mine", () => {
        expect(mentionsMe(message('1', 'b', ['me'], 0), state(), 'me')).toBe(true);
        expect(mentionsMe(message('2', 'b', ['a'], 0), state(), 'me')).toBe(false);
        expect(mentionsMe(message('3', 'me', ['me'], 0), state(), 'me')).toBe(false);
        expect(mentionsMe(message('4', 'b', ['f'], 0), state('me'), 'me')).toBe(true);
        expect(mentionsMe(message('4', 'b', ['f'], 0), state(), 'me')).toBe(false);
    });

    test('the unread mentions: the messages after the chat was last shown that mention me', () => {
        const s = {
            ...state(),
            requests: [message('1', 'b', ['me'], 1), message('2', 'a', ['b'], 2), message('3', 'a', ['me', 'b'], 3), message('4', 'me', ['me'], 4)],
        };
        const items = streamItems(s);
        expect(unreadMentions(items, undefined, s, 'me')).toBe(0);
        expect(unreadMentions(items, at(0), s, 'me')).toBe(2);
        expect(unreadMentions(items, at(1), s, 'me')).toBe(1);
        expect(unreadMentions(items, at(3), s, 'me')).toBe(0);
    });

    test('what arrived below while scrolled up: new messages and AI turns, not card updates nor mine; and how many are for me', () => {
        const s = {
            ...state(),
            requests: [message('1', 'b', [], 1), message('2', 'a', ['me'], 2), message('3', 'me', ['me'], 3), message('4', 'b', [], 4)],
        };
        const card = (key: string, minute: number, updated: number) =>
            ({ kind: 'card', key, at: at(minute), updatedAt: at(updated), unit: {} }) as unknown as StreamItem;
        const items = [...streamItems(s), card('card:u1', 1, 5), card('card:u2', 4, 4)];
        const known = new Set(['message:1', 'card:u1']);
        // replies to me count like mentions: here message 4 stands for one
        const toMe = (r: { id: string; mentions: readonly string[] }): boolean => mentionsMe(r as never, s, 'me') || r.id === '4';
        expect(arrivedBelow(items, known, 'me', toMe)).toEqual({ count: 3, forMe: 2 });
        expect(arrivedBelow(items, new Set(items.map((i) => i.key)), 'me', toMe)).toEqual({ count: 0, forMe: 0 });
    });
});
