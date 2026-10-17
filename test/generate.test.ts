import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { analyze } from '../src/core/analyze.js';
import { loadWorkspace } from '../src/core/files.js';
import { generateTypeScript } from '../src/generator/typescript.js';
import { EXAMPLES } from './helpers.js';

const TSC = path.join(import.meta.dir, '..', 'node_modules', '.bin', 'tsc');
let dir: string;

/** Type-checks `files` (relative to the temp project) together with the generated code. */
function tsc(...files: string[]): { code: number; output: string } {
    const r = Bun.spawnSync(
        [process.execPath, TSC, '--noEmit', '--strict', '--target', 'ES2023', '--module', 'preserve', '--moduleResolution', 'bundler', '--lib', 'ES2023,DOM', ...files],
        { cwd: dir },
    );
    return { code: r.exitCode, output: r.stdout.toString() + r.stderr.toString() };
}

beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-gen-'));
    const a = await analyze(await loadWorkspace(EXAMPLES));
    expect(a.ok).toBe(true);
    await mkdir(path.join(dir, 'generated', 'domain'), { recursive: true });
    for (const f of generateTypeScript(a.model!)) await writeFile(path.join(dir, 'generated', 'domain', f.path), f.content);
    await mkdir(path.join(dir, 'src'));
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('generated TypeScript', () => {
    test('state-specific fields and the state union are reflected', async () => {
        const sales = await readFile(path.join(dir, 'generated', 'domain', 'Sales.ts'), 'utf8');
        expect(sales).toMatch(/export interface ConfirmedOrder extends OrderCommon \{\n    readonly state: 'Confirmed';\n(    \/\*\*.*\*\/\n)?    readonly confirmedAt: Timestamp;\n\}/);
        expect(sales).toContain('export type Order = DraftOrder | ConfirmedOrder | CancelledOrder;');
        expect(sales).not.toMatch(/interface DraftOrder[^}]*confirmedAt/);
    });

    test('command contracts narrow input/output states, events and errors', async () => {
        const sales = await readFile(path.join(dir, 'generated', 'domain', 'Sales.ts'), 'utf8');
        expect(sales).toContain(
            'export type ConfirmOrder = (\n    order: DraftOrder,\n    at: Timestamp,\n) => Result<readonly [ConfirmedOrder, readonly OrderConfirmed[]], EmptyOrder>;',
        );
        expect(sales).toContain('order: DraftOrder | ConfirmedOrder,');
        // no events -> readonly never[]; factory -> no aggregate parameter
        expect(sales).toContain('Result<readonly [DraftOrder, readonly never[]], never>');
        expect(sales).toContain('export type PlaceOrder = (\n    customer: CustomerId,\n)');
    });

    test('the generated code and the example implementation compile', async () => {
        await writeFile(path.join(dir, 'src', 'order-commands.ts'), await readFile(path.join(EXAMPLES, 'src', 'order-commands.ts'), 'utf8'));
        const r = tsc('src/order-commands.ts', 'generated/domain/index.ts');
        expect(r.output).toBe('');
        expect(r.code).toBe(0);
    });

    test('contract violations are rejected by the TypeScript compiler', async () => {
        await writeFile(
            path.join(dir, 'src', 'violations.ts'),
            `import { err, ok, type Sales } from '../generated/domain/index.js';
declare const draft: Sales.DraftOrder;
declare const confirmed: Sales.ConfirmedOrder;
declare const at: Date;

type ConfirmResult = ReturnType<Sales.ConfirmOrder>;

export function stateFieldScope(order: Sales.DraftOrder): void {
    // @ts-expect-error state-specific field is not available on a DraftOrder
    order.confirmedAt;
}
export function wrongOutputState(order: Sales.DraftOrder): ConfirmResult {
    // @ts-expect-error output state must be Confirmed
    return ok([{ ...order, state: 'Cancelled', reason: 'Other' }, []] as const);
}
export function undeclaredError(): ConfirmResult {
    // @ts-expect-error error type not declared by the command
    return err({ type: 'AlreadyPaid', paidAt: at });
}
export function undeclaredEvent(c: Sales.ConfirmedOrder): ConfirmResult {
    // @ts-expect-error event not declared in emits
    return ok([c, [{ type: 'OrderCancelled', orderId: c.id, reason: 'Other' }]] as const);
}
export function declaredOnly(order: Sales.DraftOrder, when: Date): ConfirmResult {
    if (order.items.length === 0) return err({ type: 'EmptyOrder' });
    const c: Sales.ConfirmedOrder = { ...order, state: 'Confirmed', confirmedAt: when };
    return ok([c, []] as const); // emitting zero events is allowed
}

declare const commands: Sales.OrderCommands;
// @ts-expect-error confirm accepts only Draft orders
commands.confirm(confirmed, at);
commands.confirm(draft, at);
// cancel accepts Draft | Confirmed
commands.cancel(confirmed, 'Requested');

const r = commands.addItem(draft, draft.items[0]);
if (r.ok) {
    const [, events] = r.value;
    // @ts-expect-error a command without emits returns readonly never[]
    events[0].type;
}
// @ts-expect-error IDs are branded and not interchangeable
const wrongId: Sales.OrderId = draft.customer;
`,
        );
        const r = tsc('src/violations.ts');
        expect(r.output).toBe('');
        expect(r.code).toBe(0);
    });
});
