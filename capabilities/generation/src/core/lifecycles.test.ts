import { expect, test } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as fc from 'fast-check';
import { commandCases } from '../../../../testing/index.js';
import { check } from '../test-helpers.js';
import { generateTypeScript } from './typescript.js';

const SOURCE = `context Sales {
  id RequestId: UUID
  enum Kind { COLLECT DROP_OFF }
  event Collected
  event Received
  error Invalid
  aggregate Request {
    id: RequestId
    readonly kind: Kind
    ready: Bool
    state Unassigned
    state Assigned
    state CollectDone
    state Holding
    state Accepted
    state Rejected
    initial Unassigned
    create command open(id: RequestId, kind: Kind) { outcome opened: -> Unassigned }
    command assign() { outcome assigned: Unassigned -> Assigned }
    command complete()
    command inspect(passed: Bool) {
      outcome accepted: Assigned -> Accepted select { passed }
      outcome rejected: Assigned -> Rejected select { not passed }
    }
    command audit(passed: Bool) {
      outcome approved: Assigned -> Assigned select { passed } emits Collected
      outcome denied: Assigned -> Assigned select { not passed } emits Received
    }
    transitions for kind == Kind.COLLECT {
      on complete {
        requires canCollect { ready } else Invalid
        outcome collected: Assigned -> CollectDone emits Collected
      }
    }
    transitions for kind == Kind.DROP_OFF {
      on complete { outcome received: Assigned -> Holding emits Received }
    }
  }
}`;

