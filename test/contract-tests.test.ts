import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runCli } from '../src/cli/main.js';
import { generateTypeScript } from '../src/generator/typescript.js';
import { check, tempCopyOfExamples } from './helpers.js';

const ROOT = path.join(import.meta.dir, '..');
const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const TSC_FLAGS = [
    '--ignoreConfig',
    '--noEmit',
    '--strict',
    '--noUnusedLocals',
    '--noUnusedParameters',
    '--target',
    'ES2023',
    '--module',
    'preserve',
    '--moduleResolution',
    'bundler',
    '--verbatimModuleSyntax',
    '--types',
    'bun',
    '--lib',
    'ES2023,DOM',
];

/** Type-checks files strictly; `exact` adds `exactOptionalPropertyTypes` (which the generated tests are written for). */
function tsc(dir: string, files: string[], exact = true): string {
    const flags = exact ? [...TSC_FLAGS, '--exactOptionalPropertyTypes'] : TSC_FLAGS;
    const r = Bun.spawnSync([process.execPath, path.join(ROOT, 'node_modules', '.bin', 'tsc'), ...flags, ...files], { cwd: dir });
    return r.stdout.toString() + r.stderr.toString();
}

/** A temporary directory that resolves fast-check from this repository. */
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-contract-'));
    dirs.push(dir);
    await symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
    return dir;
}

const MODEL = {
    'shop.dt': `
context Shop {
  id CartId: UUID

  primitive Qty: Int { value in 1..10 }

  primitive Code: String {
    invariant format { matches(value, "^[A-Z]{2}[0-9]$") }
    invariant reserved "予約語でない"
    invariant short { length(value) <= 3 }
  }

  value Line {
    code: Code
    qty: Qty
  }

  aggregate Cart {
    id: CartId
    lines: Line[0..*]

    invariant distinctCodes { unique(lines, l => l.code) }

    state Open

    state Closed {
      total: Int

      invariant positive { total > 0 }
    }

    create command start(id: CartId)
      -> Open
      emits Opened

    command add(line: Line, limit: Int)
      Open -> Open
      requires fresh { all(lines, l => l.code != line.code) } else Duplicate
      requires underLimit { count(lines) < limit } else Full
      requires allowed "許可された商品" else Forbidden
      changes lines
      emits Added[2..3]

    command close()
      Open -> Closed
      requires notEmpty { count(lines) > 0 } else Empty
  }

  event Opened {
    cart: CartId
  }

  event Added {
    cart: CartId
  }

  error Duplicate
  error Full
  error Forbidden
  error Empty
}
`,
};

const dir = await tempDir();
{
    const a = await check(MODEL);
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    for (const f of generateTypeScript(a.model!, {}, { dir: 'tests', runner: 'bun' })) {
        await mkdir(path.dirname(path.join(dir, f.path)), { recursive: true });
        await writeFile(path.join(dir, f.path), f.content);
    }
}
const domain = await import(path.join(dir, 'index.ts'));
const tests = await import(path.join(dir, 'tests', 'index.ts'));
const { Shop, decide, ok, err } = domain;

const forbidden = (code: string): boolean => code.startsWith('Z');
const added = (cart: { id: string }, n: number) => ({ Added: Array.from({ length: n }, () => ({ type: 'Added', cart: cart.id })) });

/** A correct implementation; `change` replaces some of its parts. */
function cart(change: Record<string, unknown> = {}) {
    return {
        start: decide(Shop.CartShape, (id: string) => ok({ Open: { set: { id, lines: [] }, events: { Opened: { type: 'Opened', cart: id } } } })),
        add: decide(Shop.CartShape, {
            Open: (c: any, line: any, limit: number) => {
                if (c.lines.some((l: any) => l.code === line.code)) return err({ type: 'Duplicate' });
                if (!(c.lines.length < limit)) return err({ type: 'Full' });
                if (forbidden(line.code)) return err({ type: 'Forbidden' });
                return ok({ Open: { set: { lines: [...c.lines, line] }, events: added(c, 2) } });
            },
        }),
        close: decide(Shop.CartShape, {
            Open: (c: any) => {
                if (c.lines.length === 0) return err({ type: 'Empty' });
                return ok({ Closed: { set: { total: c.lines.reduce((n: number, l: any) => n + l.qty, 0) }, events: {} } });
            },
        }),
        ...change,
    };
}

