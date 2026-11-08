import { describe, expect, test } from 'bun:test';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import type { AiSlot } from './ai';
import { placeAiSlots, streamItems } from './stream';
import { replyLooks, threadLines, type ReplyLook, type ThreadLine } from './threads';

type RequestJson = SessionStateBody['requests'][number];

const at = (minute: number): string => `2026-11-03T09:${String(minute).padStart(2, '0')}:00.000Z`;
const message = (id: string, author: string, minute: number, replyTo?: { message: string } | { run: string }): RequestJson =>
    ({
        id,
        session: 's',
        author,
        targets: [],
        body: `body of ${id}`,
        sentAt: at(minute),
        state: 'Sent',
        mentions: [],
        ...(replyTo && { replyTo: 'run' in replyTo ? { kind: 'Run', run: replyTo.run } : { kind: 'Message', request: replyTo.message } }),
    }) as unknown as RequestJson;
const run = (id: string, request: string, minute: number): object => ({
    id,
    session: 's',
    input: { requests: [{ request, author: 'f', targets: [], body: 'b' }] },
    queuedBy: 'f',
    queuedAt: at(minute),
    state: 'Completed',
    startedAt: at(minute),
    finishedAt: at(minute),
    baseRevision: 'r0',
    reply: { summary: 'done' },
});
const state = (mode: 'Solo' | 'Collab', requests: RequestJson[], runs: object[] = []): SessionStateBody =>
    ({
        session: { id: 's', facilitator: 'f', participants: [{ id: 'f', name: 'Fumi', role: 'Facilitator' }], mode, state: 'Open' },
        requests,
        runs,
        revisions: [],
        marks: [],
        approvals: [],
        quickReactions: [],
        seq: 1,
    }) as unknown as SessionStateBody;

/** Each row as one word: `hangs:<head>` (with `+` when more hang below it), `head`, `quote`, or `-`. */
const looks = (lines: readonly ThreadLine[]): string[] =>
    replyLooks(lines).map((l: ReplyLook, i) => {
        const key = lines[i]?.key ?? '';
        if (l.hangsOn !== undefined) return `${key} hangs:${l.hangsOn}${l.more ? '+' : ''}`;
        if (l.head) return `${key} head`;
        return l.quote ? `${key} quote` : `${key} -`;
    });
const line = (key: string, to?: string): ThreadLine => ({ key, to });

