import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { analyze } from '../src/core/analyze.js';
import { loadWorkspace } from '../src/core/files.js';
import { generateTypeScript } from '../src/generator/typescript.js';
import { EXAMPLES, check } from './helpers.js';

const TSC = path.join(import.meta.dir, '..', 'node_modules', '.bin', 'tsc');
let dir: string;

/** Type-checks `files` (relative to the temp project) together with the generated code. */
function tsc(...files: string[]): { code: number; output: string } {
    return tscIn(dir, ...files);
}

function tscIn(cwd: string, ...files: string[]): { code: number; output: string } {
    const r = Bun.spawnSync(
        [process.execPath, TSC, '--noEmit', '--strict', '--target', 'ES2023', '--module', 'preserve', '--moduleResolution', 'bundler', '--lib', 'ES2023,DOM', ...files],
        { cwd },
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
            `export type ConfirmOrder = (
    order: DraftOrder,
    at: Timestamp,
) => Result<{
    readonly Confirmed: {
        readonly aggregate: ConfirmedOrder;
        readonly events: { readonly OrderConfirmed: OrderConfirmed };
    };
}, EmptyOrder>;`,
        );
        // no events -> NoEvents; factory -> no aggregate parameter, the new ID passed in
        expect(sales).toContain('        readonly events: NoEvents;\n    };\n}, DuplicateSku>;');
        expect(sales).toContain("import type { NoEvents, Result, Timestamp } from './_runtime.js';");
        expect(sales).toContain('export type PlaceOrder = (\n    id: OrderId,\n    customer: CustomerId,\n)');
        // an aggregate without states: keyed by the aggregate's name
        expect(sales).toContain(') => Result<{\n    readonly Customer: {\n        readonly aggregate: Customer;\n');
        expect(sales).toContain(' * Commands are pure functions of the aggregate and their parameters: no I/O, no clock, no randomness.');
    });

    test('the generated code and the example implementation compile', async () => {
        for (const f of ['order-commands.ts', 'primitives.ts']) await writeFile(path.join(dir, 'src', f), await readFile(path.join(EXAMPLES, 'src', f), 'utf8'));
        const r = tsc('src/order-commands.ts', 'src/primitives.ts', 'generated/domain/index.ts');
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
const confirmedEvent = (order: Sales.DraftOrder): Sales.OrderConfirmed => ({ type: 'OrderConfirmed', orderId: order.id, confirmedAt: at });

export function stateFieldScope(order: Sales.DraftOrder): void {
    // @ts-expect-error state-specific field is not available on a DraftOrder
    order.confirmedAt;
}
export function wrongOutputState(order: Sales.DraftOrder): ConfirmResult {
    // @ts-expect-error the outcome of confirm is Confirmed
    return ok({ Cancelled: { aggregate: { ...order, state: 'Cancelled', reason: 'Other' }, events: { OrderConfirmed: confirmedEvent(order) } } });
}
export function wrongAggregate(order: Sales.DraftOrder): ConfirmResult {
    // @ts-expect-error the aggregate of the Confirmed outcome is a ConfirmedOrder
    return ok({ Confirmed: { aggregate: order, events: { OrderConfirmed: confirmedEvent(order) } } });
}
export function undeclaredError(): ConfirmResult {
    // @ts-expect-error error type not declared by the command
    return err({ type: 'AlreadyPaid', paidAt: at });
}
export function undeclaredEvent(order: Sales.DraftOrder): ConfirmResult {
    const c: Sales.ConfirmedOrder = { ...order, state: 'Confirmed', confirmedAt: at };
    // @ts-expect-error event not declared in emits
    return ok({ Confirmed: { aggregate: c, events: { OrderConfirmed: confirmedEvent(order), OrderCancelled: { type: 'OrderCancelled', orderId: c.id, reason: 'Other' } } } });
}
export function missingEvent(order: Sales.DraftOrder): ConfirmResult {
    const c: Sales.ConfirmedOrder = { ...order, state: 'Confirmed', confirmedAt: at };
    // @ts-expect-error emits OrderConfirmed: exactly one, so it cannot be left out
    return ok({ Confirmed: { aggregate: c, events: {} } });
}
export function twoEvents(order: Sales.DraftOrder): ConfirmResult {
    const c: Sales.ConfirmedOrder = { ...order, state: 'Confirmed', confirmedAt: at };
    // @ts-expect-error exactly one, not a list
    return ok({ Confirmed: { aggregate: c, events: { OrderConfirmed: [confirmedEvent(order), confirmedEvent(order)] } } });
}
export function declaredOnly(order: Sales.DraftOrder, when: Date): ConfirmResult {
    if (order.items.length === 0) return err({ type: 'EmptyOrder' });
    const c: Sales.ConfirmedOrder = { ...order, state: 'Confirmed', confirmedAt: when };
    return ok({ Confirmed: { aggregate: c, events: { OrderConfirmed: confirmedEvent(order) } } });
}
export const noEvents: Sales.OrderCommands['addItem'] = (order, item) =>
    // @ts-expect-error a command without emits emits nothing
    ok({ Draft: { aggregate: { ...order, items: [...order.items, item] }, events: { OrderPlaced: { type: 'OrderPlaced', orderId: order.id } } } });

declare const commands: Sales.OrderCommands;
// @ts-expect-error confirm accepts only Draft orders
commands.confirm(confirmed, at);
commands.confirm(draft, at);
// cancel accepts Draft | Confirmed
commands.cancel(confirmed, 'Requested');

const r = commands.addItem(draft, draft.items[0]);
if (r.ok) {
    const events = r.value.Draft.events;
    // @ts-expect-error a command without emits has no events
    events.OrderPlaced.type;
}
const c = commands.cancel(confirmed, 'Requested');
if (c.ok) {
    // RefundRequested when Confirmed ->: a Confirmed order emits it
    const refund: Sales.RefundRequested = c.value.Cancelled.events.RefundRequested;
}
const d = commands.cancel(draft, 'Requested');
if (d.ok) {
    // @ts-expect-error a Draft order does not
    d.value.Cancelled.events.RefundRequested;
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

describe('commands with several transitions', () => {
    const WORK = `context Tasks {
  id WorkId: UUID
  primitive Title: String
  event WorkChanged { workId: WorkId }
  error NotReady
  aggregate Work {
    id: WorkId
    title: Title
    state Draft
    state InProgress
    state Completed { completedAt: Timestamp }
    state Cancelled

    create command open(id: WorkId, title: Title) -> Draft
    command change(title: Title)
      Draft -> Draft
      InProgress -> InProgress
      emits WorkChanged
    command start() Draft -> InProgress
    command cancel() Draft -> Cancelled, InProgress -> Cancelled
    command review(at: Timestamp) InProgress -> InProgress | Completed, Draft -> Draft errors NotReady
    command step() Draft -> InProgress, InProgress -> Completed, Completed | Cancelled -> Cancelled
  }
}
`;
    let work: string;
    let code: string;

    beforeAll(async () => {
        work = await mkdtemp(path.join(tmpdir(), 'domaintrail-work-'));
        const a = await check({ 'tasks.dt': WORK });
        expect(a.diagnostics).toEqual([]);
        await mkdir(path.join(work, 'generated'));
        for (const f of generateTypeScript(a.model!)) await writeFile(path.join(work, 'generated', f.path), f.content);
        code = await readFile(path.join(work, 'generated', 'Tasks.ts'), 'utf8');
        await mkdir(path.join(work, 'src'));
    });

    afterAll(async () => {
        await rm(work, { recursive: true, force: true });
    });

    test('the same targets for every transition: a plain function of the union of the sources', () => {
        expect(code).toContain('/**\n * Work.cancel (Draft -> Cancelled; InProgress -> Cancelled)\n * @emits nothing\n */');
        expect(code).toContain(
            `export type CancelWork = (
    work: DraftWork | InProgressWork,
) => Result<{
    readonly Cancelled: {
        readonly aggregate: CancelledWork;
        readonly events: NoEvents;
    };
}, never>;`,
        );
        expect(code).toContain('/**\n * Work.open (new -> Draft) — factory\n * @emits nothing\n */');
    });

    test('targets that differ by transition: a handler per source state, and a contract generic over the input state', () => {
        expect(code).toContain('/**\n * Work.change (Draft -> Draft; InProgress -> InProgress)\n * @emits WorkChanged — exactly once when the command succeeds\n */');
        expect(code).toContain(
            `export type ChangeWork = <S extends DraftWork | InProgressWork>(
    work: S,
    title: Title,
) => ReturnType<ChangeWorkByState[S['state']]>;

/** Work.change, one handler per source state; implement it with \`byState\` from the runtime. */
export type ChangeWorkByState = {
    /** @emits WorkChanged — exactly once when the command succeeds */
    readonly Draft: (work: DraftWork, title: Title) => Result<{
        readonly Draft: {
            readonly aggregate: DraftWork;
            readonly events: { readonly WorkChanged: WorkChanged };
        };
    }, never>;
    /** @emits WorkChanged — exactly once when the command succeeds */
    readonly InProgress: (work: InProgressWork, title: Title) => Result<{
        readonly InProgress: {
            readonly aggregate: InProgressWork;
            readonly events: { readonly WorkChanged: WorkChanged };
        };
    }, never>;
};`,
        );
        // several outcomes: a union keyed by the target, each branch ruling out the other keys
        expect(code).toContain(
            `    readonly InProgress: (work: InProgressWork, at: Timestamp) => Result<
        | {
              readonly InProgress: {
                  readonly aggregate: InProgressWork;
                  readonly events: NoEvents;
              };
              readonly Completed?: never;
          }
        | {
              readonly Completed: {
                  readonly aggregate: CompletedWork;
                  readonly events: NoEvents;
              };
              readonly InProgress?: never;
          },
        NotReady
    >;`,
        );
        // several sources of one transition: a handler each, with the same output
        expect(code).toContain('    readonly Completed: (work: CompletedWork) => Result<{\n        readonly Cancelled: {\n            readonly aggregate: CancelledWork;');
        expect(code).toContain('    readonly Cancelled: (work: CancelledWork) => Result<{\n        readonly Cancelled: {\n            readonly aggregate: CancelledWork;');
        // the commands interface is unchanged
        expect(code).toContain('    readonly change: ChangeWork;');
    });

    test('no handlers per state for commands whose transitions share their targets, nor for factories', () => {
        expect(code).not.toMatch(/(Open|Start|Cancel)WorkByState/);
        expect([...code.matchAll(/export type (\w+ByState) =/g)].map((m) => m[1])).toEqual(['ChangeWorkByState', 'ReviewWorkByState', 'StepWorkByState']);
    });

    test('callers get the output of the transition of their input state; anything else is a compile error', async () => {
        await writeFile(
            path.join(work, 'src', 'use.ts'),
            `import { ok, type Tasks } from '../generated/index.js';
declare const commands: Tasks.WorkCommands;
declare const draft: Tasks.DraftWork;
declare const inProgress: Tasks.InProgressWork;
declare const either: Tasks.DraftWork | Tasks.InProgressWork;
declare const completed: Tasks.CompletedWork;
declare const title: Tasks.Title;

const a = commands.change(draft, title);
if (a.ok) {
    const stays: Tasks.DraftWork = a.value.Draft.aggregate;
    // @ts-expect-error a Draft work stays Draft: it never comes back InProgress
    a.value.InProgress;
}
const b = commands.change(inProgress, title);
if (b.ok) {
    const stays: Tasks.InProgressWork = b.value.InProgress.aggregate;
    // @ts-expect-error an InProgress work stays InProgress
    b.value.Draft;
}
const c = commands.change(either, title);
if (c.ok) {
    // either state may come back: narrow by the key
    const any: Tasks.DraftWork | Tasks.InProgressWork = 'Draft' in c.value ? c.value.Draft.aggregate : c.value.InProgress.aggregate;
    // @ts-expect-error either state may come back
    c.value.Draft.aggregate;
}
// @ts-expect-error change takes only Draft or InProgress
commands.change(completed, title);

const d = commands.step(inProgress);
if (d.ok) {
    const next: Tasks.CompletedWork = d.value.Completed.aggregate;
}

// an implementation returning a Draft work as InProgress is rejected
export const wrong: Tasks.ChangeWork = (work, title) =>
    // @ts-expect-error Draft -> InProgress is not a transition of change
    ok({ InProgress: { aggregate: { ...work, title, state: 'InProgress' } as Tasks.InProgressWork, events: { WorkChanged: { type: 'WorkChanged', workId: work.id } } } });
`,
        );
        const r = tscIn(work, 'src/use.ts');
        expect(r.output).toBe('');
        expect(r.code).toBe(0);
    });

    test('byState: handlers per state implement the commands, typed without assertions', async () => {
        await writeFile(
            path.join(work, 'src', 'impl.ts'),
            `import { byState, ok, type Tasks } from '../generated/index.js';

const changed = (work: Tasks.Work) => ({ WorkChanged: { type: 'WorkChanged', workId: work.id } }) as const;
declare const now: Date;

export const commands: Tasks.WorkCommands = {
    open: (id, title) => ok({ Draft: { aggregate: { state: 'Draft', id, title }, events: {} } }),
    change: byState<Tasks.ChangeWorkByState>({
        Draft: (work, title) => ok({ Draft: { aggregate: { ...work, title }, events: changed(work) } }),
        InProgress: (work, title) => ok({ InProgress: { aggregate: { ...work, title }, events: changed(work) } }),
    }),
    start: (work) => ok({ InProgress: { aggregate: { ...work, state: 'InProgress' }, events: {} } }),
    cancel: (work) => ok({ Cancelled: { aggregate: { ...work, state: 'Cancelled' }, events: {} } }),
    review: byState<Tasks.ReviewWorkByState>({
        InProgress: (work, at) => ok({ Completed: { aggregate: { ...work, state: 'Completed', completedAt: at }, events: {} } }),
        Draft: (work) => ok({ Draft: { aggregate: work, events: {} } }),
    }),
    step: byState<Tasks.StepWorkByState>({
        Draft: (work) => ok({ InProgress: { aggregate: { ...work, state: 'InProgress' }, events: {} } }),
        InProgress: (work) => ok({ Completed: { aggregate: { ...work, state: 'Completed', completedAt: now }, events: {} } }),
        Completed: ({ completedAt, ...work }) => ok({ Cancelled: { aggregate: { ...work, state: 'Cancelled' }, events: {} } }),
        Cancelled: (work) => ok({ Cancelled: { aggregate: work, events: {} } }),
    }),
};

declare const draft: Tasks.DraftWork;
declare const title: Tasks.Title;
const r = commands.change(draft, title);
if (r.ok) {
    const stays: Tasks.DraftWork = r.value.Draft.aggregate;
}

export const draftToInProgress: Tasks.ChangeWork = byState<Tasks.ChangeWorkByState>({
    // @ts-expect-error the Draft handler must return a Draft work
    Draft: (work, title) => ok({ InProgress: { aggregate: { ...work, title, state: 'InProgress' }, events: changed(work) } }),
    InProgress: (work, title) => ok({ InProgress: { aggregate: { ...work, title }, events: changed(work) } }),
});

// @ts-expect-error a handler for every source state is required
export const missing: Tasks.ChangeWork = byState<Tasks.ChangeWorkByState>({
    Draft: (work, title) => ok({ Draft: { aggregate: { ...work, title }, events: changed(work) } }),
});

// handlers typed by hand are checked against the contract as well
declare const swapped: { Draft: Tasks.ChangeWorkByState['InProgress']; InProgress: Tasks.ChangeWorkByState['InProgress'] };
// @ts-expect-error Draft -> InProgress is not a transition of change
export const fromSwapped: Tasks.ChangeWork = byState(swapped);

export const wrongArgs: Tasks.ChangeWorkByState = {
    Draft: (work, title) => ok({ Draft: { aggregate: { ...work, title }, events: changed(work) } }),
    // @ts-expect-error parameters are those of the command
    InProgress: (work, title: number) => ok({ InProgress: { aggregate: work, events: changed(work) } }),
};
`,
        );
        const r = tscIn(work, 'src/impl.ts');
        expect(r.output).toBe('');
        expect(r.code).toBe(0);
    });

    test('byState calls the handler of the state of its first argument with the same arguments', async () => {
        const { byState } = await import(path.join(work, 'generated', '_runtime.ts'));
        const calls: unknown[][] = [];
        const f = byState({
            Draft: (...args: unknown[]) => (calls.push(['Draft', ...args]), 'draft'),
            InProgress: (...args: unknown[]) => (calls.push(['InProgress', ...args]), 'inProgress'),
        });
        const draft = { state: 'Draft', id: 1 };
        const inProgress = { state: 'InProgress', id: 2 };
        expect(f(draft, 'a', 3)).toBe('draft');
        expect(f(inProgress, 'b')).toBe('inProgress');
        expect(calls).toEqual([['Draft', draft, 'a', 3], ['InProgress', inProgress, 'b']]);
    });
});

describe('contexts generated into different directories', () => {
    const SHARED = 'packages/shared/src/generated';
    let split: string;

    beforeAll(async () => {
        split = await mkdtemp(path.join(tmpdir(), 'domaintrail-split-'));
        const a = await analyze(await loadWorkspace(EXAMPLES));
        const dirs = { Common: SHARED, Sales: 'generated/domain', Billing: 'generated/domain' };
        for (const f of generateTypeScript(a.model!, dirs)) {
            await mkdir(path.dirname(path.join(split, f.path)), { recursive: true });
            await writeFile(path.join(split, f.path), f.content);
        }
        await mkdir(path.join(split, 'src'));
    });

    afterAll(async () => {
        await rm(split, { recursive: true, force: true });
    });

    test('each directory gets a runtime and an index of its own contexts; imports point across directories', async () => {
        const read = (p: string) => readFile(path.join(split, p), 'utf8');
        expect(await read(`${SHARED}/_runtime.ts`)).toBe(await read('generated/domain/_runtime.ts'));
        const index = await read('generated/domain/index.ts');
        expect(index).toContain(`export * as Sales from './Sales.js';`);
        expect(index).not.toContain('Common');
        expect(await read(`${SHARED}/index.ts`)).toContain(`export * as Common from './Common.js';`);
        expect(await read('generated/domain/Billing.ts')).toContain(`import type * as Common from '../../packages/shared/src/generated/Common.js';`);
        expect(await read('generated/domain/Billing.ts')).toContain(`import type * as Sales from './Sales.js';`);
    });

    test('compiles, and values typed by one runtime are accepted by the other', async () => {
        await writeFile(
            path.join(split, 'src', 'split.ts'),
            `import * as domain from '../generated/domain/index.js';
import * as shared from '../packages/shared/src/generated/index.js';
import type { Billing } from '../generated/domain/index.js';
import type { Common } from '../packages/shared/src/generated/index.js';

// a Common value is what Billing expects, and the two runtimes' Decimal and Result are interchangeable
export const issue: Billing.InvoiceCommands['issue'] = (id, order, billedAmount: Common.Money) =>
    shared.ok({ Open: { aggregate: { state: 'Open', id, order, billedAmount }, events: {} } });
export const makeAmount: Common.MakeAmount = (value: domain.Decimal) =>
    Number(value) >= 0 ? domain.ok(value as Common.Amount) : domain.err({ type: 'InvalidAmount', value, invariant: 'nonNegative' });
const d: shared.Decimal = '1' as domain.Decimal;
export const back: domain.Decimal = d;
// @ts-expect-error the brand still applies across runtimes
export const plain: shared.Decimal = '1';
`,
        );
        const r = tscIn(split, 'src/split.ts', 'generated/domain/index.ts', `${SHARED}/index.ts`);
        expect(r.output).toBe('');
        expect(r.code).toBe(0);
    });
});

describe('invariants without an expression', () => {
    const FACTORY = `context Factory {
  id TaskId: UUID
  primitive Code: String {
    invariant format { matches(value, "^[A-Z]+$") }
    invariant registered "登録済みのコード"
  }
  aggregate Task {
    id: TaskId
    depends: TaskId[0..*]
    invariant distinctDeps { unique(depends) }
    /// depends を辺とするグラフに閉路がない
    invariant acyclicDeps "タスク依存が循環しない"
  }
}
`;

    test('are documented as not expressed in the DSL, and join the invariants of the constructor error', async () => {
        const a = await check({ 'factory.dt': FACTORY });
        expect(a.diagnostics).toEqual([]);
        const code = generateTypeScript(a.model!).find((f) => f.path === 'Factory.ts')!.content;
        expect(code).toContain('/**\n * @invariant distinctDeps: unique(depends)\n * @invariant acyclicDeps (タスク依存が循環しない): not expressed in the DSL\n */\nexport interface Task {');
        expect(code).toContain(' * @invariant registered (登録済みのコード): not expressed in the DSL\n');
        expect(code).toContain("    readonly invariant: 'format' | 'registered';");
    });
});
