import { expect, test } from 'bun:test';
import { buildSemanticIR } from '@domaintrail/modeling';
import { analyzeForGeneration, exampleSources } from '../test-helpers.js';
import { irMisses, resetIrMisses } from './checks.js';
import { generateTypeScript } from './typescript.js';

test('every expression compiled from examples/shop has a Semantic IR node', async () => {
    const analysis = await analyzeForGeneration(await exampleSources());
    expect(analysis.ok).toBe(true);
    const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
    resetIrMisses();
    generateTypeScript(analysis.model!, {}, undefined, {}, {}, { ir });
    expect(irMisses).toBe(0);
});