const makeQty = (v: number) => (v >= 1 && v <= 10 ? ok(v) : err({ type: 'InvalidQty', value: v, invariant: 'valid' }));
const makeCode = (v: string) => {
    if (!/^[A-Z]{2}[0-9]$/.test(v)) return err({ type: 'InvalidCode', value: v, invariant: 'format' });
    if (v === 'AA0') return err({ type: 'InvalidCode', value: v, invariant: 'reserved' });
    if (v.length > 3) return err({ type: 'InvalidCode', value: v, invariant: 'short' });
    return ok(v);
};

/** Runs every case of a suite: the error message of each that fails, by name; todo cases as 'todo'. */
async function run(suite: unknown): Promise<Record<string, string | undefined>> {
    const out: Record<string, string | undefined> = {};
    for (const c of tests.cases(suite)) {
        if (c.todo) {
            out[c.name] = 'todo';
            continue;
        }
        try {
            await c.run();
            out[c.name] = undefined;
        } catch (e) {
            out[c.name] = (e as Error).message;
        }
    }
    return out;
}

const failing = (r: Record<string, string | undefined>): string[] => Object.keys(r).filter((k) => r[k] !== undefined && r[k] !== 'todo');
const todos = (r: Record<string, string | undefined>): string[] => Object.keys(r).filter((k) => r[k] === 'todo');
const contract = (impl: object, options: object = {}) => tests.Shop.contract(impl, options);

