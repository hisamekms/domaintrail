// The generated checks of `x?.f` and `a ?? b`: TypeScript's own operators.
import { expect, test } from 'bun:test';
import { check, generateFromAnalysis } from '../test-helpers.js';

test("`?.` and `??` compile to TypeScript's `?.` and `??`", async () => {
    const a = await check({
        'n.dt': `context N {
  value Address { city: String  zip: String? }
  value V {
    address: Address?
    note: String?
    fallback: String
    invariant a { (address?.city ?? "") != "x" }
    invariant b { (note ?? fallback).length > 0 }
    invariant c { address?.zip == null || address.zip.length == 5 }
  }
}`,
    });
    expect(a.diagnostics).toEqual([]);
    const ts = generateFromAnalysis(a).find((f) => f.path === 'N.ts')!.content;
    expect(ts).toContain("if (!(!((v.address?.city ?? '') === 'x'))) violated.push('a');");
    expect(ts).toContain('Array.from((v.note ?? v.fallback)).length > 0');
    expect(ts).toContain('v.address?.zip !== undefined && !(Array.from(v.address.zip).length === 5)');
});
