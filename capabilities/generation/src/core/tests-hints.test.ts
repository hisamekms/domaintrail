import { describe, expect, test } from 'bun:test';
import { exprModelIndex, semanticIROf } from '@domaintrail/modeling';
import { checkSales } from '../test-helpers.js';
import { hintsOf } from './tests.js';

describe('contract test hints', () => {
    test('reads value and length bounds from a primitive invariant through the IR', async () => {
        const analysis = await checkSales('primitive NumberCode: Int { value in 1..9 } primitive TextCode: String { value.length <= 9 }');
        expect(analysis.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        const number = analysis.model!.elements.find((element) => element.name === 'NumberCode');
        const text = analysis.model!.elements.find((element) => element.name === 'TextCode');
        if (!number || number.kind !== 'primitive' || !text || text.kind !== 'primitive') throw new Error('primitive missing');
        const irIndex = exprModelIndex(semanticIROf(analysis), analysis.model!);

        expect(hintsOf([...number.invariants, ...text.invariants], irIndex)).toEqual({ ge: 1, le: 9, maxLength: 9 });
    });
});
