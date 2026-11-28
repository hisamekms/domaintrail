import { describe, expect, test } from 'bun:test';
import { checkSales } from '../../test-helpers.js';

/** A pickup site (ADR 0037): a store or a distribution center, with a common `suspend` decided per kind. */
const SITE = `
  id SiteId: UUID
  primitive StoreCode: String
  event Registered { siteId: SiteId }
  event Suspended { siteId: SiteId }
  error DocksInUse
  aggregate Site {
    id: SiteId
    name: String
    invariant named { name.length > 0 }
    state Active
    state Paused
    command suspend()
    kind Store {
      storeCode: StoreCode
      closingTime: String
      create command registerStore(id: SiteId, name: String, storeCode: StoreCode, closingTime: String) {
        outcome registered: -> Active
          emits Registered
      }
      command changeClosingTime(newClosingTime: String) {
        requires differs { newClosingTime != closingTime } else DocksInUse
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
      create command registerCenter(id: SiteId, name: String, dockCount: Int) {
        outcome registered: -> Active
          emits Registered
      }
      on suspend {
        requires fewDocks { dockCount < 50 } else DocksInUse
        outcome suspended: Active -> Paused
          emits Suspended
      }
    }
  }
`;

const messages = (a: Awaited<ReturnType<typeof checkSales>>, code: string) => a.diagnostics.filter((d) => d.code === code).map((d) => d.message);

