// A conflict made a hotspot is handed over to it (ADR 0031, section 4): the press is kept while its message is on its
// way; when its run ends, its hotspot is the one it added, else the existing one it changed, else the one its reply
// names: exactly one, and both items are handed over to it; otherwise the press is forgotten, with why. Kept in the
// session database, so that a server started again still has it.
import { describe, expect, test } from 'bun:test';
import { DatabaseSync } from 'node:sqlite';
import { CLEARED_KEPT_MS, createHotspotHandOvers, hotspotOf, type RequestOutcome } from './hotspot-handovers.js';
import { createSqliteHotspotHandOvers } from '../infrastructure/sqlite-hotspot-handovers.js';
import type { KnowledgeStore } from './ports.js';
import type { Knowledge } from '../generated/index.js';
import { at, itemId, liveItem, userName } from '../test-helpers.js';

const project = 'shop' as Knowledge.ProjectName;
const alice = userName('access:alice@example.com');
const a = itemId('kn_00000001');
const b = itemId('kn_00000002');

const ran = (added: string[] = [], changed: string[] = [], named: string[] = []): Extract<RequestOutcome, { kind: 'ran' }> => ({
    kind: 'ran',
    added,
    changed,
    named,
});

function setup(outcomes: Map<string, RequestOutcome>, db = new DatabaseSync(':memory:'), now: () => Date = () => at) {
    const calls: unknown[][] = [];
    let changed = 0;
    const store = {
        async handOverToHotspot(...args: unknown[]) {
            calls.push(args);
            return { ok: true as const, value: [liveItem('kn_00000001'), liveItem('kn_00000002')] };
        },
    } as unknown as KnowledgeStore;
    const pending = createSqliteHotspotHandOvers(db);
    const handOvers = createHotspotHandOvers({
        session: 's1',
        project,
        store,
        pending,
        outcomeOf: async (request) => outcomes.get(request) ?? { kind: 'waiting' },
        now,
        changed: () => changed++,
        log: () => undefined,
    });
    return { handOvers, calls, changed: () => changed, db };
}

