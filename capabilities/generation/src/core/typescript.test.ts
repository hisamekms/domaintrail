import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { generateTypeScript } from './typescript.js';
import { analyzeForGeneration, check, exampleSources } from '../test-helpers.js';

let dir: string;

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
    test('state-specific fields and the state union are reflected', async () => {
        const sales = await readFile(path.join(dir, 'generated', 'domain', 'Sales.ts'), 'utf8');
        expect(sales).toMatch(
            /export interface ConfirmedOrder extends OrderCommon \{\n    readonly state: 'Confirmed';\n(    \/\*\*.*\*\/\n)?    readonly confirmedAt: Timestamp;\n\}/,
        );
        expect(sales).toContain('export type Order = DraftOrder | ConfirmedOrder | CancelledOrder;');
        expect(sales).not.toMatch(/interface DraftOrder[^}]*confirmedAt/);
    });

    test('command contracts narrow input/output states, events and errors', async () => {
        const sales = await readFile(path.join(dir, 'generated', 'domain', 'Sales.ts'), 'utf8');
        expect(sales).toContain(
            `export type ConfirmOrder = (
    order: DraftOrder,
    params: ConfirmOrderParams,
) => Result<{
    readonly Confirmed: {
        readonly aggregate: ConfirmedOrder;
        readonly events: { readonly OrderConfirmed: OrderConfirmed };
    };
}, EmptyOrder>;`,
        );
        // no events -> NoEvents; factory -> no aggregate parameter, the new ID passed in
        expect(sales).toContain('        readonly events: NoEvents;\n    };\n}, DuplicateSku | CurrencyMismatch>;');
        expect(sales).toContain("import type { NoEvents, Result, Shape, Timestamp } from './_runtime.js';");
        expect(sales).toContain('export type PlaceOrder = (\n    params: PlaceOrderParams,\n)');
        // an aggregate without states: keyed by the aggregate's name
        expect(sales).toContain(') => Result<{\n    readonly Customer: {\n        readonly aggregate: Customer;\n');
        expect(sales).toContain(' * Commands are pure functions of the aggregate and their parameters: no I/O, no clock, no randomness.');
    });

    test('command error catalog contains actual type values and empty decisions', async () => {
        const sales = await readFile(path.join(dir, 'generated', 'domain', 'Sales.ts'), 'utf8');
        expect(sales).toContain('export const commandErrors = {');
        expect(sales).toContain("    'Order.confirm': ['EmptyOrder'],");
        expect(sales).toContain("    'Order.changeNote': [],");
        expect(sales).toContain('} as const;');
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
        expect(code).toContain(
            '/**\n * Work.cancel (Draft -> Cancelled; InProgress -> Cancelled)\n * @changes none — the command changes no common field\n * @emits nothing\n * @see tasks.dt:21\n */',
        );
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
        expect(code).toContain('/**\n * Work.open (new -> Draft) — factory\n * @emits nothing\n * @see tasks.dt:14\n */');
    });

    test('targets that differ by transition: a contract generic over the input state, and a decision per source state', () => {
        expect(code).toContain(
            '/**\n * Work.change (Draft -> Draft; InProgress -> InProgress)\n * @changes title\n * @emits WorkChanged — exactly once when the command succeeds\n * @see tasks.dt:15\n */',
        );
        expect(code).toContain(
            `export type ChangeWork = <S extends DraftWork | InProgressWork>(
    work: S,
    params: ChangeWorkParams,
) => {
    /** @emits WorkChanged — exactly once when the command succeeds */
    readonly Draft: Result<{
        readonly Draft: {
            readonly aggregate: DraftWork;
            readonly events: { readonly WorkChanged: WorkChanged };
        };
    }, never>;
    /** @emits WorkChanged — exactly once when the command succeeds */
    readonly InProgress: Result<{
        readonly InProgress: {
            readonly aggregate: InProgressWork;
            readonly events: { readonly WorkChanged: WorkChanged };
        };
    }, never>;
}[S['state']];

/**
 * Work.change, decided per source state; implement it with \`decide(WorkShape, …)\` from the runtime.
 * Each outcome gives the fields of \`set\`, and \`decide\` makes the aggregate, taking the other fields from the input.
 * @changes title
 * Draft -> Draft — set: title; carried over: id
 * InProgress -> InProgress — set: title; carried over: id
 * @see tasks.dt:15
 */
export type ChangeWorkDecision = {
    /** @emits WorkChanged — exactly once when the command succeeds */
    readonly Draft: (work: DraftWork, params: ChangeWorkParams) => Result<{
        readonly Draft: {
            readonly set: { readonly title: Title };
            readonly events: { readonly WorkChanged: WorkChanged };
        };
    }, never>;
    /** @emits WorkChanged — exactly once when the command succeeds */
    readonly InProgress: (work: InProgressWork, params: ChangeWorkParams) => Result<{
        readonly InProgress: {
            readonly set: { readonly title: Title };
            readonly events: { readonly WorkChanged: WorkChanged };
        };
    }, never>;
};`,
        );
        // several outcomes: a union keyed by the target, each branch ruling out the other keys
        expect(code).toContain(
            `    readonly InProgress: (work: InProgressWork, params: ReviewWorkParams) => Result<
        | {
              readonly InProgress: {
                  readonly set: NoChanges;
                  readonly events: NoEvents;
              };
              readonly Completed?: never;
          }
        | {
              readonly Completed: {
                  readonly set: { readonly completedAt: Timestamp };
                  readonly events: NoEvents;
              };
              readonly InProgress?: never;
          },
        NotReady
    >;`,
        );
        // several sources of one transition: a handler each, with the same outcome; the source's own fields dropped
        expect(code).toContain(
            '    readonly Completed: (work: CompletedWork) => Result<{\n        readonly Cancelled: {\n            readonly set: NoChanges;',
        );
        expect(code).toContain(
            '    readonly Cancelled: (work: CancelledWork) => Result<{\n        readonly Cancelled: {\n            readonly set: NoChanges;',
        );
        expect(code).toContain(' * Completed -> Cancelled — set: nothing; carried over: id, title; dropped: completedAt\n');
        // the commands interface is unchanged
        expect(code).toContain('    readonly change: ChangeWork;');
    });

    test('every command has a decision: keyed by source state, or one function for a factory', () => {
        expect([...code.matchAll(/export type (\w+Decision) = (\{|\()/g)].map((m) => [m[1], m[2]])).toEqual([
            ['OpenWorkDecision', '('],
            ['ChangeWorkDecision', '{'],
            ['StartWorkDecision', '{'],
            ['CancelWorkDecision', '{'],
            ['ReviewWorkDecision', '{'],
            ['StepWorkDecision', '{'],
        ]);
        expect(code).not.toContain('ByState');
        expect(code).toContain(
            "export const WorkShape: Shape = {\n    fields: ['id', 'title'],\n    states: { Draft: [], InProgress: [], Completed: ['completedAt'], Cancelled: [] },\n};",
        );
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
        expect(a.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
        const code = generateTypeScript(a.model!).find((f) => f.path === 'Factory.ts')!.content;
        expect(code).toContain(
            '/**\n * @invariant distinctDeps: unique(depends)\n * @invariant acyclicDeps (タスク依存が循環しない): not expressed in the DSL\n * @see factory.dt:7\n */\nexport interface Task {',
        );
        expect(code).toContain(' * @invariant registered (登録済みのコード): not expressed in the DSL\n');
        expect(code).toContain("    readonly invariant: 'format' | 'registered';");
    });
});

describe('links to the DSL', () => {
    test('every declaration that comes from the DSL ends its JSDoc with @see <file>:<line>, relative to the root', async () => {
        const ws = await exampleSources();
        const a = await analyzeForGeneration(ws);
        const sources = new Map(ws.map((s) => [s.path.replace(/\\/g, '/'), s.text.split('\n')]));
        const unlinked: string[] = [];
        for (const f of generateTypeScript(a.model!).filter((f) => !f.path.startsWith('_') && f.path !== 'index.ts')) {
            const lines = f.content.split('\n');
            lines.forEach((l, i) => {
                const name = /^export (?:type|interface|const) (\w+)/.exec(l)?.[1];
                if (!name) return;
                const see = /^ ?\/?\*+ @see (\S+):(\d+)(?: \*\/)?$/.exec(lines[i - 1] === ' */' ? lines[i - 2] : lines[i - 1]);
                if (!see) return unlinked.push(name);
                expect(sources.get(see[1])?.[Number(see[2]) - 1]).toBeDefined();
            });
        }
        // the unions of a context come from no single declaration
        expect([...new Set(unlinked)].sort()).toEqual(['Aggregate', 'DomainEvent', 'PersistentEvent', 'commandErrors']);
        const sales = generateTypeScript(a.model!).find((f) => f.path === 'Sales.ts')!.content;
        const target = (name: string): string => {
            const [, file, line] = new RegExp(`@see (\\S+):(\\d+)\\n \\*/\\nexport type ${name} `).exec(sales)!;
            return sources.get(file)![Number(line) - 1].trim();
        };
        expect(target('ConfirmOrder')).toStartWith('command confirm(');
        expect(target('ConfirmOrderDecision')).toStartWith('command confirm(');
        expect(target('Order')).toStartWith('aggregate Order ');
    });
});

describe('the target of references', () => {
    const SOURCES = {
        'common.dt': 'context Common {\n  id AccountId: UUID\n}\n',
        'sales.dt': `context Sales {
  id CustomerId: UUID
  aggregate Customer { id: CustomerId }
  id OrderId: UUID
  aggregate Account { id: Common.AccountId }
  aggregate Order {
    id: OrderId
    references customer: CustomerId -> Customer "顧客"
    references payer: CustomerId? -> Customer
  }
}
`,
        'billing.dt': `context Billing {
  id InvoiceId: UUID
  aggregate Invoice {
    id: InvoiceId
    references account: Common.AccountId -> Sales.Account
  }
}
`,
    };

    test('is linked from the doc comment of the field, by the name the module uses for it', async () => {
        const a = await check(SOURCES);
        expect(a.diagnostics).toEqual([]);
        const files = generateTypeScript(a.model!);
        const sales = files.find((f) => f.path === 'Sales.ts')!.content;
        expect(sales).toContain('    /**\n     * 顧客\n     * @see {@link Customer}\n     */\n    readonly customer: CustomerId;\n');
        expect(sales).toContain('    /** @see {@link Customer} */\n    readonly payer?: CustomerId;\n');
        expect(sales).not.toContain('// ->');
        // a context linked but not otherwise used is imported for its types, so that the link resolves in editors
        const billing = files.find((f) => f.path === 'Billing.ts')!.content;
        expect(billing).toContain('    /** @see {@link Sales.Account} */\n    readonly account: Common.AccountId;\n');
        expect(billing).toContain(
            "import type * as Common from './Common.js';\n// oxlint-disable-next-line no-unused-vars -- only named by {@link} in doc comments\nimport type * as Sales from './Sales.js';\n",
        );
    });
});

describe('generated output safety', () => {
    test('labels cannot break out of comments in generated code', async () => {
        const evil = 'x\\nexport const injected = 1;';
        const a = await check({
            'a.dt': `context S {
  enum E { A "${evil}" B "y\u2028export const injected2 = 2;" }
  primitive P: Int { invariant i "${evil}" { value > 0 } }
  id AId: UUID
  aggregate X "${evil}" { id: AId note: String "${evil}" command go() "${evil}" }
}`,
        });
        expect(a.ok).toBe(true);
        const code = generateTypeScript(a.model!).find((f) => f.path === 'S.ts')!.content;
        const lines = code.split(/\r\n|[\n\r\u2028\u2029]/);
        expect(lines.filter((l) => /^\s*export const injected/.test(l))).toEqual([]);
        expect(code).toContain("| 'A' // x export const injected = 1;");
    });
});

describe('command parameters as one object (ADR 0028)', () => {
    test('a command takes its parameters as one object, named `parameters` when the aggregate is `Params`', async () => {
        const a = await check({
            'a.dt': `context S {
  id ParamsId: UUID
  aggregate Params {
    id: ParamsId
    note: String?
    create command make(id: ParamsId, note: String?)
    command clear() changes note
    command set(newNote: String) requires filled { newNote != "" } else Empty changes note
  }
  error Empty
}`,
        });
        expect(a.diagnostics).toEqual([]);
        const code = generateTypeScript(a.model!).find((f) => f.path === 'S.ts')!.content;
        expect(code).toContain('export interface MakeParamsParams {\n    readonly id: ParamsId;\n    readonly note?: string;\n}');
        expect(code).toContain('export type MakeParams = (\n    parameters: MakeParamsParams,\n)');
        // a command without parameters takes none
        expect(code).toContain('export type ClearParams = (\n    params: Params,\n)');
        expect(code).not.toContain('ClearParamsParams');
        expect(code).toContain("export function checkSetParamsRequires(_params: Params, parameters: SetParamsParams): 'filled' | undefined {");
        expect(code).toContain("if (!(!(parameters.newNote === ''))) return 'filled';");
    });
});
