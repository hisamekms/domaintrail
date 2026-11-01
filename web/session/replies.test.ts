import { describe, expect, test } from 'bun:test';
import type { EventMessage, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { changeUnits } from './history';
import { isReplyable, replyReference, replyTargets } from './replies';
import { applyEvent } from './state';

type RunJson = SessionStateBody['runs'][number];
type RequestJson = SessionStateBody['requests'][number];

describe("the page's replies", () => {
    const at = (minute: number): string => `2026-11-01T09:${String(minute).padStart(2, '0')}:00.000Z`;
    const target = (element: string) => ({ target: { kind: 'DtElement' as const, element }, sourceRevision: 'r0', label: element });
    const request = (id: string, replyTo?: string, targets: ReturnType<typeof target>[] = []): RequestJson =>
        ({
            id,
            session: 's',
            author: 'dev:ann',
            targets,
            body: `body of ${id}`,
            sentAt: at(0),
            state: 'Sent',
            ...(replyTo && { replyTo }),
        }) as unknown as RequestJson;
    const run = (id: string, minute: number, requests: RequestJson[], state: object): RunJson =>
        ({
            id,
            session: 's',
            input: {
                requests: requests.map((r) => ({
                    request: r.id,
                    author: r.author,
                    targets: r.targets,
                    body: r.body,
                    ...(r.replyTo && { replyTo: r.replyTo }),
                })),
            },
            queuedBy: 'dev:ada',
            queuedAt: at(minute),
            ...state,
        }) as unknown as RunJson;
    const done = (minute: number, summary?: string): object => ({
        state: 'Completed',
        baseRevision: 'r0',
        startedAt: at(minute),
        resultRevision: 'r0',
        changed: false,
        report: {},
        finishedAt: at(minute),
        ...(summary !== undefined && { reply: { summary, requests: [], questions: [], assumptions: [] } }),
    });
    const m1 = request('m1', undefined, [target('Sales.Order'), target('Sales.Customer')]);
    const m2 = request('m2', undefined, [target('Sales.Order')]);
    const x = run('x', 1, [m1, m2], done(2, 'Added @{Sales.Order:cancel}\nand more.'));
    const other = run('o', 3, [request('m3')], done(4, 'Other.'));
    const r1 = request('r1', 'x');
    const r2 = request('r2', 'x');
    const r3 = request('r3', 'o');
    const state = (runs: RunJson[]) => ({ runs, revisions: [] });

    test('a run of replies continues the unit of the run they reply to; a reply to it extends the same unit', () => {
        const y = run('y', 5, [r1, r2], done(6, 'Only drafts now.'));
        const z = run('z', 7, [request('r4', 'y')], done(8));
        const units = changeUnits(state([x, other, y, z]));
        expect(units.map((u) => u.runs.map((r) => [r.run.id, r.number]))).toEqual([
            [
                ['x', 1],
                ['y', 3],
                ['z', 4],
            ],
            [['o', 2]],
        ]);
        // the unit stays where its first run was queued, and moved on: the "updated" pill's input
        expect(units[0].start).toBe(at(1));
        expect(units[0].at).toBe(at(8));
        // replies to runs of two units: the latest of them
        const across = run('w', 9, [r1, r3], done(10));
        expect(changeUnits(state([x, other, across])).find((u) => u.runs.some((r) => r.run.id === 'w'))?.key).toBe('o');
    });

    test('which turns can be replied to; the reference a reply shows; what a reply starts with', () => {
        const states = ['Completed', 'Failed', 'Declined', 'Cancelled', 'NeedsClarification', 'Queued', 'Running'] as const;
        expect(states.filter((s) => isReplyable({ ...x, state: s } as RunJson))).toEqual(['Completed', 'Failed', 'Declined', 'Cancelled']);
        const units = changeUnits(state([x, other, run('y', 5, [r1], done(6))]));
        // a run is named by its card: no title, so the head of the card's first message
        expect(replyReference(units, 'x')).toEqual({
            run: 'x',
            name: 'body of m1',
            summary: 'Added @{Sales.Order:cancel} and more.',
            state: 'Completed',
            card: 'x',
        });
        expect(replyReference(units, 'y')).toMatchObject({ name: 'body of m1', summary: undefined, card: 'x' });
        // with a title, the card's title, for a run that continues it too
        const titled = { ...x, reply: { title: '注文の取消', summary: 'Added.', requests: [], questions: [], assumptions: [] } } as RunJson;
        const named = changeUnits(state([titled, run('y', 5, [r1], done(6))]));
        expect(replyReference(named, 'y')).toMatchObject({ name: '注文の取消', card: 'x' });
        expect(replyReference(units, 'nope')).toBeUndefined();
        // the targets of the replied run's requests, each once
        expect(replyTargets(x).map((t) => t.target)).toEqual([
            { kind: 'DtElement', element: 'Sales.Order' },
            { kind: 'DtElement', element: 'Sales.Customer' },
        ]);
    });

    test('a request.sent event of a reply carries its run into the page state', () => {
        const base = { session: {}, requests: [], runs: [], revisions: [], marks: [], seq: 1 } as unknown as SessionStateBody;
        const event = {
            type: 'request.sent',
            seq: 2,
            event: { type: 'RequestSent', requestId: 'r1', session: 's', author: 'dev:ann', targets: [], body: 'And?', sentAt: at(0), replyTo: 'x' },
        } as unknown as EventMessage;
        expect(applyEvent(base, event).state.requests[0]).toMatchObject({ id: 'r1', replyTo: 'x' });
    });
});
