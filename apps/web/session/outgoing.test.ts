// What the composer sends (apps/web/session/outgoing.ts): a message and a `/` command started, each with the view.
import { describe, expect, test } from 'bun:test';
import { commandBody, interviewBody, messageBody } from './outgoing';
import type { SentView } from './views';

const viewedAt: SentView = { view: { kind: 'Storming', storming: 'OrderToCash', level: 'DesignLevel', exceptions: true } };

describe('what the composer sends', () => {
    test('a message: its chips as targets of the revision, the reply, the people, and where it was sent from', () => {
        const value = {
            text: '#注文[1] ここに足して',
            chips: [{ target: { target: { kind: 'DtElement' as const, element: 'Sales.Order' } }, mentioned: true }],
            people: ['dev:bob'],
        };
        expect(messageBody({ value, revision: 'r1', reply: { kind: 'Run', run: 'run-1', name: 'x' }, viewedAt })).toEqual({
            targets: [{ target: { kind: 'DtElement', element: 'Sales.Order' }, sourceRevision: 'r1' }],
            body: '#注文[1] ここに足して',
            replyTo: { kind: 'Run', run: 'run-1' },
            mentions: ['dev:bob'],
            viewedAt,
        });
        // a template's text is sent the same way: only the view is added
        expect(messageBody({ value: { text: 'イベントを足して', chips: [], people: [] }, revision: 'r1', viewedAt })).toEqual({
            targets: [],
            body: 'イベントを足して',
            viewedAt,
        });
        expect(messageBody({ value: { text: 'x', chips: [], people: [] }, revision: 'r1' })).toEqual({ targets: [], body: 'x' });
    });

    test('a `/` command: its opening, the language, the element selected and the view', () => {
        expect(
            interviewBody({ command: 'es:start', body: 'ES を始める', language: 'ja', focus: { kind: 'DtesStorming', storming: 'OrderToCash' }, viewedAt }),
        ).toEqual({
            command: 'es:start',
            body: 'ES を始める',
            language: 'ja',
            focus: { kind: 'DtesStorming', storming: 'OrderToCash' },
            viewedAt,
        });
        expect(interviewBody({ command: 'model:start', body: 'x', language: 'en' })).toEqual({ command: 'model:start', body: 'x', language: 'en' });
        expect(commandBody({ command: 'es:exceptions', body: '例外を洗い出す', language: 'ja', viewedAt })).toEqual({
            command: 'es:exceptions',
            body: '例外を洗い出す',
            language: 'ja',
            viewedAt,
        });
    });
});
