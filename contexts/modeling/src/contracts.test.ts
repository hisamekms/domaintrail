// The arbitraries generated from Modeling's model (contexts/modeling/src/generated/tests): Modeling implements no
// constructor or command the contract tests could run, but its types include a recursive one (`ExprModel`, an
// expression of the DSL), whose values the contract tests of other code would draw. Every arbitrary draws values that
// hold their invariants, and expressions nest up to the default depth (ADR 0028, decision 8).
import { describe, expect, test } from 'bun:test';
import * as fc from 'fast-check';
import type { Modeling as M } from './generated/index.js';
import { Modeling } from './generated/tests/index.js';

/** How many expressions a value nests through (a value of depth 1 holds no other). */
function depth(e: M.ExprModel): number {
    const inner = Object.values(e).flatMap((v): unknown[] => (Array.isArray(v) ? v : [v]));
    const exprs = inner.filter((v): v is M.ExprModel => typeof v === 'object' && v !== null && 'k' in v);
    return 1 + Math.max(0, ...exprs.map(depth));
}

describe("Modeling's generated arbitraries", () => {
    const arbitraries = Modeling.arbitraries();

    test('every type draws values', () => {
        for (const [name, arb] of Object.entries(arbitraries)) expect([name, fc.sample(arb, { seed: 1, numRuns: 20 }).length]).toEqual([name, 20]);
    });

    test('expressions nest, up to the default depth of 4', () => {
        const depths = fc.sample(arbitraries.ExprModel, { seed: 1, numRuns: 300 }).map(depth);
        expect([Math.min(...depths), Math.max(...depths)]).toEqual([1, 4]);
    });
});
