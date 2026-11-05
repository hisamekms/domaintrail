// A conflict made a hotspot is handed over to it (ADR 0031, section 4): the press is kept while its message is on its
// way; when its run ends with exactly one hotspot added, both items are handed over to it; otherwise the press is
// forgotten. Kept in the session database, so that a server started again still has it.
import { describe, expect, test } from 'bun:test';
import { DatabaseSync } from 'node:sqlite';
import { createHotspotHandOvers, type RequestOutcome } from './hotspot-handovers.js';
import { createSqliteHotspotHandOvers } from '../infrastructure/sqlite-hotspot-handovers.js';
import type { KnowledgeStore } from './ports.js';
import type { Knowledge } from '../generated/index.js';
import { at, itemId, liveItem, userName } from '../test-helpers.js';

const project = 'shop' as Knowledge.ProjectName;
const alice = userName('access:alice@example.com');
const a = itemId('kn_00000001');
const b = itemId('kn_00000002');

function setup(outcomes: Map<string, RequestOutcome>, db = new DatabaseSync(':memory:')) {
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
        now: () => at,
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
        outcomes.set('r1', { kind: 'ran', hotspots: ['Ordering.CutOffUnclear'] });
        expect(await handOvers.settle()).toEqual([{ kind: 'handedOver', request: 'r1', hotspot: 'Ordering.CutOffUnclear', items: [a, b] }] as never);
        expect(calls).toEqual([[project, a, b, 'Ordering.CutOffUnclear', alice]]);
        expect(await handOvers.list()).toEqual([]);
        expect(changed()).toBe(2);
    });

    test('no hotspot, more than one, or a message that ended without a run: the press is forgotten, nothing handed over', async () => {
        const outcomes = new Map<string, RequestOutcome>([
            ['r1', { kind: 'ran', hotspots: [] }],
            ['r2', { kind: 'ran', hotspots: ['Ordering.H1', 'Ordering.H2'] }],
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

    test('a store that fails keeps the press, to try again when the session moves next', async () => {
        const outcomes = new Map<string, RequestOutcome>([['r1', { kind: 'ran', hotspots: ['Ordering.CutOffUnclear'] }]]);
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