describe('hotspot hand-overs', () => {
    test('a press is kept while its message is on its way, and the pages are told', async () => {
        const { handOvers, calls, changed } = setup(new Map());
        await handOvers.press({ request: 'r1', items: [a, b], by: alice });
        expect(await handOvers.list()).toEqual([{ request: 'r1', items: [a, b], by: alice, at }]);
        expect(changed()).toBe(1);
        expect(await handOvers.settle()).toEqual([]);
        expect(calls).toEqual([]);
    });

    test('kept in the session database: a server started again still has it', async () => {
        const db = new DatabaseSync(':memory:');
        await setup(new Map(), db).handOvers.press({ request: 'r1', items: [a, b], by: alice });
        expect((await setup(new Map(), db).handOvers.list()).map((p) => p.request)).toEqual(['r1']);
    });

    test('a run that added exactly one hotspot: both items handed over to it, by the person who pressed, and the press forgotten', async () => {
        const outcomes = new Map<string, RequestOutcome>();
        const { handOvers, calls, changed } = setup(outcomes);
        await handOvers.press({ request: 'r1', items: [a, b], by: alice });
        outcomes.set('r1', ran(['Ordering.CutOffUnclear']));
        expect(await handOvers.settle()).toEqual([{ kind: 'handedOver', request: 'r1', hotspot: 'Ordering.CutOffUnclear', items: [a, b] }] as never);
        expect(calls).toEqual([[project, a, b, 'Ordering.CutOffUnclear', alice]]);
        expect(await handOvers.list()).toEqual([]);
        expect(changed()).toBe(2);
    });

    test('no hotspot, more than one, or a message that ended without a run: the press is forgotten, nothing handed over', async () => {
        const outcomes = new Map<string, RequestOutcome>([
            ['r1', ran()],
            ['r2', ran(['Ordering.H1', 'Ordering.H2'])],
            ['r3', { kind: 'ended', why: 'the run declined' }],
            ['r4', { kind: 'ended', why: 'the proposal was rejected' }],
        ]);
        const db = new DatabaseSync(':memory:');
        const first = setup(new Map(), db);
        for (const r of ['r1', 'r2', 'r3', 'r4']) await first.handOvers.press({ request: r, items: [a, b], by: alice });
        const later = setup(outcomes, db);
        expect((await later.handOvers.settle()).map((s) => [s.request, s.kind])).toEqual([
            ['r1', 'cleared'],
            ['r2', 'cleared'],
            ['r3', 'cleared'],
            ['r4', 'cleared'],
        ]);
        expect(later.calls).toEqual([]);
        expect(await later.handOvers.list()).toEqual([]);
    });

    test('a press cleared: its conflict and why are kept a while, until it is pressed again', async () => {
        let now = at;
        const outcomes = new Map<string, RequestOutcome>([['r1', ran()]]);
        const { handOvers } = setup(outcomes, new DatabaseSync(':memory:'), () => now);
        await handOvers.press({ request: 'r1', items: [a, b], by: alice });
        expect(handOvers.cleared()).toEqual([{ items: [a, b], reason: 'none', at }]);
        // pressed again: gone while it runs, then the new reason
        await handOvers.press({ request: 'r3', items: [b, a], by: alice });
        expect(handOvers.cleared()).toEqual([]);
        outcomes.set('r3', ran([], [], ['Ordering.H1', 'Ordering.H2']));
        await handOvers.settle();
        expect(handOvers.cleared().map((c) => c.reason)).toEqual(['several']);
        now = new Date(at.getTime() + CLEARED_KEPT_MS + 1);
        expect(handOvers.cleared()).toEqual([]);
    });

    test('the hotspot of a run: added, else changed, else named; exactly one at the first step that has any', () => {
        expect(hotspotOf(ran(['O.Added'], ['O.Changed'], ['O.Named']))).toEqual({ hotspot: 'O.Added' } as never);
        expect(hotspotOf(ran([], ['O.Changed'], ['O.Named']))).toEqual({ hotspot: 'O.Changed' } as never);
        // the hotspot already existed and the run only names it
        expect(hotspotOf(ran([], [], ['O.Named']))).toEqual({ hotspot: 'O.Named' } as never);
        expect(hotspotOf(ran([], [], ['O.Named', 'O.Named']))).toEqual({ hotspot: 'O.Named' } as never);
        expect(hotspotOf(ran())).toMatchObject({ reason: 'none' });
        expect(hotspotOf(ran(['O.A', 'O.B'], [], ['O.Named']))).toMatchObject({ reason: 'several', why: 'the run added 2 hotspots' });
        expect(hotspotOf(ran([], ['O.A', 'O.B']))).toMatchObject({ reason: 'several', why: 'the run changed 2 hotspots' });
        expect(hotspotOf(ran([], [], ['O.A', 'O.B']))).toMatchObject({ reason: 'several', why: 'the run named 2 hotspots' });
    });

    test('a run that only names an existing hotspot: handed over to it', async () => {
        const outcomes = new Map<string, RequestOutcome>();
        const { handOvers, calls } = setup(outcomes);
        await handOvers.press({ request: 'r1', items: [a, b], by: alice });
        outcomes.set('r1', ran([], [], ['OrderToCash.InvoiceTiming']));
        expect((await handOvers.settle()).map((s) => s.kind)).toEqual(['handedOver']);
        expect(calls).toEqual([[project, a, b, 'OrderToCash.InvoiceTiming', alice]]);
        expect(handOvers.cleared()).toEqual([]);
    });

    test('a store that fails keeps the press, to try again when the session moves next', async () => {
        const outcomes = new Map<string, RequestOutcome>([['r1', ran(['Ordering.CutOffUnclear'])]]);
        const db = new DatabaseSync(':memory:');
        const pending = createSqliteHotspotHandOvers(db);
        await pending.add('s1', { request: 'r1', items: [a, b], by: alice, at });
        const handOvers = createHotspotHandOvers({
            session: 's1',
            project,
            store: {
                handOverToHotspot: async () => {
                    throw new Error('unreachable');
                },
            } as unknown as KnowledgeStore,
            pending,
            outcomeOf: async (request) => outcomes.get(request) ?? { kind: 'waiting' },
            now: () => at,
            changed: () => undefined,
            log: () => undefined,
        });
        expect(await handOvers.settle()).toEqual([]);
        expect((await handOvers.list()).map((p) => p.request)).toEqual(['r1']);
    });
});
