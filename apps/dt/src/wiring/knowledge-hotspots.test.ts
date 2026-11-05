// What became of the message ホットスポットにする sent (ADR 0031, section 4), read from the session's state: its latest
// run decides (the hotspots it added and changed, those its reply names); without one, its triage and proposal say
// whether a run may still come.
import { describe, expect, test } from 'bun:test';
import type { CollaborationUseCases } from '@domaintrail/collaboration';
import { namedInReply, ownRequest, requestOutcomes } from './knowledge-hotspots';

interface Fake {
    requests?: unknown[];
    runs?: unknown[];
    triages?: unknown[];
    proposals?: unknown[];
    changes?: unknown[];
    complete?: boolean;
    /** The `.dtes` elements of the run's result revision. */
    elements?: unknown[];
}

const collaboration = (f: Fake): CollaborationUseCases =>
    ({
        sessionState: async () => ({
            ok: true,
            value: {
                requests: f.requests ?? [{ id: 'r1', state: 'Sent', author: 'p1' }],
                runs: f.runs ?? [],
                triages: f.triages ?? [],
                proposals: f.proposals ?? [],
            },
        }),
        modelChanges: async () => ({ ok: true, value: { changes: f.changes ?? [], complete: f.complete ?? true } }),
        stormingElements: async () => ({ ok: true, value: { elements: f.elements ?? [], complete: true } }),
    }) as unknown as CollaborationUseCases;

const outcome = (f: Fake): Promise<unknown> => requestOutcomes(collaboration(f), 's1' as never)('r1');
const run = (state: string, extra: Record<string, unknown> = {}): unknown => ({ state, input: { requests: [{ request: 'r1' }] }, ...extra });
const hotspot = (local: string, change = 'added'): unknown => ({ language: 'Dtes', kind: 'hotspot', storming: 'Returns', local, change });

describe('requestOutcomes', () => {
    test('a run queued, running or asking a question: waiting', async () => {
        for (const s of ['Queued', 'Running', 'NeedsClarification']) expect(await outcome({ runs: [run(s)] })).toEqual({ kind: 'waiting' });
    });

    test('a completed run: the hotspots it added and changed, from the storming’s diff (not those removed, nor other elements)', async () => {
        const changes = [
            hotspot('CutOff'),
            hotspot('Deadline', 'changed'),
            hotspot('Old', 'removed'),
            { language: 'Dtes', kind: 'event', storming: 'Returns', local: 'X', change: 'added' },
        ];
        expect(await outcome({ runs: [run('Completed', { changed: true })], changes })).toEqual({
            kind: 'ran',
            added: ['Returns.CutOff'],
            changed: ['Returns.Deadline'],
            named: [],
        });
        expect(await outcome({ runs: [run('Completed', { changed: false })] })).toEqual({ kind: 'ran', added: [], changed: [], named: [] });
        expect(await outcome({ runs: [run('Completed', { changed: true })], complete: false })).toMatchObject({ kind: 'ended' });
    });

    test('a completed run that added or changed none: the hotspots its reply names, in its result revision', async () => {
        const reply = {
            summary: '既存の @{es:Returns/Deadline} を使いました（@{es:Returns/ReturnRequested} について）。',
            requests: [{ request: 'r1', status: 'done', note: '@{es:Returns/Gone} と @{Sales.Order}' }],
            questions: [],
            assumptions: [],
        };
        const elements = [
            { storming: 'Returns', local: 'Deadline', kind: 'hotspot' },
            { storming: 'Returns', local: 'ReturnRequested', kind: 'event' },
        ];
        expect(await outcome({ runs: [run('Completed', { changed: false, reply })], elements })).toEqual({
            kind: 'ran',
            added: [],
            changed: [],
            named: ['Returns.Deadline'],
        });
        // added first: what the reply names is not read
        expect(await outcome({ runs: [run('Completed', { changed: true, reply })], changes: [hotspot('CutOff')], elements })).toEqual({
            kind: 'ran',
            added: ['Returns.CutOff'],
            changed: [],
            named: [],
        });
    });

    test('the latest run decides: a question answered by a run that completed', async () => {
        expect(await outcome({ runs: [run('NeedsClarification'), run('Completed', { changed: true })], changes: [hotspot('CutOff')] })).toEqual({
            kind: 'ran',
            added: ['Returns.CutOff'],
            changed: [],
            named: [],
        });
    });

    test('a run declined, failed or cancelled: ended', async () => {
        for (const s of ['Declined', 'Failed', 'Cancelled']) expect(await outcome({ runs: [run(s)] })).toMatchObject({ kind: 'ended' });
    });

    test('no run yet: waiting while triaged or a proposal waits for the facilitator; ended when it never runs', async () => {
        const triage = (extra: Record<string, unknown>): unknown => ({ request: 'r1', ...extra });
        expect(await outcome({})).toEqual({ kind: 'waiting' });
        expect(await outcome({ triages: [triage({ state: 'Pending' })] })).toEqual({ kind: 'waiting' });
        expect(await outcome({ triages: [triage({ state: 'Decided', kind: 'ChangeRequest' })] })).toEqual({ kind: 'waiting' });
        expect(await outcome({ triages: [triage({ state: 'Decided', kind: 'NotForAi' })] })).toMatchObject({ kind: 'ended' });
        expect(await outcome({ triages: [triage({ state: 'Decided', kind: 'Consultation', outcome: { kind: 'Answer', answer: 'a1' } })] })).toMatchObject({
            kind: 'ended',
        });
        const proposed = [triage({ state: 'Decided', kind: 'ChangeRequest', outcome: { kind: 'Proposal', proposal: 'cp1' } })];
        expect(await outcome({ triages: proposed, proposals: [{ id: 'cp1', state: 'Open' }] })).toEqual({ kind: 'waiting' });
        expect(await outcome({ triages: proposed, proposals: [{ id: 'cp1', state: 'Rejected' }] })).toEqual({
            kind: 'ended',
            why: 'the proposal was rejected',
        });
        expect(await outcome({ triages: proposed, proposals: [{ id: 'cp1', state: 'Withdrawn' }] })).toEqual({
            kind: 'ended',
            why: 'the proposal was withdrawn',
        });
    });

    test('a message dismissed or gone: ended', async () => {
        expect(await outcome({ requests: [{ id: 'r1', state: 'Dismissed' }] })).toMatchObject({ kind: 'ended' });
        expect(await outcome({ requests: [] })).toMatchObject({ kind: 'ended' });
    });
});

test('namedInReply: the storming elements its text names, each once', () => {
    expect(namedInReply(undefined)).toEqual([]);
    expect(
        namedInReply({
            summary: '@{es:A/H} と @{es:A}',
            answer: '@{es:A/H}',
            requests: [{ note: '@{es:B/H2}' }],
            assumptions: [{ text: '`@{es:C/H3}` @{X.Y}' }],
        } as never),
    ).toEqual(['A.H', 'B.H2', 'C.H3']);
});

test('ownRequest: only the author of a message of the session', async () => {
    const c = collaboration({});
    expect(await ownRequest(c, 's1' as never, 'r1', 'p1')).toBe(true);
    expect(await ownRequest(c, 's1' as never, 'r1', 'p2')).toBe(false);
    expect(await ownRequest(c, 's1' as never, 'r9', 'p1')).toBe(false);
});
