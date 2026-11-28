/**
 * `dt migrate domain` on a workspace: after the syntax and the `changes` completion, the versioned steps newer than the
 * workspace's language version, once: the comparisons of owned entities rewritten to their `id` (ADR 0042), listed per
 * site. The version reached is recorded in domaintrail.jsonc, except with `--dry-run` or files given.
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

async function workspace(config?: string): Promise<{ dir: string; file: string; config: string }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-migrate-domain-'));
    dirs.push(dir);
    if (config !== undefined) await writeFile(path.join(dir, 'domaintrail.jsonc'), config);
    await writeFile(path.join(dir, 'order.dt'), ORDER);
    return { dir, file: path.join(dir, 'order.dt'), config: path.join(dir, 'domaintrail.jsonc') };
}

const MIGRATED = ORDER.replace('lines.unique() and lines.every(l => l == l)', 'lines.unique(l => l.id) && lines.every(l => l.id == l.id)');

test('a workspace without a language version: every step runs, once, and the version is recorded', async () => {
    const { dir, file, config } = await workspace();
    // --dry-run writes nothing and records nothing
    const dry = await run('-r', dir, 'migrate', 'domain', '--dry-run');
    expect(await readFile(file, 'utf8')).toBe(ORDER);
    expect(dry.out).toEqual([
        'order.dt:11 - and → &&',
        'order.dt:11 - xs.unique() → xs.unique(l => l.id)',
        'order.dt:11 - a == b → a.id == b.id',
        "1 file(s): 3 construct(s) to rewrite, 0 outcome(s) to complete in 'changes', in 1 file(s), 0 not parsed.",
        'Language version 0 → 1, to record in domaintrail.jsonc.',
    ]);
    expect(await Bun.file(config).exists()).toBe(false);
    // the real run: one file changed by two steps is one file
    const r = await run('-r', dir, 'migrate', 'domain');
    expect(r.code).toBe(0);
    expect(r.out.slice(-2)).toEqual([
        "1 file(s): 3 construct(s) rewritten, 0 outcome(s) completed in 'changes', in 1 file(s), 0 not parsed.",
        'Language version 0 → 1, recorded in domaintrail.jsonc: a later run does not repeat these steps.',
    ]);
    expect(await readFile(file, 'utf8')).toBe(MIGRATED);
    expect(JSON.parse(await readFile(config, 'utf8'))).toEqual({ language: 1 });
    // a structural `==` written afterwards stays: the entity step has run
    const structural = MIGRATED.replace('l.id == l.id', 'l == l');
    await writeFile(file, structural);
    const again = await run('-r', dir, 'migrate', 'domain');
    expect(again.out).toEqual(["1 file(s): 0 construct(s) rewritten, 0 outcome(s) completed in 'changes', in 0 file(s), 0 not parsed."]);
    expect(await readFile(file, 'utf8')).toBe(structural);
});

test("the version goes into the workspace's config file, its comments kept; files given record nothing", async () => {
    const { dir, file, config } = await workspace('{\n  // the shop\n  "sources": ["**/*.dt"]\n}\n');
    const some = await run('-r', dir, 'migrate', 'domain', file);
    expect(some.err).toEqual(['Language version not recorded (0, current 1): run `dt migrate domain` without files to migrate the whole workspace.']);
    expect(await readFile(file, 'utf8')).toBe(MIGRATED);
    expect(await readFile(config, 'utf8')).toBe('{\n  // the shop\n  "sources": ["**/*.dt"]\n}\n');
    await run('-r', dir, 'migrate', 'domain');
    expect(await readFile(config, 'utf8')).toBe('{\n  "language": 1,\n  // the shop\n  "sources": ["**/*.dt"]\n}\n');
});

test('a workspace at the current version runs no versioned step', async () => {
    const { dir, file } = await workspace('{ "language": 1 }\n');
    const r = await run('-r', dir, 'migrate', 'domain');
    expect(r.out).toEqual(['order.dt:11 - and → &&', "1 file(s): 1 construct(s) rewritten, 0 outcome(s) completed in 'changes', in 1 file(s), 0 not parsed."]);
    expect(await readFile(file, 'utf8')).toBe(ORDER.replace(' and ', ' && '));
});
