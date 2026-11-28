// `match` (Phase 2, A0 form): one case per variant of a union, fields bound by name, checked and generated.
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { check, generateFromAnalysis } from '../test-helpers.js';

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const MODEL = (cases: string) => `context M {
  union Shift {
    Staffed { hours: Int  staff: Int }
    Open { hours: Int }
    Closed
  }
  value Day {
    shift: Shift
    limit: Int
    invariant withinLimit { match (shift) { ${cases} } <= limit }
  }
}`;

test('a match checks, generates nested conditionals on the discriminator, and evaluates', async () => {
    const a = await check({ 'm.dt': MODEL('Staffed { hours, staff } => hours * staff, Open { hours } => hours, Closed => 0') });
    expect(a.diagnostics).toEqual([]);
    const files = generateFromAnalysis(a);
    const ts = files.find((f) => f.path === 'M.ts')!.content;
    expect(ts).toContain("(day.shift.kind === 'Staffed' ? (day.shift.hours * day.shift.staff) : day.shift.kind === 'Open' ? day.shift.hours : 0) <= day.limit");
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-match-'));
    dirs.push(dir);
    for (const f of files) await writeFile(path.join(dir, f.path), f.content);
    const { M } = await import(path.join(dir, 'index.ts'));
    expect(M.checkDay({ shift: { kind: 'Staffed', hours: 8, staff: 2 }, limit: 16 })).toEqual([]);
    expect(M.checkDay({ shift: { kind: 'Staffed', hours: 8, staff: 3 }, limit: 16 })).toEqual(['withinLimit']);
    expect(M.checkDay({ shift: { kind: 'Open', hours: 20 }, limit: 16 })).toEqual(['withinLimit']);
    expect(M.checkDay({ shift: { kind: 'Closed' }, limit: 0 })).toEqual([]);
});

test('match errors: a missing variant, an unknown one, a duplicate, an unknown field, mixed types', async () => {
    const errors = async (cases: string) => (await check({ 'm.dt': MODEL(cases) })).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
    expect(await errors('Staffed { hours } => hours, Open { hours } => hours')).toEqual(["'match' over 'Shift' has no case for 'Closed'."]);
    expect(await errors('Staffed { hours } => hours, Open { hours } => hours, Closed => 0, Gone => 0')).toEqual(["Union 'Shift' has no variant 'Gone'."]);
    expect(await errors('Staffed { hours } => hours, Open { hours } => hours, Open => 1, Closed => 0')).toEqual(["Variant 'Open' has two cases."]);
    expect(await errors('Staffed { minutes } => 1, Open { hours } => hours, Closed => 0')).toEqual(["Variant 'Staffed' has no field 'minutes'."]);
    expect(await errors('Staffed { hours } => hours, Open { hours } => "x", Closed => 0')).toEqual([
        "The cases of 'match' give 'Int' and 'String': every case must have the same type.",
    ]);
});
