import { expect, test } from 'bun:test';
import { semanticIROf } from '@domaintrail/modeling';
import { analyzeForGeneration, exampleSources } from '../test-helpers.js';
import { irMisses, irSymbolMisses, resetIrMisses } from './checks.js';
import { generateTypeScript } from './typescript.js';

test('every expression compiled from examples/shop has a Semantic IR node', async () => {
    const analysis = await analyzeForGeneration(await exampleSources());
    expect(analysis.ok).toBe(true);
    const ir = semanticIROf(analysis);
    resetIrMisses();
    generateTypeScript(analysis.model!, {}, undefined, {}, {}, { ir });
    expect(irMisses).toBe(0);
    expect(irSymbolMisses).toBe(0);
});