describe('generated contract tests', () => {
    test('type-check strictly, with the bun adapter', () => {
        expect(tsc(dir, ['index.ts', 'tests/index.ts', 'tests/_register.ts', 'tests/Shop.ts'])).toBe('');
    });

    test('pass for a correct implementation, with todo cases for the constraints without an expression', async () => {
        const r = await run(contract({ make: { Qty: makeQty, Code: makeCode, CartId: (v: string) => v }, Cart: cart() }));
        expect(failing(r)).toEqual([]);
        expect(todos(r)).toEqual([
            "Shop > domain primitives > invariant 'reserved' of Shop.Code is not expressed in the DSL and not checked: pass a check in options.declared",
            "Shop > Cart > requirement 'allowed' of Cart.add is not expressed in the DSL and not checked: pass a check in options.declared",
        ]);
        expect(Object.keys(r)).toEqual(
            expect.arrayContaining([
                'Shop > domain primitives > makeQty accepts exactly the values that hold the invariants of Qty, reporting the first one violated',
                'Shop > Cart > Cart.add returns the error of the first requirement that does not hold, and none of their errors when all hold',
                'Shop > Cart > Cart.close makes an aggregate that holds the invariants of its state',
                'Shop > Cart > Cart.add emits Added[2..3] as many times as declared',
                'Shop > Cart > Cart.start is pure: the same input gives the same result, and the input is not changed',
            ]),
        );
    });

    test('the declared checks passed in are tested like the generated ones', async () => {
        const declared = {
            Shop: { Code: { reserved: (v: string) => v !== 'AA0' }, AddCart: { allowed: (_c: unknown, line: { code: string }) => !forbidden(line.code) } },
        };
        const r = await run(contract({ make: { Code: makeCode }, Cart: cart() }, { declared }));
        expect(failing(r)).toEqual([]);
        expect(todos(r)).toEqual([]);
        // an implementation that ignores `allowed` is now caught
        const lax = cart({
            add: decide(Shop.CartShape, { Open: (c: any, line: any) => ok({ Open: { set: { lines: [...c.lines, line] }, events: added(c, 2) } }) }),
        });
        expect(
            failing(
                await run(
                    contract(
                        { Cart: lax },
                        { declared, examples: { Cart: { commands: { add: [[{ state: 'Open', id: 'c', lines: [] }, { code: 'ZZ1', qty: 1 }, 5]] } } } },
                    ),
                ),
            ),
        ).toContain('Shop > Cart > Cart.add returns the error of the first requirement that does not hold, and none of their errors when all hold');
    });

    test('T1 catches a constructor with an off-by-one range, and one that reports the wrong invariant', async () => {
        const offByOne = (v: number) => (v >= 1 && v <= 11 ? ok(v) : err({ type: 'InvalidQty', value: v, invariant: 'valid' }));
        const r1 = await run(contract({ make: { Qty: offByOne } }));
        expect(failing(r1)).toHaveLength(1);
        expect(Object.values(r1).join()).toContain("makeQty(11) accepted a value that violates 'valid'");
        const wrongOrder = (v: string) => (v.length > 3 ? err({ type: 'InvalidCode', value: v, invariant: 'short' }) : makeCode(v));
        const r2 = await run(contract({ make: { Code: wrongOrder } }));
        expect(Object.values(r2).join()).toMatch(
            /returned the error \{"type":"InvalidCode","value":".*","invariant":"short"\}; expected \{ type: 'InvalidCode', value: ".*", invariant: 'format' \}/,
        );
    });

    test('T2 catches requirements checked in the wrong order, a missing one, and an error returned although all hold', async () => {
        const name = 'Shop > Cart > Cart.add returns the error of the first requirement that does not hold, and none of their errors when all hold';
        const add = (body: (c: any, line: any, limit: number) => unknown) => cart({ add: decide(Shop.CartShape, { Open: body }) });
        const swapped = add((c, line, limit) => {
            if (!(c.lines.length < limit)) return err({ type: 'Full' });
            if (c.lines.some((l: any) => l.code === line.code)) return err({ type: 'Duplicate' });
            return ok({ Open: { set: { lines: [...c.lines, line] }, events: added(c, 2) } });
        });
        expect((await run(contract({ Cart: swapped })))[name]).toContain("requirement 'fresh' is the first that does not hold: expected Duplicate");
        const missing = add((c, line) => ok({ Open: { set: { lines: [...c.lines, line] }, events: added(c, 2) } }));
        expect((await run(contract({ Cart: missing })))[name]).toContain('succeeded, but requirement');
        const strict = add((c) => (c.lines.length > 2 ? err({ type: 'Full' }) : ok({ Open: { set: { lines: c.lines }, events: added(c, 2) } })));
        expect((await run(contract({ Cart: strict })))[name]).toBeDefined();
    });

    test('T3 catches an aggregate that violates the invariants of its target state', async () => {
        const zero = cart({
            close: decide(Shop.CartShape, { Open: (c: any) => (c.lines.length ? ok({ Closed: { set: { total: 0 }, events: {} } }) : err({ type: 'Empty' })) }),
        });
        const r = await run(contract({ Cart: zero }));
        expect(failing(r)).toEqual(['Shop > Cart > Cart.close makes an aggregate that holds the invariants of its state']);
        expect(Object.values(r).join()).toContain("made an aggregate that violates 'positive'");
    });

    test('T4 catches an event count outside bounds the types cannot express', async () => {
        const once = cart({
            add: decide(Shop.CartShape, {
                Open: (c: any, line: any, limit: number) =>
                    c.lines.some((l: any) => l.code === line.code)
                        ? err({ type: 'Duplicate' })
                        : c.lines.length >= limit
                          ? err({ type: 'Full' })
                          : forbidden(line.code)
                            ? err({ type: 'Forbidden' })
                            : ok({ Open: { set: { lines: [...c.lines, line] }, events: added(c, 1) } }),
            }),
        });
        const r = await run(contract({ Cart: once }));
        expect(failing(r)).toEqual(['Shop > Cart > Cart.add emits Added[2..3] as many times as declared']);
        expect(Object.values(r).join()).toContain('emitted Added 1 times; declared Added[2..3]');
    });

    test('T5 catches randomness and a changed input', async () => {
        const random = cart({
            start: decide(Shop.CartShape, (id: string) =>
                ok({
                    Open: {
                        set: { id, lines: Math.random() < 2 ? [{ code: `A${Math.floor(Math.random() * 1e9)}`, qty: 1 }] : [] },
                        events: { Opened: { type: 'Opened', cart: id } },
                    },
                }),
            ),
        });
        expect(failing(await run(contract({ Cart: random })))).toContain(
            'Shop > Cart > Cart.start is pure: the same input gives the same result, and the input is not changed',
        );
        const mutating = cart({
            close: decide(Shop.CartShape, {
                Open: (c: any) => {
                    if (c.lines.length === 0) return err({ type: 'Empty' });
                    c.lines.push(c.lines[0]);
                    return ok({ Closed: { set: { total: 1 }, events: {} } });
                },
            }),
        });
        const r = await run(contract({ Cart: mutating }));
        expect(r['Shop > Cart > Cart.close is pure: the same input gives the same result, and the input is not changed']).toContain('changed its input');
    });

    test('are deterministic: the same seed gives the same failure, and the seed is an option', async () => {
        const zero = cart({ close: decide(Shop.CartShape, { Open: () => ok({ Closed: { set: { total: 0 }, events: {} } }) }) });
        // the messages without the stack traces of the errors they report
        const messages = async (options: object = {}) =>
            Object.values(await run(contract({ Cart: zero }, options)))
                .map((m) => m?.replace(/^\s+at .*$/gm, ''))
                .join('\n');
        const a = await messages();
        expect(a).toBe(await messages());
        expect(a).toContain('seed: 42');
        expect(await messages({ seed: 7 })).toContain('seed: 7');
    });

    test('examples run first; an example that violates the invariants is reported', async () => {
        const bad = {
            state: 'Open',
            id: 'c',
            lines: [
                { code: 'AB1', qty: 1 },
                { code: 'AB1', qty: 2 },
            ],
        };
        const r = await run(contract({ Cart: cart() }, { examples: { Cart: { commands: { close: [[bad]] } } } }));
        expect(Object.values(r).join()).toContain("Example 1 of Cart.close: the aggregate violates 'distinctCodes'");
        const r2 = await run(contract({ Cart: cart() }, { examples: { Cart: { states: { Open: [bad] } } } }));
        expect(Object.values(r2).join()).toContain("Example 1 of Shop.OpenCart violates 'distinctCodes'");
    });

    test('an override that rarely holds the invariants names the type to override', async () => {
        const fc = await import('fast-check');
        const r = await run(contract({ Cart: cart() }, { arbitraries: { Shop: { Qty: fc.integer({ min: 100, max: 1_000_000 }) } } }));
        expect(Object.values(r).join()).toContain(
            'Generating values of Shop.Qty that hold its invariants failed 1000 times in a row. Pass an arbitrary for it: options.arbitraries = { Shop: { Qty: … } }.',
        );
    });
});

