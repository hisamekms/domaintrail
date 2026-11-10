import { describe, expect, test } from 'bun:test';
import type { EventMessage, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { changeUnits } from './history';
import { isReplyable, messageReference, messageReplyTargets, repliesToMe, replyReference, replyTargetOf, replyTargets } from './replies';
import { applyEvent } from './state';

type RunJson = SessionStateBody['runs'][number];
type RequestJson = SessionStateBody['requests'][number];

describe("the page's replies", () => {
    const at = (minute: number): string => `2026-11-01T09:${String(minute).padStart(2, '0')}:00.000Z`;
    const target = (element: string) => ({ target: { kind: 'DtElement' as const, element }, sourceRevision: 'r0', label: element });
    // `replyTo`: a run's ID, or the message it replies to
    const request = (id: string, replyTo?: string | { message: string }, targets: ReturnType<typeof target>[] = []): RequestJson =>
        ({
            id,
            session: 's',
            author: 'dev:ann',
            targets,
            body: `body of ${id}`,
            sentAt: at(0),
            state: 'Sent',
            mentions: [],
            ...(replyTo && { replyTo: typeof replyTo === 'string' ? { kind: 'Run', run: replyTo } : { kind: 'Message', request: replyTo.message } }),
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
        // a reply to a message (even one a run applied) continues no card
        const toMessage = run('v', 9, [request('r5', { message: 'm1' })], done(10));
        expect(changeUnits(state([x, other, toMessage])).find((u) => u.runs.some((r) => r.run.id === 'v'))?.key).toBe('v');
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

    test('a request.sent event of a reply carries what it replies to into the page state', () => {
        const base = { session: {}, requests: [], runs: [], revisions: [], marks: [], seq: 1 } as unknown as SessionStateBody;
        const sent = (replyTo: unknown): EventMessage =>
            ({
                type: 'request.sent',
                seq: 2,
                event: {
                    type: 'Collaboration.RequestSent',
                    requestId: 'r1',
                    session: 's',
                    author: 'dev:ann',
                    targets: [],
                    body: 'And?',
                    sentAt: at(0),
                    replyTo,
                },
            }) as unknown as EventMessage;
        expect(applyEvent(base, sent({ kind: 'Run', run: 'x' })).state.requests[0]).toMatchObject({ id: 'r1', replyTo: { kind: 'Run', run: 'x' } });
        expect(applyEvent(base, sent({ kind: 'Message', request: 'm' })).state.requests[0]).toMatchObject({ replyTo: { kind: 'Message', request: 'm' } });
    });

    test('a reply to a message: what it starts with, sends, and shows; whom it asks for attention', () => {
        const original = {
            ...request('m9', undefined, [target('Sales.Order'), target('Sales.Order')]),
            author: 'dev:bob',
            body: '#注文[1] の取消は\n@佐藤[p1] に聞く',
            mentions: ['dev:sato'],
        } as RequestJson;
        // its own targets, each once
        expect(messageReplyTargets(original).map((t) => t.target)).toEqual([{ kind: 'DtElement', element: 'Sales.Order' }]);
        expect(replyTargetOf({ kind: 'Message', request: 'm9', author: 'dev:bob' })).toEqual({ kind: 'Message', request: 'm9' });
        expect(replyTargetOf({ kind: 'Run', run: 'x', name: 'n' })).toEqual({ kind: 'Run', run: 'x' });
        // the head of the body on one line, elements and people by name; nothing for a message the session does not hold
        expect(messageReference([original], 'm9')).toEqual({ request: 'm9', author: 'dev:bob', head: '#注文 の取消は @佐藤 に聞く' });
        expect(messageReference([original], 'nope')).toBeUndefined();

        const holder = { session: { facilitator: 'local:facilitator' }, facilitatorHolder: 'dev:ada' } as unknown as Pick<
            SessionStateBody,
            'session' | 'facilitatorHolder'
        >;
        const reply = request('r9', { message: 'm9' });
        // Bob's message is replied to by Ann: Bob's stream only
        expect(repliesToMe(reply, [original], holder, 'dev:bob')).toBe(true);
        expect(repliesToMe(reply, [original], holder, 'dev:ann')).toBe(false);
        expect(repliesToMe(reply, [original], holder, 'dev:sato')).toBe(false);
        // my own reply to my message, and a reply to a run, never do
        expect(repliesToMe({ ...reply, author: 'dev:bob' }, [original], holder, 'dev:bob')).toBe(false);
        expect(repliesToMe(request('r10', 'x'), [original], holder, 'dev:bob')).toBe(false);
        // a message of the facilitator, while I hold the role
        const facilitators = { ...original, author: 'local:facilitator' } as RequestJson;
        expect(repliesToMe(reply, [facilitators], holder, 'dev:ada')).toBe(true);
    });
});
