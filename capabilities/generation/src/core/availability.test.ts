// Where commands can be called (ADR 0036): the generated availability, guards, `…Unavailable` errors and any-state
// commands, type-checked by tsc and run.
import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { check, only } from '../test-helpers.js';
import { generateTypeScript } from './typescript.js';

const TSC = path.join(import.meta.dir, '..', '..', '..', '..', 'node_modules', '.bin', 'tsc');

/** Writes the generated files and `typecheck.ts` into a temporary directory, type-checks them and runs `body` there. */
async function inGenerated(source: string, typecheck: string, body: (dir: string) => Promise<void>): Promise<void> {
    const result = await check({ 'delivery.dt': source });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-availability-'));
    try {
        for (const file of generateTypeScript(result.model!)) await writeFile(path.join(dir, file.path), file.content);
        await writeFile(path.join(dir, 'typecheck.ts'), typecheck);
        const tsc = Bun.spawnSync(
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
                'index.ts',
                'typecheck.ts',
            ],
            { cwd: dir },
        );
        expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe('');
        expect(tsc.exitCode).toBe(0);
        await body(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

const PLAIN = `context Delivery {
  id RequestId: UUID
  event RequestCancelled { request: RequestId }
  event RequestAssigned { request: RequestId }
  error RequestOnHold
  aggregate DeliveryRequest {
    id: RequestId
    onHold: Bool
    state Unassigned
    state Assigned { courier: String }
    state OutForDelivery { courier: String }
    state Delivered
    state Cancelled
    initial Unassigned
    create command open(id: RequestId, onHold: Bool) { outcome opened: -> Unassigned }
    command assign(courier: String) {
      outcome assigned: Unassigned -> Assigned
        emits RequestAssigned
    }
    command cancel(reason: String) "依頼を取り消す" {
      requires notOnHold { not onHold } else RequestOnHold
      outcome cancelled: Unassigned | Assigned -> Cancelled
        emits RequestCancelled
    }
    command ship() { outcome shipped: Assigned -> OutForDelivery }
    command deliver() { outcome delivered: OutForDelivery -> Delivered }
    command touch() {
      outcome touched: Unassigned | Assigned | OutForDelivery | Delivered | Cancelled -> Cancelled
    }
  }
}`;

test('an aggregate with states gets its availability, guards and any-state commands', async () => {
    const result = await check({ 'delivery.dt': PLAIN });
    const delivery = generateTypeScript(result.model!).find((f) => f.path === 'Delivery.ts')!.content;
    expect(delivery).toContain(
        "    commands: {\n        assign: { '*': ['Unassigned'] },\n        cancel: { '*': ['Unassigned', 'Assigned'] },\n        ship: { '*': ['Assigned'] },\n        deliver: { '*': ['OutForDelivery'] },\n        touch: { '*': ['Unassigned', 'Assigned', 'OutForDelivery', 'Delivered', 'Cancelled'] },\n    },",
    );
    expect(delivery).toContain(
        "export type CancelDeliveryRequestUnavailable = CommandUnavailable<'Delivery.DeliveryRequest', 'cancel', 'OutForDelivery' | 'Delivered' | 'Cancelled', 'Unassigned' | 'Assigned'>;",
    );
    // every state is a source of touch: it can never be unavailable
    expect(delivery).toContain('export type TouchDeliveryRequestUnavailable = never;');
    // a factory takes no aggregate
    expect(delivery).not.toContain('canOpenDeliveryRequest');

    await inGenerated(
        PLAIN,
        `import type * as Delivery from './Delivery.js';
import { anyStateDeliveryRequestCommands, availableDeliveryRequestCommands, canCancelDeliveryRequest } from './Delivery.js';
declare const commands: Delivery.DeliveryRequestCommands;
declare const request: Delivery.DeliveryRequest;
const anyState = anyStateDeliveryRequestCommands(commands);
const r = anyState.cancel(request, { reason: 'x' });
if (!r.ok) {
  if (r.error.type === 'CommandUnavailable') {
    r.error.state satisfies 'OutForDelivery' | 'Delivered' | 'Cancelled';
    r.error.expected satisfies readonly ('Unassigned' | 'Assigned')[];
  } else {
    r.error.type satisfies 'Delivery.RequestOnHold';
  }
} else {
  r.value.cancelled.aggregate.state satisfies 'Cancelled';
}
if (canCancelDeliveryRequest(request)) commands.cancel(request, { reason: 'x' });
// @ts-expect-error the strict command takes only its source states
commands.cancel(request, { reason: 'x' });
availableDeliveryRequestCommands(request) satisfies ('assign' | 'cancel' | 'ship' | 'deliver' | 'touch')[];
`,
        async (dir) => {
            const generated = await import(path.join(dir, 'Delivery.ts'));
            const calls: unknown[] = [];
            const commands = {
                open: () => undefined,
                assign: () => undefined,
                cancel: (subject: unknown, params: unknown) => (calls.push([subject, params]), { ok: true, value: 'called' }),
                ship: () => undefined,
                deliver: () => undefined,
                touch: () => undefined,
            };
            const anyState = generated.anyStateDeliveryRequestCommands(commands);
            const outForDelivery = { id: 'r1', onHold: false, state: 'OutForDelivery', courier: 'c' };
            expect(anyState.cancel(outForDelivery, { reason: 'x' })).toEqual({
                ok: false,
                error: {
                    type: 'CommandUnavailable',
                    aggregate: 'Delivery.DeliveryRequest',
                    command: 'cancel',
                    state: 'OutForDelivery',
                    expected: ['Unassigned', 'Assigned'],
                },
            });
            expect(calls).toEqual([]);
            const assigned = { id: 'r1', onHold: false, state: 'Assigned', courier: 'c' };
            expect(anyState.cancel(assigned, { reason: 'x' })).toEqual({ ok: true, value: 'called' });
            expect(calls).toEqual([[assigned, { reason: 'x' }]]);
            expect(generated.canCancelDeliveryRequest(outForDelivery)).toBe(false);
            expect(generated.canCancelDeliveryRequest(assigned)).toBe(true);
            expect(generated.availableDeliveryRequestCommands(assigned)).toEqual(['cancel', 'ship', 'touch']);
            expect(generated.availableDeliveryRequestCommands(outForDelivery)).toEqual(['deliver', 'touch']);
        },
    );
});

const KINDS = `context Delivery {
  id RequestId: UUID
  aggregate Request {
    id: RequestId
    state Unassigned
    state Assigned
    state CollectDone
    state Holding
    state Delivered
    command assign() { outcome assigned: Unassigned -> Assigned }
    command complete()
    kind COLLECT {
      create command openCollect(id: RequestId) { outcome opened: -> Unassigned }
      on complete { outcome collected: Assigned -> CollectDone }
    }
    kind DROP_OFF {
      create command openDropOff(id: RequestId) { outcome opened: -> Unassigned }
      on complete {
        outcome received: Assigned -> Holding select { true }
        outcome delivered: Holding -> Delivered select { true }
      }
      command release() { outcome released: Holding -> Delivered }
    }
  }
}`;

test('availability follows the kind: sources and errors per kind, and a command of another kind is CommandNotForKind', async () => {
    const result = await check({ 'delivery.dt': KINDS });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const delivery = generateTypeScript(result.model!).find((f) => f.path === 'Delivery.ts')!.content;
    expect(delivery).toContain("    kindField: 'kind',");
    expect(delivery).toContain("        complete: { 'COLLECT': ['Assigned'], 'DROP_OFF': ['Assigned', 'Holding'] },");
    expect(delivery).toContain("        release: { 'DROP_OFF': ['Holding'] },");
    expect(delivery).toContain(
        "export type CompleteRequestUnavailable = CommandUnavailable<'Delivery.Request', 'complete', 'Unassigned' | 'CollectDone', 'Assigned', 'COLLECT'> | CommandUnavailable<'Delivery.Request', 'complete', 'Unassigned' | 'Delivered', 'Assigned' | 'Holding', 'DROP_OFF'>;",
    );
    expect(delivery).toContain("export type ReleaseRequestNotForKind = CommandNotForKind<'Delivery.Request', 'release', 'COLLECT', 'DROP_OFF'>;");
    expect(delivery).toContain('export type CompleteRequestNotForKind = never;');

    await inGenerated(
        KINDS,
        `import type * as Delivery from './Delivery.js';
import { anyStateRequestCommands, canCompleteRequest, isCOLLECTRequest } from './Delivery.js';
declare const commands: Delivery.RequestCommands;
declare const request: Delivery.Request;
const r = anyStateRequestCommands(commands).complete(request);
if (!r.ok && r.error.type === 'CommandUnavailable' && r.error.kind === 'COLLECT') r.error.expected satisfies readonly 'Assigned'[];
if (canCompleteRequest(request)) commands.complete(request);
if (isCOLLECTRequest(request)) request.kind satisfies 'COLLECT';
declare const collect: Delivery.COLLECTAssignedRequest;
declare const dropOff: Delivery.DROP_OFFHoldingRequest;
// the strict entry takes the kinds that have the command only
// @ts-expect-error release is a command of DROP_OFF
commands.release(collect);
commands.release(dropOff);
// the any-state entry takes any kind, and answers another with CommandNotForKind
const rr = anyStateRequestCommands(commands).release(collect);
if (!rr.ok && rr.error.type === 'CommandNotForKind') {
  rr.error.kind satisfies 'COLLECT';
  rr.error.expected satisfies readonly 'DROP_OFF'[];
}
`,
        async (dir) => {
            const generated = await import(path.join(dir, 'Delivery.ts'));
            const commands = {
                openCollect: () => undefined,
                openDropOff: () => undefined,
                assign: () => undefined,
                complete: () => ({ ok: true, value: 'called' }),
                release: () => ({ ok: true, value: 'called' }),
            };
            const anyState = generated.anyStateRequestCommands(commands);
            expect(anyState.complete({ id: 'r', kind: 'COLLECT', state: 'CollectDone' })).toEqual({
                ok: false,
                error: {
                    type: 'CommandUnavailable',
                    aggregate: 'Delivery.Request',
                    command: 'complete',
                    kind: 'COLLECT',
                    state: 'CollectDone',
                    expected: ['Assigned'],
                },
            });
            // the error has its own list: changing it changes nothing else
            const rejected = anyState.complete({ id: 'r', kind: 'COLLECT', state: 'CollectDone' });
            expect(rejected.error.expected).not.toBe(generated.RequestAvailability.commands.complete.COLLECT);
            expect(anyState.complete({ id: 'r', kind: 'DROP_OFF', state: 'Holding' })).toEqual({ ok: true, value: 'called' });
            expect(generated.canCompleteRequest({ id: 'r', kind: 'COLLECT', state: 'Holding' })).toBe(false);
            // the kind never changes: a command of another kind never passes, and says so apart from a state rejection
            expect(anyState.release({ id: 'r', kind: 'COLLECT', state: 'Assigned' })).toEqual({
                ok: false,
                error: { type: 'CommandNotForKind', aggregate: 'Delivery.Request', command: 'release', kind: 'COLLECT', expected: ['DROP_OFF'] },
            });
            expect(generated.canReleaseRequest({ id: 'r', kind: 'COLLECT', state: 'Holding' })).toBe(false);
            expect(generated.availableRequestCommands({ id: 'r', kind: 'DROP_OFF', state: 'Holding' })).toEqual(['complete', 'release']);
            expect(generated.availableRequestCommands({ id: 'r', kind: 'COLLECT', state: 'Holding' })).toEqual([]);
        },
    );
});

test('decide throws a contract violation for a state that is not a source state', async () => {
    const result = await check({ 'delivery.dt': PLAIN });
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-availability-decide-'));
    try {
        for (const file of generateTypeScript(result.model!)) await writeFile(path.join(dir, file.path), file.content);
        const runtime = await import(path.join(dir, '_runtime.ts'));
        const cancel = runtime.decide({ fields: ['id'], states: { Unassigned: [], Cancelled: [] } }, { Unassigned: () => ({ ok: true, value: {} }) });
        expect(() => cancel({ id: 'r', state: 'Delivered' })).toThrow(
            "DomainTrail command contract violated: state 'Delivered' is not a source state of this command (sources: Unassigned).",
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('decideNamed checks the source states of the command it names, per kind, before the decision runs', async () => {
    await inGenerated(
        PLAIN,
        `import * as Delivery from './Delivery.js';
import { decideNamed, ok } from './_runtime.js';
export const ship: Delivery.ShipDeliveryRequest = decideNamed<Delivery.ShipDeliveryRequestDecision>()(
    Delivery.DeliveryRequestShape,
    { shipped: 'OutForDelivery' },
    () => ok({ shipped: { set: {}, events: {} } }),
    { availability: Delivery.DeliveryRequestAvailability, command: 'ship' },
);
// @ts-expect-error a command that takes an aggregate with states says which command it is
decideNamed<Delivery.ShipDeliveryRequestDecision>()(Delivery.DeliveryRequestShape, { shipped: 'OutForDelivery' }, () => ok({ shipped: { set: {}, events: {} } }));
// a factory takes no aggregate: nothing to check
export const open: Delivery.OpenDeliveryRequest = decideNamed<Delivery.OpenDeliveryRequestDecision>()(
    Delivery.DeliveryRequestShape,
    { opened: 'Unassigned' },
    ({ id, onHold }) => ok({ opened: { set: { id, onHold }, events: {} } }),
);
`,
        async (dir) => {
            const runtime = await import(path.join(dir, '_runtime.ts'));
            const generated = await import(path.join(dir, 'Delivery.ts'));
            let ran = 0;
            const ship = runtime.decideNamed()(
                generated.DeliveryRequestShape,
                { shipped: 'OutForDelivery' },
                () => (ran++, { ok: true, value: { shipped: { set: {}, events: {} } } }),
                { availability: generated.DeliveryRequestAvailability, command: 'ship' },
            );
            expect(() => ship({ id: 'r', onHold: false, state: 'Cancelled' })).toThrow(
                "DomainTrail command contract violated: state 'Cancelled' is not a source state of this command (sources: Assigned).",
            );
            expect(ran).toBe(0);
            expect(ship({ id: 'r', onHold: false, state: 'Assigned', courier: 'c' })).toEqual({
                ok: true,
                value: { shipped: { aggregate: { state: 'OutForDelivery', id: 'r', onHold: false, courier: 'c' }, events: {} } },
            });
            // a misspelt command fails where the command is made, not when it is called
            expect(() =>
                runtime.decideNamed()(generated.DeliveryRequestShape, {}, () => undefined, {
                    availability: generated.DeliveryRequestAvailability,
                    command: 'shipp',
                }),
            ).toThrow("DomainTrail: Delivery.DeliveryRequest has no command 'shipp' that takes an aggregate.");
        },
    );

    const kinds = await check({ 'delivery.dt': KINDS });
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-availability-named-'));
    try {
        for (const file of generateTypeScript(kinds.model!)) await writeFile(path.join(dir, file.path), file.content);
        const runtime = await import(path.join(dir, '_runtime.ts'));
        const generated = await import(path.join(dir, 'Delivery.ts'));
        const complete = runtime.decideNamed()(generated.RequestShape, {}, () => ({ ok: true, value: {} }), {
            availability: generated.RequestAvailability,
            command: 'complete',
        });
        // Holding is a source state of complete for DROP_OFF only
        expect(() => complete({ id: 'r', kind: 'COLLECT', state: 'Holding' })).toThrow('(sources: Assigned).');
        expect(complete({ id: 'r', kind: 'DROP_OFF', state: 'Holding' })).toEqual({ ok: true, value: {} });
        // a command of another kind is a contract violation of the strict entry
        const release = runtime.decideNamed()(generated.RequestShape, {}, () => ({ ok: true, value: {} }), {
            availability: generated.RequestAvailability,
            command: 'release',
        });
        expect(() => release({ id: 'r', kind: 'COLLECT', state: 'Holding' })).toThrow(
            "Delivery.Request.release is not a command of kind 'COLLECT' (kinds: DROP_OFF).",
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

const LEGACY = `context Tasks {
  id WorkId: UUID
  aggregate Work {
    id: WorkId
    state Draft
    state Review
    state Done
    initial Draft
    create command open(id: WorkId) -> Draft
    command touch() Draft -> Draft, Review -> Review
    command submit() Draft -> Review
    command finish() Review -> Done
  }
}`;

test('commands with transitions per source state: availability and the result of the any-state entry', async () => {
    const result = await check({ 'delivery.dt': LEGACY });
    const tasks = generateTypeScript(result.model!).find((f) => f.path === 'Tasks.ts')!.content;
    expect(tasks).toContain("        touch: { '*': ['Draft', 'Review'] },");
    expect(tasks).toContain("export type TouchWorkUnavailable = CommandUnavailable<'Tasks.Work', 'touch', 'Done', 'Draft' | 'Review'>;");
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-availability-legacy-'));
    try {
        for (const file of generateTypeScript(result.model!)) await writeFile(path.join(dir, file.path), file.content);
        await writeFile(
            path.join(dir, 'typecheck.ts'),
            `import type * as Tasks from './Tasks.js';
import { anyStateWorkCommands } from './Tasks.js';
declare const commands: Tasks.WorkCommands;
declare const work: Tasks.Work;
const r = anyStateWorkCommands(commands).touch(work);
if (r.ok) {
  // the result of the generic command for each of its source states
  if ('Draft' in r.value) r.value.Draft.aggregate.state satisfies 'Draft';
  else r.value.Review.aggregate.state satisfies 'Review';
} else {
  r.error.state satisfies 'Done';
  r.error.expected satisfies readonly ('Draft' | 'Review')[];
}
`,
        );
        const tsc = Bun.spawnSync(
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
                'index.ts',
                'typecheck.ts',
            ],
            { cwd: dir },
        );
        expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe('');
        const generated = await import(path.join(dir, 'Tasks.ts'));
        const runtime = await import(path.join(dir, '_runtime.ts'));
        const commands = {
            open: () => undefined,
            touch: runtime.decide(generated.WorkShape, {
                Draft: () => ({ ok: true, value: { Draft: { set: {}, events: {} } } }),
                Review: () => ({ ok: true, value: { Review: { set: {}, events: {} } } }),
            }),
            submit: () => undefined,
            finish: () => undefined,
        };
        const anyState = generated.anyStateWorkCommands(commands);
        expect(anyState.touch({ id: 'w', state: 'Review' })).toEqual({ ok: true, value: { Review: { aggregate: { state: 'Review', id: 'w' }, events: {} } } });
        expect(anyState.touch({ id: 'w', state: 'Done' }).error).toEqual({
            type: 'CommandUnavailable',
            aggregate: 'Tasks.Work',
            command: 'touch',
            state: 'Done',
            expected: ['Draft', 'Review'],
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('M011: the generated names of the any-state entry collide like other names', async () => {
    const a = await check({
        'delivery.dt': PLAIN.replace(
            'error RequestOnHold',
            'error RequestOnHold\n  value CancelDeliveryRequestUnavailable\n  value DeliveryRequestAvailability',
        ),
    });
    expect(only(a, 'M011').map((d) => d.message)).toEqual([
        "Generated TypeScript name 'DeliveryRequestAvailability' for the availability of the commands of 'DeliveryRequest' collides with value object 'DeliveryRequestAvailability'.",
        "Generated TypeScript name 'CancelDeliveryRequestUnavailable' for the availability of 'DeliveryRequest.cancel' collides with value object 'CancelDeliveryRequestUnavailable'.",
    ]);
});

test('a name in a doc comment is not a use: no import of what the module does not use', async () => {
    const a = await check({
        'slots.dt': `context Slots {
  id SlotId: UUID
  /// Availability of a slot, after the CommandUnavailable checks of another system.
  aggregate Slot "Availability" {
    id: SlotId
    open: Bool
  }
}`,
    });
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const slots = generateTypeScript(a.model!).find((f) => f.path === 'Slots.ts')!.content;
    expect(slots).toContain("import type { Result, Shape } from './_runtime.js';");
});