describe('the shop example', () => {
    test('generates contract tests that pass against its implementation with bun:test', async () => {
        const shop = await tempCopyOfExamples();
        dirs.push(shop);
        await symlink(path.join(ROOT, 'node_modules'), path.join(shop, 'node_modules'));
        expect(await runCli(['-r', shop, 'generate', 'ts'], { out: () => {}, err: () => {} })).toBe(0);
        const manifest = JSON.parse(await readFile(path.join(shop, '.domaintrail', 'generated.json'), 'utf8'));
        expect(manifest.files).toEqual(
            expect.arrayContaining([
                'generated/domain/tests/_testing.ts',
                'generated/domain/tests/_register.ts',
                'generated/domain/tests/Sales.ts',
                'generated/domain/tests/index.ts',
            ]),
        );
        // all of src/ (domain, application, demo, tests), with the example's own tsconfig.json
        const typecheck = Bun.spawnSync([process.execPath, path.join(ROOT, 'node_modules', '.bin', 'tsc'), '-p', shop]);
        expect(typecheck.stdout.toString() + typecheck.stderr.toString()).toBe('');
        const r = Bun.spawnSync([process.execPath, 'test'], { cwd: shop });
        const output = r.stdout.toString() + r.stderr.toString();
        expect(output).toContain(' 0 fail');
        expect(output).toMatch(/Ran \d+ tests across 2 files/);
        expect(r.exitCode).toBe(0);
        const demo = Bun.spawnSync([process.execPath, 'src/demo.ts'], { cwd: shop });
        expect(demo.stderr.toString()).toBe('');
        expect(demo.stdout.toString()).toContain('policy BillConfirmedOrder: issued invoice-1 for order-1: 3380 JPY');
        expect(demo.exitCode).toBe(0);
    }, 30_000);
});
