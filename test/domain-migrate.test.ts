/**
 * `dt migrate domain` on a workspace: after the syntax and the `changes` completion, the comparisons of owned entities
 * are rewritten to their `id` (ADR 0042), listed per site; `--dry-run` writes nothing and a second run rewrites nothing.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps, runCli } from '@domaintrail/dt';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, cliDeps());
    return { code, out, err };
}

const ORDER = `context Sales {
  id OrderId: UUID
  id LineId: UUID
  entity Line {
    id: LineId
    quantity: Int
  }
  aggregate Order {
    id: OrderId
    owns lines: Line[0..*]
    invariant distinctLines { lines.unique() and lines.every(l => l == l) }
  }
}
`;

test('dt migrate domain rewrites the comparisons of owned entities to their id, after the syntax', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-migrate-domain-'));
    dirs.push(dir);
    const file = path.join(dir, 'order.dt');
    await writeFile(file, ORDER);
    const dry = await run('-r', dir, 'migrate', 'domain', '--dry-run');
    expect(await readFile(file, 'utf8')).toBe(ORDER);
    expect(dry.out).toEqual([
        'order.dt:11 - and → &&',
        'order.dt:11 - xs.unique() → xs.unique(l => l.id)',
        'order.dt:11 - a == b → a.id == b.id',
        "1 file(s): 3 construct(s) to rewrite, 0 outcome(s) to complete in 'changes', in 1 file(s), 0 not parsed.",
    ]);
    const r = await run('-r', dir, 'migrate', 'domain');
    expect(r.code).toBe(0);
    expect(await readFile(file, 'utf8')).toBe(
        ORDER.replace('lines.unique() and lines.every(l => l == l)', 'lines.unique(l => l.id) && lines.every(l => l.id == l.id)'),
    );
    const again = await run('-r', dir, 'migrate', 'domain');
    expect(again.out.at(-1)).toBe("1 file(s): 0 construct(s) rewritten, 0 outcome(s) completed in 'changes', in 0 file(s), 0 not parsed.");
});
