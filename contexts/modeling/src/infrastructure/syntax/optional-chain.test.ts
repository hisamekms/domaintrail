// `x?.f` and `a ?? b` (Phase 2, null safety): types, narrowing and errors.
import { describe, expect, test } from 'bun:test';
import { analyzeDomain } from '../../application/analyze.js';

const model = (members: string) => `context N {
  value Address { city: String  zip: String? }
  value V {
    address: Address?
    note: String?
    fallback: String
    n: Int
${members}
  }
}`;

async function errors(members: string): Promise<string[]> {
    const a = await analyzeDomain([{ path: 'n.dt', text: model(members) }]);
    return a.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
}

describe('optional chaining and coalescing', () => {
    test('valid uses', async () => {
        expect(
            await errors(`    invariant a { (address?.city ?? "") != "x" }
    invariant b { (note ?? fallback).length > 0 }
    invariant c { address?.zip == null || address.zip.length == 5 }
    invariant d { address?.city != null && address.city.length > 0 }
    invariant e { (address?.zip ?? note ?? fallback) != "" }`),
        ).toEqual([]);
    });

    test('`?.` on a value that is always present, `??` on one, and `??` of two types are errors', async () => {
        expect(
            await errors(`    invariant a { fallback?.length }
    invariant b { (fallback ?? "x") != "" }
    invariant c { (note ?? n) != "" }
    invariant d { address?.city.length > 0 }`),
        ).toEqual([
            "M001 '?.' reads a field of an optional value; compare it with null first to call '.length'.",
            "M009 '??' gives the left operand when it is present, but 'String' is always present.",
            "M009 '??' gives 'String' or 'Int': both sides must have the same type.",
            "M009 '.length' is the size of a list or a string, not of 'String?'.",
        ]);
    });
});
