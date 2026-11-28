import { expect, test } from 'bun:test';
import { semanticIROf } from '@domaintrail/modeling';
import { analyzeForGeneration, check, exampleSources, generateFromAnalysis } from '../test-helpers.js';
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

test('every expression of changes x = e and ensures, before and after included, has a Semantic IR node and symbol', async () => {
    const analysis = await check({
        'r.dt': `context R {
  id RotaId: UUID
  value Shift { hours: Int }
  aggregate Rota {
    id: RotaId
    revision: Int
    shifts: Shift[0..*]
    initial Draft
    state Draft
    state Published { publishedAt: Timestamp }
    create command open(id: RotaId) {
      outcome opened: -> Draft
        changes id = id, revision = 0, shifts = []
    }
    command addShift(shift: Shift) {
      outcome added: Draft -> Draft
        changes shifts = [...before.shifts, shift], revision
        ensures { after.revision > before.revision && after.shifts.every(s => s.hours > 0) }
    }
    command publish(at: Timestamp) Draft -> Published
      changes publishedAt = at, revision = before.revision + 1
      ensures { after.shifts.length == before.shifts.length }
  }
}`,
    });
    expect(analysis.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)).toEqual([]);
    resetIrMisses();
    const code = generateFromAnalysis(analysis).find((f) => f.path === 'R.ts')!.content;
    expect(code).toContain('export function checkAddShiftRotaEnsures(');
    expect(code).toContain('export function checkPublishRotaEnsures(');
    expect(irMisses).toBe(0);
    expect(irSymbolMisses).toBe(0);
});
