// Where commands can be called (ADR 0036): the generated availability, guards, `…Unavailable` errors and any-state
// commands, type-checked by tsc and run.
import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { check } from '../test-helpers.js';
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
  enum Kind { COLLECT DROP_OFF }
  aggregate Request {
    id: RequestId
    readonly kind: Kind
    state Unassigned
    state Assigned
    state CollectDone
    state Holding
    state Delivered
    initial Unassigned
    create command open(id: RequestId, kind: Kind) { outcome opened: -> Unassigned }
    command assign() { outcome assigned: Unassigned -> Assigned }
    command complete()
    command release()
    transitions for kind == Kind.COLLECT {
      on complete { outcome collected: Assigned -> CollectDone }
    }
    transitions for kind == Kind.DROP_OFF {
      on complete {
        outcome received: Assigned -> Holding select { true }
        outcome delivered: Holding -> Delivered select { true }
      }
      on release { outcome released: Holding -> Delivered }
    }
  }
}`;

test('availability follows the kind: sources and errors per kind, and a command without sources for a kind throws', async () => {
    const result = await check({ 'delivery.dt': KINDS });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const delivery = generateTypeScript(result.model!).find((f) => f.path === 'Delivery.ts')!.content;
    expect(delivery).toContain("    kindField: 'kind',");
    expect(delivery).toContain("        complete: { 'COLLECT': ['Assigned'], 'DROP_OFF': ['Assigned', 'Holding'] },");
    expect(delivery).toContain("        release: { 'COLLECT': [], 'DROP_OFF': ['Holding'] },");
    expect(delivery).toContain(
        "export type CompleteRequestUnavailable = CommandUnavailable<'Delivery.Request', 'complete', 'Unassigned' | 'CollectDone', 'Assigned', 'COLLECT'> | CommandUnavailable<'Delivery.Request', 'complete', 'Unassigned' | 'Delivered', 'Assigned' | 'Holding', 'DROP_OFF'>;",
    );

    await inGenerated(
        KINDS,
        `import type * as Delivery from './Delivery.js';
import { anyStateRequestCommands, canCompleteRequest } from './Delivery.js';
declare const commands: Delivery.RequestCommands;
declare const request: Delivery.Request;
const r = anyStateRequestCommands(commands).complete(request);
if (!r.ok && r.error.kind === 'COLLECT') r.error.expected satisfies readonly 'Assigned'[];
if (canCompleteRequest(request)) commands.complete(request);
`,
        async (dir) => {
            const generated = await import(path.join(dir, 'Delivery.ts'));
            const commands = {
                open: () => undefined,
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
            expect(anyState.complete({ id: 'r', kind: 'DROP_OFF', state: 'Holding' })).toEqual({ ok: true, value: 'called' });
            expect(generated.canCompleteRequest({ id: 'r', kind: 'COLLECT', state: 'Holding' })).toBe(false);
            // the kind never changes: a command without a source state for it is a caller's bug
            expect(() => anyState.release({ id: 'r', kind: 'COLLECT', state: 'Assigned' })).toThrow('DomainTrail command contract violated');
            expect(generated.canReleaseRequest({ id: 'r', kind: 'COLLECT', state: 'Assigned' })).toBe(false);
            expect(generated.availableRequestCommands({ id: 'r', kind: 'DROP_OFF', state: 'Holding' })).toEqual(['complete', 'release']);
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