test('named outcomes generate kind-restricted aggregate and command types', async () => {
    const result = await check({ 'sales.dt': SOURCE });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const sales = generateTypeScript(result.model!).find((f) => f.path === 'Sales.ts')!.content;
    expect(sales).toContain('readonly kind: \'COLLECT\';');
    expect(sales).toContain('readonly kind: \'DROP_OFF\';');
    expect(sales).toContain('readonly collected: {');
    expect(sales).toContain('readonly received: {');
    expect(sales).toContain('readonly approved: {');
    expect(sales).toContain('readonly denied: {');
    expect(sales).toContain('aggregate: COLLECTCollectDoneRequest');
    expect(sales).toContain('aggregate: DROP_OFFHoldingRequest');
    expect(sales).toContain('export const restoreRequest = (trusted: Request): Request => trusted;');
    expect(sales).toContain('export function checkInspectRequestChoice');
    expect(sales).toContain('export function checkCompleteRequestRequires');
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-lifecycle-ts-'));
    try {
        for (const file of generateTypeScript(result.model!)) await writeFile(path.join(dir, file.path), file.content);
        await writeFile(path.join(dir, 'typecheck.ts'), `import type * as Sales from './Sales.js';
declare const commands: Sales.RequestCommands;
declare const collect: Sales.COLLECTAssignedRequest;
declare const dropOff: Sales.DROP_OFFAssignedRequest;
declare const invalid: Sales.DROP_OFFHoldingRequest;
const collected = commands.complete(collect);
if (collected.ok) {
  collected.value.collected.aggregate.kind satisfies 'COLLECT';
  // @ts-expect-error received is not a COLLECT result
  collected.value.received;
}
const received = commands.complete(dropOff);
if (received.ok) {
  received.value.received.aggregate.kind satisfies 'DROP_OFF';
  // @ts-expect-error collected is not a DROP_OFF result
  received.value.collected;
}
// @ts-expect-error Holding is not an input to complete
commands.complete(invalid);
`);
        const tsc = path.join(import.meta.dir, '..', '..', '..', '..', 'node_modules', '.bin', 'tsc');
        const check = Bun.spawnSync([process.execPath, tsc, '--noEmit', '--strict', '--target', 'ES2023', '--module', 'preserve', '--moduleResolution', 'bundler', 'index.ts', 'typecheck.ts'], { cwd: dir });
        expect(check.stdout.toString() + check.stderr.toString()).toBe('');
        expect(check.exitCode).toBe(0);
        const runtime = await import(path.join(dir, 'Sales.ts'));
        const selected = runtime.checkInspectRequestChoice({})({ kind: 'COLLECT', state: 'Assigned' }, { passed: true });
        expect(selected).toEqual({ accepted: true, rejected: false });
        expect(runtime.checkCompleteRequestChoice({})({ kind: 'COLLECT', state: 'Assigned' })).toEqual({ collected: true, received: false });
        expect(runtime.checkCompleteRequestRequires({ kind: 'COLLECT', state: 'Assigned', ready: false })).toBe('group0_canCollect');
        expect(runtime.checkCompleteRequestRequires({ kind: 'DROP_OFF', state: 'Assigned', ready: false })).toBeUndefined();
        const helper = await import(path.join(dir, '_runtime.ts'));
        const decide = helper.decideNamed()(
            { fields: ['kind', 'ready'], states: { Assigned: [], Accepted: [], Rejected: [] } },
            { accepted: 'Accepted', rejected: 'Rejected' },
            () => ({ ok: true, value: { accepted: { set: {}, events: {} } } }),
            { applicable: () => ['accepted', 'rejected'], choices: () => ({ accepted: false, rejected: true }) },
        );
        expect(() => decide({ kind: 'COLLECT', ready: true, state: 'Assigned' })).toThrow('DomainTrail choice contract violated');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('external choice obligations require a typed check and mandatory contract options', async () => {
    const source = SOURCE.replace('select { passed }', 'select "approved by reviewer" @externalCheck("requires a reviewer")');
    const result = await check({ 'sales.dt': source });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const files = generateTypeScript(result.model!, {}, { dir: 'tests' });
    const sales = files.find((f) => f.path === 'Sales.ts')!.content;
    const tests = files.find((f) => f.path === 'tests/Sales.ts')!.content;
    expect(sales).toContain('readonly accepted: (request: Request, params: InspectRequestParams) => boolean');
    expect(tests).toContain('readonly external: { readonly Request: { readonly inspect: Sales.InspectRequestChoiceChecks } };');
    expect(tests).toContain('export function contract(impl: Implementation, options: Options): testing.Suite');
    expect(tests).toContain('choices: Sales.checkInspectRequestChoice(options.external.Request.inspect)');
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-external-ts-'));
    try {
        for (const file of files) {
            const destination = path.join(dir, file.path);
            await Bun.write(destination, file.content);
        }
        await symlink(path.join(import.meta.dir, '..', '..', '..', '..', 'node_modules'), path.join(dir, 'node_modules'));
        await writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({
            compilerOptions: {
                strict: true, noEmit: true, target: 'ES2023', module: 'preserve', moduleResolution: 'bundler',
                paths: { 'domaintrail/testing': [path.join(import.meta.dir, '..', '..', '..', '..', 'testing', 'index.ts')] },
            },
            include: ['Sales.ts', '_runtime.ts', 'tests/Sales.ts', 'usage.ts'],
        }));
        await writeFile(path.join(dir, 'usage.ts'), `import * as Tests from './tests/Sales.js';
// @ts-expect-error an external choice requires contract options
Tests.contract({});
// @ts-expect-error the accepted outcome's external check must be supplied
Tests.contract({}, { external: { Request: { inspect: {} } } });
Tests.contract({}, { external: { Request: { inspect: { accepted: () => true } } } });
`);
        const tsc = path.join(import.meta.dir, '..', '..', '..', '..', 'node_modules', '.bin', 'tsc');
        const compiled = Bun.spawnSync([process.execPath, tsc, '-p', 'tsconfig.json'], { cwd: dir });
        expect(compiled.stdout.toString() + compiled.stderr.toString()).toBe('');
        expect(compiled.exitCode).toBe(0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a grouped factory outcome fixes the produced kind without relying on parameter names', async () => {
    const result = await check({ 'factory.dt': `context X {
      id TaskId: UUID
      enum Kind { A B }
      aggregate Task {
        id: TaskId
        readonly kind: Kind
        state Start
        initial Start
        create command open(id: TaskId)
        transitions for kind == Kind.A { on open { outcome openedA: -> Start } }
        transitions for kind == Kind.B { on open { outcome openedB: -> Start } }
      }
    }` });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const code = generateTypeScript(result.model!).find((f) => f.path === 'X.ts')!.content;
    expect(code).toContain("readonly openedA: {");
    expect(code).toContain("aggregate: AStartTask");
    expect(code).toContain("aggregate: BStartTask");
    expect(code).toContain("readonly kind: 'A'");
    expect(code).toContain("readonly kind: 'B'");
});

test('an annotated invariant makes its external check mandatory in contract options', async () => {
    const result = await check({ 'external.dt': `context X {
      primitive Code: String { invariant registered "registered in external catalog" @externalCheck("catalog is external") }
    }` });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const files = generateTypeScript(result.model!, {}, { dir: 'tests' });
    const tests = files.find((f) => f.path === 'tests/X.ts')!.content;
    expect(tests).toContain("readonly declared: { readonly X: { readonly Code: Pick<X.CodeDeclaredChecks, 'registered'> } };");
    expect(tests).toContain('export function contract(impl: Implementation, options: Options): testing.Suite');
});

test('contract tests reject a named outcome whose choice rule is false', () => {
    const cases = commandCases({
        name: 'Request.audit',
        run: () => ({ ok: true, value: { denied: { aggregate: { kind: 'COLLECT', state: 'Assigned' }, events: {} } } }),
        input: () => fc.constant([{ kind: 'COLLECT', state: 'Assigned' }]),
        examples: [],
        factory: false,
        requires: [],
        declaredRequires: [],
        declaredInvariants: [],
        stateful: true,
        counted: [],
        kindField: 'kind',
        validStates: [{ kind: 'COLLECT', states: ['Assigned'] }],
        outcomes: [
            { name: 'approved', from: ['Assigned'], to: 'Assigned', kinds: ['COLLECT'] },
            { name: 'denied', from: ['Assigned'], to: 'Assigned', kinds: ['COLLECT'] },
        ],
        choices: () => ({ approved: true, denied: false }),
    }, { runs: 1 });
    const selection = cases.find((c) => c.name.includes('selects one applicable named outcome'))!;
    expect(() => selection.run()).toThrow("returned outcome 'denied' although its choice rule is false");
});
