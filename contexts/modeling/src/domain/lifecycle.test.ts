import { describe, expect, test } from 'bun:test';
import { checkSales } from '../test-helpers.js';
import { lifecyclesOf } from './lifecycle.js';
import type { AggregateDecl } from './source-model.js';

async function lifecycle(body: string) {
    const analysis = await checkSales(body);
    const aggregate = analysis.sourceModel?.elements.find((element): element is AggregateDecl => element.kind === 'aggregate');
    if (!aggregate) throw new Error('aggregate missing');
    return lifecyclesOf(aggregate);
}

describe('lifecyclesOf', () => {
    test('uses aggregate initials without kinds', async () => {
        expect(await lifecycle(`aggregate A { id: String state New state Done initial New command finish() New -> Done }`)).toEqual([
            { kind: '*', initial: ['New'], creationTargets: [], reachableFromInitial: ['New', 'Done'], reachable: ['New', 'Done'] },
        ]);
    });

    test('keeps an empty valid state list for every kind when the aggregate has no states', async () => {
        const analysis = await checkSales(`aggregate A { id: String kind P {} kind Q {} }`);
        const aggregate = analysis.sourceModel?.elements.find((element): element is AggregateDecl => element.kind === 'aggregate');
        expect(aggregate).toBeDefined();
        expect(lifecyclesOf(aggregate!, true).map(({ kind, validStates }) => ({ kind, states: validStates }))).toEqual([
            { kind: 'P', states: [] },
            { kind: 'Q', states: [] },
        ]);
    });

    test('keeps create initial states and reachability separate by kind', async () => {
        expect(
            await lifecycle(`aggregate A {
              id: String state First state FirstDone state Second state SecondDone
              kind ONE { create command makeOne() { outcome made: -> First } on finish { outcome finished: First -> FirstDone } }
              kind TWO { create command makeTwo() { outcome made: -> Second } on finish { outcome finished: Second -> SecondDone } }
              command finish()
            }`),
        ).toEqual([
            { kind: 'ONE', initial: ['First'], creationTargets: ['First'], reachableFromInitial: ['First', 'FirstDone'], reachable: ['First', 'FirstDone'] },
            {
                kind: 'TWO',
                initial: ['Second'],
                creationTargets: ['Second'],
                reachableFromInitial: ['Second', 'SecondDone'],
                reachable: ['Second', 'SecondDone'],
            },
        ]);
    });

    test('follows on-case outcomes', async () => {
        expect(
            await lifecycle(`aggregate A { id: String state New state Done initial New command finish() kind K { on finish { outcome done: New -> Done } } }`),
        ).toEqual([{ kind: 'K', initial: ['New'], creationTargets: [], reachableFromInitial: ['New', 'Done'], reachable: ['New', 'Done'] }]);
    });

    test('follows shorthand transitions with one target', async () => {
        expect(await lifecycle(`aggregate A { id: String state New state Done initial New command finish() New -> Done }`)).toEqual([
            { kind: '*', initial: ['New'], creationTargets: [], reachableFromInitial: ['New', 'Done'], reachable: ['New', 'Done'] },
        ]);
    });

    test('ignores shorthand transitions with more than one target', async () => {
        expect(await lifecycle(`aggregate A { id: String state New state Done state Archived initial New command finish() New -> Done | Archived }`)).toEqual([
            { kind: '*', initial: ['New'], creationTargets: [], reachableFromInitial: ['New'], reachable: ['New'] },
        ]);
    });
});