describe('aggregate kinds (ADR 0037)', () => {
    test('a valid model: kinds with fields, invariants, their own commands and on cases', async () => {
        const a = await checkSales(SITE);
        expect(a.diagnostics).toEqual([]);
        const agg = a.model!.elements.find((e) => e.kind === 'aggregate' && e.name === 'Site')!;
        if (agg.kind !== 'aggregate') throw new Error('aggregate missing');
        expect(agg.kinds.map((k) => [k.name, k.fields.map((f) => f.name)])).toEqual([
            ['Store', ['storeCode', 'closingTime']],
            ['Center', ['dockCount']],
        ]);
        expect(agg.kinds[0]!.id as string).toBe('Sales.Site/Store');
        expect(agg.commands.map((c) => [c.name, c.kind])).toEqual([
            ['suspend', undefined],
            ['registerStore', 'Store'],
            ['changeClosingTime', 'Store'],
            ['registerCenter', 'Center'],
        ]);
    });

    test('a kind field is in scope only inside its kind', async () => {
        const a = await checkSales(SITE.replace('invariant named { name.length > 0 }', 'invariant named { name.length > 0 && dockCount > 0 }'));
        expect(messages(a, 'M010')).toEqual(["Field 'dockCount' exists only in kind 'Center' and is not in scope here."]);
        const other = await checkSales(SITE.replace('requires fewDocks { dockCount < 50 }', 'requires fewDocks { closingTime.length < 50 }'));
        expect(messages(other, 'M010')).toEqual(["Field 'closingTime' exists only in kind 'Store' and is not in scope here."]);
    });

    test('a common behaviour and an on case for the same command, and a kind without its case, are errors', async () => {
        const mixed = await checkSales(SITE.replace('command suspend()', 'command suspend() { outcome suspended: Active -> Paused }'));
        expect(messages(mixed, 'M030').filter((m) => m.includes('either common or in every kind'))).toHaveLength(2);
        // the mix is reported once per case, without the outcome errors that follow from it
        expect(messages(mixed, 'M028')).toEqual([]);
        const missing = await checkSales(
            SITE.replace(
                `      on suspend {
        requires fewDocks { dockCount < 50 } else DocksInUse
        outcome suspended: Active -> Paused
          emits Suspended
      }`,
                '',
            ),
        );
        expect(messages(missing, 'M030')).toEqual(["Command 'suspend' has its behaviour in the kinds' 'on' cases, but kind 'Center' has no 'on suspend'."]);
    });

    test('an on case names a common command that is not a factory', async () => {
        const a = await checkSales(
            SITE.replace(
                'on suspend {\n        requires fewDocks',
                'on changeClosingTime { outcome x: Active -> Active }\n      on suspend {\n        requires fewDocks',
            ),
        );
        expect(messages(a, 'M030').some((m) => m.includes("names a command of kind 'Store'"))).toBe(true);
    });

    test("factories are the kinds': a common one, and a kind without one, are errors", async () => {
        const common = await checkSales(
            SITE.replace('command suspend()', 'command suspend()\n    create command register(id: SiteId) { outcome r: -> Active }'),
        );
        expect(messages(common, 'M030').some((m) => m.includes("Create command 'register' is common"))).toBe(true);
        const none = await checkSales(
            SITE.replace(
                `      create command registerCenter(id: SiteId, name: String, dockCount: Int) {
        outcome registered: -> Active
          emits Registered
      }`,
                '',
            ),
        );
        expect(messages(none, 'M030')).toContain("Kind 'Center' of 'Site' has no create command, so no 'Site' of that kind can be made.");
    });

    test("kind names and fields are unique, and a field named kind is the discriminator's", async () => {
        const a = await checkSales(SITE.replace('dockCount: Int', 'dockCount: Int\n      name: String\n      kind: String'));
        expect(messages(a, 'M002')).toContain("Field 'name' of kind 'Center' shadows the common field of 'Site'.");
        expect(messages(a, 'M030')).toContain("Field 'kind' of 'Site' has the name of the discriminator of its kinds.");
    });

    test('with kinds and states, the transition shorthand is an error', async () => {
        const a = await checkSales(SITE.replace('command suspend()', 'command suspend()\n    command pause()\n      Active -> Paused'));
        expect(messages(a, 'M030').some((m) => m.includes("'pause' of 'Site' uses the transition shorthand"))).toBe(true);
    });

    test('kinds without states take the shorthand commands of an aggregate without states', async () => {
        const a = await checkSales(`
          id CardId: UUID
          aggregate Card {
            id: CardId
            label: String
            command rename(newLabel: String) changes label
            kind Gift { amount: Int create command makeGift(id: CardId, label: String, amount: Int) command topUp(more: Int) changes amount }
            kind Member { level: Int create command makeMember(id: CardId, label: String, level: Int) }
          }`);
        expect(a.diagnostics).toEqual([]);
        const wrong = await checkSales(`
          id CardId: UUID
          aggregate Card {
            id: CardId
            label: String
            command rename(newLabel: String) changes amount
            kind Gift { amount: Int create command makeGift(id: CardId, label: String, amount: Int) }
            kind Member { level: Int create command makeMember(id: CardId, label: String, level: Int) }
          }`);
        expect(messages(wrong, 'M021')).toEqual(["Field 'amount' exists only in kind 'Gift', and 'rename' is a common command."]);
    });

    test('M031: kinds that declare nothing, a field in every kind, and a state no kind reaches', async () => {
        const empty = await checkSales('id TId: UUID aggregate T { id: TId kind A {} kind B {} }');
        expect(messages(empty, 'M031')).toHaveLength(1);
        const same = await checkSales(
            SITE.replace('dockCount: Int', 'dockCount: Int\n      phone: String').replace('closingTime: String', 'closingTime: String\n      phone: String'),
        );
        expect(messages(same, 'M031')).toEqual(["Every kind of 'Site' declares field 'phone' with the same type: it is a common field."]);
        const unreached = await checkSales(SITE.replace('state Paused', 'state Paused\n    state Closed'));
        expect(messages(unreached, 'M031')).toEqual(["No kind of 'Site' reaches state 'Closed'."]);
    });

    test('M031: on cases alike in every kind are a common behaviour; cases that differ are not', async () => {
        const alike = await checkSales(SITE.replace('        requires fewDocks { dockCount < 50 } else DocksInUse\n', ''));
        expect(messages(alike, 'M031')).toEqual(["Every kind of 'Site' decides 'suspend' alike in its 'on suspend' case: the behaviour is common."]);
        expect(messages(await checkSales(SITE), 'M031')).toEqual([]);
    });

    test('M031: optional fields required for some values of an enum field are the fields of kinds', async () => {
        const a = await checkSales(`
          id SId: UUID
          enum SiteKind { STORE CENTER }
          aggregate S {
            id: SId
            readonly type: SiteKind
            storeCode: String?
            dockCount: Int?
            invariant storeHasCode { !(type == SiteKind.STORE) || storeCode != null }
            invariant centerHasDocks { !(type == SiteKind.CENTER) || dockCount != null }
            create command make(id: SId, type: SiteKind)
          }`);
        expect(messages(a, 'M031')).toHaveLength(1);
        expect(messages(a, 'M031')[0]).toContain("only for some values of 'type'");
    });
});
