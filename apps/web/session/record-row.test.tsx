// The records in the chat (record-row.tsx, stream.ts, threads.ts): placed in the stream by time, counted as unread,
// written again in place; a small muted row in the page's language with no button (docs/ui-rules.md); one at the end
// of an interview's thread hangs on the thread's line under the message it follows.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, MESSAGES } from '../i18n';
import { ChatProvider, type ChatContextValue } from './chat-context';
import { RecordRow } from './record-row';
import { streamItems, unreadCount, type RecordJson } from './stream';
import { replyLooks, threadLines } from './threads';
import { applyEvent } from './state';
import { actKinds } from '../test-helpers';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';

const NAMES: Record<string, string> = { f: '大山', b: '佐藤' };
const chat = { tx: MESSAGES.ja.session, nameOf: (id: string) => NAMES[id] ?? id } as unknown as ChatContextValue;

const goal: RecordJson = {
    state: 'Written',
    id: 'r1',
    session: 's',
    by: 'f',
    fact: { kind: 'GoalChanged', journey: { journey: 'es:Issue', label: '交付' }, from: 'BigPicture', to: 'DesignLevel', other: false },
    at: '2026-11-04T09:00:02.000Z',
};
const stopped: RecordJson = {
    state: 'Written',
    id: 'r2',
    session: 's',
    by: 'b',
    fact: { kind: 'InterviewStopped', interview: 'i1' },
    replyTo: 'm1',
    at: '2026-11-04T09:00:04.000Z',
};
const message = (id: string, at: string) => ({ id, author: 'b', body: 'x', sentAt: at, targets: [], mentions: [], state: 'Sent', session: 's' });

const STATE = {
    session: { id: 's', state: 'Open', mode: 'Collab', participants: [], facilitator: 'f' },
    requests: [message('m0', '2026-11-04T09:00:01.000Z'), message('m1', '2026-11-04T09:00:03.000Z')],
    runs: [],
    revisions: [],
    marks: [],
    approvals: [],
    records: [goal, stopped],
    quickReactions: [],
    seq: 1,
} as unknown as SessionStateBody;

const render = (record: RecordJson, lang: 'ja' | 'en' = 'ja', hangs = false): string =>
    renderToStaticMarkup(
        <I18nProvider lang={lang}>
            <ChatProvider value={chat}>
                <RecordRow record={record} hangs={hangs} />
            </ChatProvider>
        </I18nProvider>,
    );

describe('the records in the chat', () => {
    test('in the stream by time, between the messages; unread when written after the chat was last shown', () => {
        const items = streamItems(STATE);
        expect(items.map((i) => i.key)).toEqual(['message:m0', 'record:r1', 'message:m1', 'record:r2']);
        expect(unreadCount(items, '2026-11-04T09:00:02.500Z')).toBe(2);
    });

    test('a small row in the page’s language, with its time; no button', () => {
        const ja = render(goal);
        expect(ja).toContain('class="chat-system chat-record"');
        expect(ja).toContain('大山 がゴールを ビッグピクチャー → デザインレベル に変えました');
        expect(actKinds(ja)).toEqual([]);
        expect(ja).not.toContain('<button');
        expect(render(goal, 'en')).toContain('大山 changed the goal: Big Picture → Design Level');
    });

    test('at the end of an interview’s thread: it hangs on the line under the message it follows', () => {
        const items = streamItems(STATE);
        const looks = replyLooks(threadLines(items.map((item) => ({ kind: 'item' as const, item }))));
        expect(looks[3]).toMatchObject({ hangsOn: 'message:m1', quote: false });
        expect(looks[2]).toMatchObject({ head: true });
        const html = render(stopped, 'ja', true);
        expect(html).toContain('class="chat-system chat-record hangs"');
        expect(html).toContain('chat-avatar-space');
        expect(html).toContain('佐藤 が中止しました');
    });

    test('written and written again over the socket: added once, then its fact and time replaced in place', () => {
        const base = { ...STATE, records: [] } as SessionStateBody;
        const written = applyEvent(base, {
            type: 'record.written',
            seq: 2,
            event: { type: 'RecordWritten', recordId: 'r1', session: 's', by: 'f', fact: goal.fact, at: goal.at },
        } as never);
        expect(written.refetch).toBe(false);
        expect(written.state.records).toEqual([goal]);
        const fact = { ...goal.fact, to: 'BigPicture' } as RecordJson['fact'];
        const revised = applyEvent(written.state, {
            type: 'record.revised',
            seq: 3,
            event: { type: 'RecordRevised', recordId: 'r1', fact, revisedAt: '2026-11-04T09:00:09.000Z' },
        } as never);
        expect(revised.state.records).toEqual([{ ...goal, fact, revisedAt: '2026-11-04T09:00:09.000Z' }]);
    });
});
