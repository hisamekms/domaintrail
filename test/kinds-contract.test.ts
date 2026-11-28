// The kinds of an aggregate end to end (ADR 0037): the generated types, an implementation with `decideNamed` and
// `decide` that type-checks strictly, the any-state entry's `CommandNotForKind`, and the generated contract tests run
// against the implementation (passing, and failing for one that breaks a kind's invariant).
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { check, generateFromAnalysis, linkNodeModules } from './helpers.js';

const ROOT = path.join(import.meta.dir, '..');
const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const TSC_FLAGS = [
    '--ignoreConfig',
    '--noEmit',
    '--strict',
    '--exactOptionalPropertyTypes',
    '--noUnusedLocals',
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

const tsc = (dir: string, files: string[]): string => {
    const r = Bun.spawnSync([process.execPath, path.join(ROOT, 'node_modules', '.bin', 'tsc'), ...TSC_FLAGS, ...files], { cwd: dir });
    return r.stdout.toString() + r.stderr.toString();
};

const MODEL = {
    'logistics.dt': `
context Logistics {
  id PickupSiteId: UUID
  id CardId: UUID
  event Registered { pickupSiteId: PickupSiteId }
  event Suspended { pickupSiteId: PickupSiteId }
  event ToppedUp { cardId: CardId }
  error DocksInUse
  error InvalidHour
  error NoDocks
  error Negative

  aggregate PickupSite {
    id: PickupSiteId
    name: String
    state Active
    state Paused
    command suspend()
    kind Store {
      storeCode: String
      closingTime: Int
      invariant openHours { closingTime >= 0 && closingTime < 24 }
      create command registerStore(id: PickupSiteId, name: String, storeCode: String, closingTime: Int) {
        requires validHour { closingTime >= 0 && closingTime < 24 } else InvalidHour
        outcome registered: -> Active
          changes id = id, name = name, storeCode = storeCode, closingTime = closingTime
          emits Registered
      }
      command changeClosingTime(newClosingTime: Int) {
        requires validNewHour { newClosingTime >= 0 && newClosingTime < 24 } else InvalidHour
        outcome changed: Active -> Active
          changes closingTime
      }
      on suspend {
        outcome suspended: Active -> Paused
          emits Suspended
      }
    }
    kind Center {
      dockCount: Int
      invariant docksPositive { dockCount > 0 }
      create command registerCenter(id: PickupSiteId, name: String, dockCount: Int) {
        requires someDocks { dockCount > 0 } else NoDocks
        outcome registered: -> Active
          changes id = id, name = name, dockCount = dockCount
          emits Registered
      }
      on suspend {
        requires fewDocks { dockCount < 50 } else DocksInUse
        outcome suspended: Active -> Paused
          emits Suspended
      }
    }
  }

  aggregate Card {
    id: CardId
    label: String
    command rename(newLabel: String) changes label
    kind Gift {
      amount: Int
      invariant nonNegative { amount >= 0 }
      create command makeGift(id: CardId, label: String, amount: Int)
        requires nonNegativeAmount { amount >= 0 } else Negative changes id = id, label = label, amount = amount
      command topUp(more: Int)
        requires nonNegativeMore { more >= 0 } else Negative
        changes amount
        emits ToppedUp
    }
    kind Member {
      level: Int
      create command makeMember(id: CardId, label: String, level: Int) changes id = id, label = label, level = level
    }
  }
}
`,
};

const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-kinds-'));
dirs.push(dir);
await linkNodeModules(dir);
{
    const a = await check(MODEL);
    expect(a.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    const generatedTests = generateFromAnalysis(a, {}, { dir: 'tests', runner: 'bun' });
    expect(generatedTests.find((f) => f.path === 'tests/Logistics.ts')?.content).toContain('ensures: Logistics.checkSuspendPickupSiteEnsures');
    for (const f of generatedTests) {
        await mkdir(path.dirname(path.join(dir, f.path)), { recursive: true });
        await writeFile(path.join(dir, f.path), f.content);
    }
}

/** The implementation, typed by the generated contracts (also the input of the type check). */
const IMPLEMENTATION = `import { Logistics } from './index.js';
import { decide, decideByKind, decideNamed, err, ok } from './_runtime.js';

export const pickupSite = (overrides: Partial<Logistics.PickupSiteCommands> = {}): Logistics.PickupSiteCommands => ({
    registerStore: decideNamed<Logistics.RegisterStorePickupSiteDecision>()(
        Logistics.PickupSiteShape,
        { registered: 'Active' },
        ({ id, name, storeCode, closingTime }) =>
            !(closingTime >= 0 && closingTime < 24) ? err({ type: 'Logistics.InvalidHour' }) : ok({ registered: { set: { kind: 'Store', id, name, storeCode, closingTime }, events: { 'Logistics.Registered': { type: 'Logistics.Registered', pickupSiteId: id } } } }),
    ),
    registerCenter: decideNamed<Logistics.RegisterCenterPickupSiteDecision>()(
        Logistics.PickupSiteShape,
        { registered: 'Active' },
        ({ id, name, dockCount }) =>
            !(dockCount > 0) ? err({ type: 'Logistics.NoDocks' }) : ok({ registered: { set: { kind: 'Center', id, name, dockCount }, events: { 'Logistics.Registered': { type: 'Logistics.Registered', pickupSiteId: id } } } }),
    ),
    changeClosingTime: decideNamed<Logistics.ChangeClosingTimePickupSiteDecision>()(
        Logistics.PickupSiteShape,
        { changed: 'Active' },
        (site, { newClosingTime }) => {
            // a kind's field, seen because the command is the kind's
            site.storeCode satisfies string;
            if (!(newClosingTime >= 0 && newClosingTime < 24)) return err({ type: 'Logistics.InvalidHour' });
            return ok({ changed: { set: { closingTime: newClosingTime }, events: {} } });
        },
        { availability: Logistics.PickupSiteAvailability, command: 'changeClosingTime' },
    ),
    // a common command decided per kind: one function per kind
    suspend: decideByKind<Logistics.SuspendPickupSiteDecision>()(
        Logistics.PickupSiteShape,
        { suspended: 'Paused' },
        {
            Store: (site) => ok({ suspended: { set: {}, events: { 'Logistics.Suspended': { type: 'Logistics.Suspended', pickupSiteId: site.id } } } }),
            Center: (site) =>
                !(site.dockCount < 50)
                    ? err({ type: 'Logistics.DocksInUse' })
                    : ok({ suspended: { set: {}, events: { 'Logistics.Suspended': { type: 'Logistics.Suspended', pickupSiteId: site.id } } } }),
        },
        { availability: Logistics.PickupSiteAvailability, command: 'suspend' },
    ),
    ...overrides,
});

export const card = (overrides: Partial<Logistics.CardCommands> = {}): Logistics.CardCommands => ({
    makeGift: decide<Logistics.MakeGiftCardDecision>(Logistics.CardShape, ({ id, label, amount }) =>
        amount < 0 ? err({ type: 'Logistics.Negative' }) : ok({ Card: { set: { kind: 'Gift', id, label, amount }, events: {} } }),
    ),
    makeMember: decide<Logistics.MakeMemberCardDecision>(Logistics.CardShape, ({ id, label, level }) => ok({ Card: { set: { kind: 'Member', id, label, level }, events: {} } })),
    rename: decide<Logistics.RenameCardDecision>(Logistics.CardShape, (_card, { newLabel }) => ok({ Card: { set: { label: newLabel }, events: {} } })),
    topUp: decide<Logistics.TopUpCardDecision>(Logistics.CardShape, (gift, { more }) =>
        more < 0 ? err({ type: 'Logistics.Negative' }) : ok({ Card: { set: { amount: gift.amount + more }, events: { 'Logistics.ToppedUp': { type: 'Logistics.ToppedUp', cardId: gift.id } } } }),
    ),
    ...overrides,
});
`;

const USAGE = `import { Logistics } from './index.js';
import { pickupSite, card } from './implementation.js';

declare const site: Logistics.PickupSite;
declare const center: Logistics.CenterActivePickupSite;
declare const store: Logistics.StoreActivePickupSite;
const commands = pickupSite();
// the strict entry takes the kinds that have the command
commands.changeClosingTime(store, { newClosingTime: 18 });
// @ts-expect-error changeClosingTime is a command of Store
commands.changeClosingTime(center, { newClosingTime: 18 });
// the any-state entry takes any kind and state, and tells a kind from a state rejection
const r = Logistics.anyStatePickupSiteCommands(commands).changeClosingTime(site, { newClosingTime: 18 });
if (!r.ok && r.error.type === 'CommandNotForKind') r.error.kind satisfies 'Center';
if (!r.ok && r.error.type === 'CommandUnavailable') r.error.state satisfies 'Paused';
if (Logistics.isStorePickupSite(site)) site.storeCode satisfies string;
// a common command decided per kind: its result is that of the input's kind
const s = commands.suspend(store);
if (s.ok) s.value.suspended.aggregate.kind satisfies 'Store';
// @ts-expect-error a kind's field is not on the aggregate of any kind
site.storeCode;
switch (site.kind) {
    case 'Store':
    case 'Center':
        break;
    default:
        site satisfies never;
}

declare const anyCard: Logistics.Card;
declare const member: Logistics.MemberCard;
// @ts-expect-error topUp is a command of Gift
card().topUp(member, { more: 1 });
const t = Logistics.anyStateCardCommands(card()).topUp(anyCard, { more: 1 });
if (!t.ok && t.error.type === 'CommandNotForKind') t.error.expected satisfies readonly 'Gift'[];
`;

await writeFile(path.join(dir, 'implementation.ts'), IMPLEMENTATION);
await writeFile(path.join(dir, 'usage.ts'), USAGE);

const domain = await import(path.join(dir, 'index.ts'));
const impl = await import(path.join(dir, 'implementation.ts'));
const tests = await import(path.join(dir, 'tests', 'index.ts'));
const testing = await import(path.join(dir, 'node_modules', 'domaintrail', 'testing', 'index.ts'));
const { Logistics } = domain;

async function run(suite: unknown): Promise<Record<string, string | undefined>> {
    const out: Record<string, string | undefined> = {};
    for (const c of testing.cases(suite)) {
        if (c.todo) continue;
        try {
            await c.run();
            out[c.name] = undefined;
        } catch (e) {
            out[c.name] = (e as Error).message;
        }
    }
    return out;
}
const failing = (r: Record<string, string | undefined>): string[] => Object.keys(r).filter((k) => r[k] !== undefined);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const makeId = (type: string) => (v: string) => (UUID.test(v) ? { ok: true, value: v } : { ok: false, error: { type, value: v, invariant: 'uuid' } });
const make = { PickupSiteId: makeId('Logistics.InvalidPickupSiteId'), CardId: makeId('Logistics.InvalidCardId') };

describe('aggregate kinds end to end', () => {
    test('the generated code and an implementation type-check strictly', () => {
        expect(tsc(dir, ['index.ts', 'implementation.ts', 'usage.ts', 'tests/index.ts', 'tests/Logistics.ts'])).toBe('');
    });

    test('a factory makes the aggregate of its kind; a command keeps the kind and its fields', () => {
        const commands = impl.pickupSite();
        const made = commands.registerStore({ id: 's', name: 'Shibuya', storeCode: 'S1', closingTime: 20 });
        expect(made.value.registered.aggregate).toEqual({ state: 'Active', kind: 'Store', id: 's', name: 'Shibuya', storeCode: 'S1', closingTime: 20 });
        const changed = commands.changeClosingTime(made.value.registered.aggregate, { newClosingTime: 18 });
        expect(changed.value.changed.aggregate).toEqual({ state: 'Active', kind: 'Store', id: 's', name: 'Shibuya', storeCode: 'S1', closingTime: 18 });
        const gift = impl.card().makeGift({ id: 'c', label: 'g', amount: 5 }).value.Card.aggregate;
        expect(gift).toEqual({ kind: 'Gift', id: 'c', label: 'g', amount: 5 });
        expect(impl.card().rename(gift, { newLabel: 'h' }).value.Card.aggregate).toEqual({ kind: 'Gift', id: 'c', label: 'h', amount: 5 });
    });

    test('the any-state entry answers a command of another kind with CommandNotForKind; the strict entry throws', () => {
        const center = { state: 'Active', kind: 'Center', id: 'c', name: 'Haneda', dockCount: 3 };
        expect(Logistics.anyStatePickupSiteCommands(impl.pickupSite()).changeClosingTime(center, { newClosingTime: 1 })).toEqual({
            ok: false,
            error: { type: 'CommandNotForKind', aggregate: 'Logistics.PickupSite', command: 'changeClosingTime', kind: 'Center', expected: ['Store'] },
        });
        expect(() => impl.pickupSite().changeClosingTime(center, { newClosingTime: 1 })).toThrow("is not a command of kind 'Center'");
        const member = { kind: 'Member', id: 'm', label: 'x', level: 1 };
        expect(Logistics.anyStateCardCommands(impl.card()).topUp(member, { more: 1 })).toEqual({
            ok: false,
            error: { type: 'CommandNotForKind', aggregate: 'Logistics.Card', command: 'topUp', kind: 'Member', expected: ['Gift'] },
        });
        expect(Logistics.availableCardCommands(member)).toEqual(['rename']);
        expect(Logistics.checkPickupSite({ state: 'Active', kind: 'Center', id: 'c', name: 'n', dockCount: 0 })).toEqual(['docksPositive']);
        expect(Logistics.checkPickupSite({ state: 'Active', kind: 'Store', id: 's', name: 'n', storeCode: 'x', closingTime: 30 })).toEqual(['openHours']);
    });

    test('the generated contract tests pass for the implementation, and fail for one that breaks a kind', async () => {
        const passing = await run(tests.Logistics.contract({ make, PickupSite: impl.pickupSite(), Card: impl.card() }, { runs: 30 }));
        expect(failing(passing)).toEqual([]);
        expect(Object.keys(passing).length).toBeGreaterThan(5);
        // closing at 30 o'clock breaks the Store's invariant
        const broken = impl.pickupSite({
            changeClosingTime: (site: object) => ({ ok: true, value: { changed: { aggregate: { ...site, closingTime: 30 }, events: {} } } }),
        });
        const r = await run(tests.Logistics.contract({ make, PickupSite: broken, Card: impl.card() }, { runs: 30 }));
        expect(failing(r).some((name) => name.includes('changeClosingTime'))).toBe(true);

        const wrongCreate = impl.pickupSite({
            registerStore: (({ id, name, storeCode, closingTime }: any) => ({
                ok: true,
                value: {
                    registered: {
                        aggregate: { state: 'Active', kind: 'Store', id: `${id}-wrong`, name, storeCode, closingTime },
                        events: { 'Logistics.Registered': { type: 'Logistics.Registered', pickupSiteId: id } },
                    },
                },
            })) as any,
        });
        const createResult = await run(tests.Logistics.contract({ make, PickupSite: wrongCreate, Card: impl.card() }, { runs: 30 }));
        const createFailure = Object.entries(createResult).find(([name, message]) => name.includes('registerStore') && message);
        expect(createFailure?.[1]).toContain('violates postcondition (changes id)');
        expect(createFailure?.[1]).toContain("for outcome 'registered': id = id");

        // suspend declares only a transition and emits; its generated frame check still rejects a changed carried id.
        const brokenSuspend = impl.pickupSite({
            suspend: ((site: any) => ({
                ok: true,
                value: { suspended: { aggregate: { ...site, state: 'Paused', id: `${site.id}-wrong` }, events: {} } },
            })) as any,
        });
        const suspendResult = await run(tests.Logistics.contract({ make, PickupSite: brokenSuspend, Card: impl.card() }, { runs: 30 }));
        const suspendFailure = Object.entries(suspendResult).find(([name, message]) => name.includes('suspend') && message);
        expect(suspendFailure?.[1]).toContain('violates postcondition (unchanged id)');
    });
});
