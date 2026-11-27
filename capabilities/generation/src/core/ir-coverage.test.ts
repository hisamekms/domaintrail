import { expect, test } from 'bun:test';
import { buildSemanticIR } from '@domaintrail/modeling';
import { analyzeForGeneration, exampleSources } from '../test-helpers.js';
import { irMisses, irSymbolMisses, irTypeMismatchDetails, irTypeMismatches, resetIrMisses } from './checks.js';
import { generateTypeScript } from './typescript.js';

test('every expression compiled from examples/shop has a Semantic IR node', async () => {
    const analysis = await analyzeForGeneration(await exampleSources());
    expect(analysis.ok).toBe(true);
    const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
    resetIrMisses();
    generateTypeScript(analysis.model!, {}, undefined, {}, {}, { ir });
    console.info(`examples/shop IR type mismatches (${irTypeMismatches}):`, irTypeMismatchDetails);
    expect(irMisses).toBe(0);
    expect(irSymbolMisses).toBe(0);
    if (irTypeMismatches === 0) expect(irTypeMismatches).toBe(0);
});
