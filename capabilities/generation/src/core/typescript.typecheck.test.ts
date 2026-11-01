// The generated TypeScript of examples/shop and of commands with several transitions, type-checked by tsc (a child
// process), alone and with the example's implementation.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { generateTypeScript } from './typescript.js';

import { analyzeForGeneration, check, EXAMPLES, exampleSources } from '../test-helpers.js';

const TSC = path.join(import.meta.dir, '..', '..', '..', '..', 'node_modules', '.bin', 'tsc');
let dir: string;

/** Type-checks `files` (relative to the temp project) together with the generated code. */
function tsc(...files: string[]): { code: number; output: string } {
    return tscIn(dir, ...files);
}

function tscIn(cwd: string, ...files: string[]): { code: number; output: string } {
    const r = Bun.spawnSync(
        [
            process.execPath,
            TSC,
            '--noEmit',
            '--strict',
            '--target',
            'ES2023',
            '--module',
            'preserve',
            '--moduleResolution',
            'bundler',
            '--lib',
            'ES2023,DOM',
            ...files,
        ],
        { cwd },
    );
    return { code: r.exitCode, output: r.stdout.toString() + r.stderr.toString() };
}

beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-gen-'));
    const a = await analyzeForGeneration(await exampleSources());
    expect(a.ok).toBe(true);
    await mkdir(path.join(dir, 'generated', 'domain'), { recursive: true });
    for (const f of generateTypeScript(a.model!)) await writeFile(path.join(dir, 'generated', 'domain', f.path), f.content);
    await mkdir(path.join(dir, 'src'));
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('generated TypeScript', () => {
    test('the generated code and the example implementation compile', async () => {
        // the domain layer of the example: it imports only the generated code (the rest is checked in contract-tests)
        const files = (await readdir(path.join(EXAMPLES, 'src', 'domain'))).map((f) => path.join('src', 'domain', f));
        expect(files).toEqual(expect.arrayContaining(['src/domain/order-commands.ts', 'src/domain/primitives.ts']));
        await mkdir(path.join(dir, 'src', 'domain'));
        for (const f of files) await writeFile(path.join(dir, f), await readFile(path.join(EXAMPLES, f), 'utf8'));
        const r = tsc(...files, 'generated/domain/index.ts');
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
    // @ts-expect-error error type not declared by the command (it is cancel's)
    return err({ type: 'NoteRequired' });
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
      changes title
      emits WorkChanged
    command start() Draft -> InProgress
    command cancel() Draft -> Cancelled, InProgress -> Cancelled
    command review(at: Timestamp) InProgress -> InProgress | Completed, Draft -> Draft errors NotReady
    command step() Draft -> InProgress, InProgress -> Completed, Completed | Cancelled -> Cancelled
  }
}
`;
    let work: string;

    beforeAll(async () => {
        work = await mkdtemp(path.join(tmpdir(), 'domaintrail-work-'));
        const a = await check({ 'tasks.dt': WORK });
        expect(a.diagnostics).toEqual([]);
        await mkdir(path.join(work, 'generated'));
        for (const f of generateTypeScript(a.model!)) await writeFile(path.join(work, 'generated', f.path), f.content);
        await mkdir(path.join(work, 'src'));
    });

    afterAll(async () => {
        await rm(work, { recursive: true, force: true });
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

    test('decide: decisions implement the commands, typed without assertions', async () => {
        await writeFile(
            path.join(work, 'src', 'impl.ts'),
            `import { Tasks, decide, err, ok } from '../generated/index.js';

const changed = (work: Tasks.Work) => ({ WorkChanged: { type: 'WorkChanged', workId: work.id } }) as const;
declare const now: Date;

export const commands: Tasks.WorkCommands = {
    open: decide<Tasks.OpenWorkDecision>(Tasks.WorkShape, (id, title) => ok({ Draft: { set: { id, title }, events: {} } })),
    change: decide<Tasks.ChangeWorkDecision>(Tasks.WorkShape, {
        Draft: (work, title) => ok({ Draft: { set: { title }, events: changed(work) } }),
        InProgress: (work, title) => ok({ InProgress: { set: { title }, events: changed(work) } }),
    }),
    start: decide<Tasks.StartWorkDecision>(Tasks.WorkShape, { Draft: () => ok({ InProgress: { set: {}, events: {} } }) }),
    cancel: decide<Tasks.CancelWorkDecision>(Tasks.WorkShape, {
        Draft: () => ok({ Cancelled: { set: {}, events: {} } }),
        InProgress: () => ok({ Cancelled: { set: {}, events: {} } }),
    }),
    review: decide<Tasks.ReviewWorkDecision>(Tasks.WorkShape, {
        InProgress: (work, at) => (at < now ? err({ type: 'NotReady' }) : ok({ Completed: { set: { completedAt: at }, events: {} } })),
        Draft: () => ok({ Draft: { set: {}, events: {} } }),
    }),
    step: decide<Tasks.StepWorkDecision>(Tasks.WorkShape, {
        Draft: () => ok({ InProgress: { set: {}, events: {} } }),
        InProgress: () => ok({ Completed: { set: { completedAt: now }, events: {} } }),
        Completed: () => ok({ Cancelled: { set: {}, events: {} } }),
        Cancelled: () => ok({ Cancelled: { set: {}, events: {} } }),
    }),
};

declare const draft: Tasks.DraftWork;
declare const title: Tasks.Title;
const r = commands.change(draft, title);
if (r.ok) {
    const stays: Tasks.DraftWork = r.value.Draft.aggregate;
}

export const draftToInProgress: Tasks.ChangeWork = decide<Tasks.ChangeWorkDecision>(Tasks.WorkShape, {
    // @ts-expect-error the Draft handler decides the Draft outcome
    Draft: (work, title) => ok({ InProgress: { set: { title }, events: changed(work) } }),
    InProgress: (work, title) => ok({ InProgress: { set: { title }, events: changed(work) } }),
});

// @ts-expect-error a handler for every source state is required
export const missing: Tasks.ChangeWork = decide<Tasks.ChangeWorkDecision>(Tasks.WorkShape, {
    Draft: (work, title) => ok({ Draft: { set: { title }, events: changed(work) } }),
});

// the decision of another command does not make this one
// @ts-expect-error start decides InProgress from Draft, not change
export const otherDecision: Tasks.ChangeWork = decide<Tasks.StartWorkDecision>(Tasks.WorkShape, { Draft: () => ok({ InProgress: { set: {}, events: {} } }) });

export const wrongArgs: Tasks.ChangeWorkDecision = {
    Draft: (work, title) => ok({ Draft: { set: { title }, events: changed(work) } }),
    // @ts-expect-error parameters are those of the command
    InProgress: (work, title: number) => ok({ InProgress: { set: { title: work.title }, events: changed(work) } }),
};
`,
        );
        const r = tscIn(work, 'src/impl.ts');
        expect(r.output).toBe('');
        expect(r.code).toBe(0);
    });
});

describe('contexts generated into different directories', () => {
    const SHARED = 'packages/shared/src/generated';
    let split: string;

    beforeAll(async () => {
        split = await mkdtemp(path.join(tmpdir(), 'domaintrail-split-'));
        const a = await analyzeForGeneration(await exampleSources());
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

describe('a context imported only for a {@link}', () => {
    test('compiles with no unused imports reported', async () => {
        const a = await check({
            'common.dt': 'context Common {\n  id AccountId: UUID\n}\n',
            'sales.dt': 'context Sales {\n  aggregate Account { id: Common.AccountId }\n}\n',
            'billing.dt':
                'context Billing {\n  id InvoiceId: UUID\n  aggregate Invoice {\n    id: InvoiceId\n    references account: Common.AccountId -> Sales.Account\n  }\n}\n',
        });
        expect(a.diagnostics).toEqual([]);
        const work = await mkdtemp(path.join(tmpdir(), 'domaintrail-link-'));
        try {
            const files = generateTypeScript(a.model!);
            // Sales is named only by the link of Invoice.account (its ID type is Common's)
            expect(files.find((f) => f.path === 'Billing.ts')!.content).toContain("import type * as Sales from './Sales.js';");
            for (const f of files) await writeFile(path.join(work, f.path), f.content);
            const r = tscIn(work, '--noUnusedLocals', 'Billing.ts');
            expect(r.output).toBe('');
            expect(r.code).toBe(0);
        } finally {
            await rm(work, { recursive: true, force: true });
        }
    });
});