describe('how a reply shows', () => {
    test('right under what it replies to: it hangs on its line, no quote; with something in between: the quote', () => {
        expect(looks([line('message:m'), line('message:a', 'message:m')])).toEqual(['message:m head', 'message:a hangs:message:m']);
        expect(looks([line('message:m'), line('message:x'), line('message:a', 'message:m')])).toEqual(['message:m -', 'message:x -', 'message:a quote']);
        // the first row replies to something not on the page: the quote (it says nothing when it is not held)
        expect(looks([line('message:a', 'message:gone')])).toEqual(['message:a quote']);
    });

    test('consecutive replies hang on the same line: to the same message, or to a reply already on it', () => {
        // the AI's answer, then a person's follow-up to the message, then a reply to the answer
        expect(
            looks([line('message:m'), line('message:a', 'message:m'), line('message:h', 'message:m'), line('message:k', 'message:a'), line('message:z')]),
        ).toEqual(['message:m head', 'message:a hangs:message:m+', 'message:h hangs:message:m+', 'message:k hangs:message:m', 'message:z -']);
        // a reply to the reply right above: on the same line, never a line of its own under it
        expect(looks([line('message:m'), line('message:a', 'message:m'), line('message:b', 'message:a')])).toEqual([
            'message:m head',
            'message:a hangs:message:m+',
            'message:b hangs:message:m',
        ]);
        // after something else, a reply to the message quotes it again
        expect(looks([line('message:m'), line('message:a', 'message:m'), line('message:x'), line('message:b', 'message:m')])).toEqual([
            'message:m head',
            'message:a hangs:message:m',
            'message:x -',
            'message:b quote',
        ]);
    });

    test('people and the AI alike, in Collab by time', () => {
        const s = state('Collab', [
            message('m1', 'p', 0),
            // the AI answers right under it
            message('a1', 'ai', 1, { message: 'm1' }),
            message('m2', 'q', 2),
            // a person replies right under m2
            message('h1', 'p', 3, { message: 'm2' }),
            message('m3', 'q', 4),
            // the AI answers m2 after someone else's message: the quote
            message('a2', 'ai', 5, { message: 'm2' }),
        ]);
        const items = streamItems(s);
        expect(looks(threadLines(placeAiSlots(items, new Map())))).toEqual([
            'message:m1 head',
            'message:a1 hangs:message:m1',
            'message:m2 head',
            'message:h1 hangs:message:m2',
            'message:m3 -',
            'message:a2 quote',
        ]);
    });

    test("Solo: the AI's card, its answer and its run card hang under the message, one question after another", () => {
        const s = state('Solo', [message('m1', 'f', 0), message('m2', 'f', 1), message('a1', 'ai', 2, { message: 'm1' })], [run('r', 'm2', 3)]);
        const items = streamItems(s);
        const slots = new Map<string, AiSlot>([
            ['m1', { kind: 'answer', answer: 'a1' }],
            ['m2', { kind: 'pending' }],
        ]);
        expect(looks(threadLines(placeAiSlots(items, slots)))).toEqual([
            'message:m1 head',
            'message:a1 hangs:message:m1',
            'message:m2 head',
            'ai:m2 hangs:message:m2',
            'card:r -',
        ]);
        // the run card in the place of the card
        slots.set('m2', { kind: 'run', run: 'r' });
        expect(looks(threadLines(placeAiSlots(items, slots)))).toEqual([
            'message:m1 head',
            'message:a1 hangs:message:m1',
            'message:m2 head',
            'card:r hangs:message:m2',
        ]);
    });

    test('a reply to a run hangs on its card right above it; else it quotes the card', () => {
        const under = state('Collab', [message('m1', 'f', 0), message('h1', 'p', 5, { run: 'r' })], [run('r', 'm1', 1)]);
        expect(looks(threadLines(placeAiSlots(streamItems(under), new Map())))).toEqual(['message:m1 -', 'card:r head', 'message:h1 hangs:card:r']);
        const apart = state('Collab', [message('m1', 'f', 0), message('x', 'q', 3), message('h1', 'p', 5, { run: 'r' })], [run('r', 'm1', 1)]);
        expect(looks(threadLines(placeAiSlots(streamItems(apart), new Map())))).toEqual(['message:m1 -', 'card:r -', 'message:x -', 'message:h1 quote']);
    });

    test('a facilitator answer replies to the question, and its AI run replies to the answer', () => {
        const asked = { ...run('ask', 'm1', 1), state: 'NeedsClarification', question: 'Which?', finishedAt: at(2) };
        const working = {
            ...run('work', 'm1', 3),
            state: 'Running',
            startedAt: at(3),
            input: {
                requests: [{ request: 'm1', author: 'f', targets: [], body: 'b' }],
                answer: { answerTo: 'ask', answers: [{ question: 'q', text: 'Which?', chosen: [{ id: 'a', label: 'A' }] }] },
            },
        };
        const entries = placeAiSlots(streamItems(state('Collab', [message('m1', 'f', 0)], [asked, working])), new Map());
        expect(threadLines(entries).map((l) => [l.key, l.to])).toEqual([
            ['message:m1', undefined],
            ['card:ask', undefined],
            ['answer:work', 'card:ask'],
            ['card:work', 'answer:work'],
        ]);
        expect(looks(threadLines(entries))).toEqual(['message:m1 -', 'card:ask head', 'answer:work hangs:card:ask+', 'card:work hangs:card:ask']);

        const separated = placeAiSlots(streamItems(state('Collab', [message('m1', 'f', 0), message('other', 'p', 2)], [asked, working])), new Map());
        const lines = threadLines(separated);
        expect(lines.at(-2)).toEqual({ key: 'answer:work', to: 'card:ask' });
        expect(lines.at(-1)).toEqual({ key: 'card:work', to: 'answer:work' });
        const style = replyLooks(lines);
        expect(style.at(-2)?.quote).toBe(true);
        expect(style.at(-1)?.hangsOn).toBe('answer:work');
    });
});
