import { describe, expect, test } from 'bun:test';
import { check } from '../test-helpers.js';
import { valueCycles } from './cycles.js';

const cycles = async (source: string) => valueCycles((await check({ 'cycles.dt': source })).sourceModel!);

describe('valueCycles', () => {
    test('finds a self-recursive optional value', async () => {
        expect(await cycles('context A { value Node { next: Node? } }')).toEqual([{ members: ['A.Node'], ending: new Map() }]);
    });

    test('finds a two-type cycle through a list that may be empty', async () => {
        expect(await cycles('context A { value First { next: Second[0..*] } value Second { previous: First } }')).toEqual([
            { members: ['A.First', 'A.Second'], ending: new Map() },
        ]);
    });

    test('records the first union variant that ends the cycle', async () => {
        expect(await cycles('context A { value Node { choice: Choice } union Choice { Again { node: Node } Empty } }')).toEqual([
            { members: ['A.Node', 'A.Choice'], ending: new Map([['A.Choice', 'Empty']]) },
        ]);
    });

    test('chooses the later union variant when the earlier variant recurses', async () => {
        expect(await cycles(`context M { union U { a { c: C } b { x: Int } } value C { u: U  y: Int } }`)).toEqual([
            { members: ['M.U', 'M.C'], ending: new Map([['M.U', 'b']]) },
        ]);
    });

    test('keeps declaration order across shared contexts', async () => {
        expect(await cycles('shared context A { value First { next: B.Second } } shared context B { value Second { previous: A.First } }')).toEqual([
            { members: ['A.First', 'B.Second'], ending: new Map() },
        ]);
    });
});
