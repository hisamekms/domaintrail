// The generated postcondition checks (`check<Command>Ensures`, ADR 0043) type-checked by strict tsc, and run by
// `decide`, `decideNamed` and `decideByKind` through `{ ensures }`: a correct result passes, a wrong `changes` value, a
// changed field the outcome does not list and a violated `ensures` throw.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { check, generateFromAnalysis } from '../test-helpers.js';

const TSC = path.join(import.meta.dir, '..', '..', '..', '..', 'node_modules', '.bin', 'tsc');

/**
 * Cart: named outcomes (a create, `changes x = e` over a list, a Decimal and an owned entity, a bare `changes` with
 * `ensures`, two outcomes from one state over an optional union), the shorthand form (one target, several sources and
 * targets, a bare `changes` with `ensures`). Site: kinds, each with its own `on pause` contract and create.
 */
const MODEL = `context Shop {
  id CartId: UUID
  id LineId: UUID
  id SiteId: UUID
  id CardId: UUID
  value Money { amount: Decimal(2) currency: String }
  union Discount { Percent { rate: Int } Fixed { off: Money } }
  entity Line { id: LineId qty: Int price: Money }

  aggregate Cart {
    id: CartId
    owns lines: Line[0..*]
    total: Decimal(2)
    note: String?
    discount: Discount?
    revision: Int
    initial Open
    state Open
    state Held { heldBy: String }
    state Closed { closedAt: Timestamp reason: String? }
    create command open(id: CartId) {
      outcome opened: -> Open
        changes id = id, lines = [], total = 0, revision = 0
    }
    command addLine(line: Line) {
      outcome added: Open -> Open
        changes lines = [...before.lines, line], total = before.total + line.price.amount, revision
        ensures { after.revision > before.revision && after.lines.length == before.lines.length + 1 }
    }
    command applyDiscount(d: Discount?) {
      outcome discounted: Open -> Open select { lines.length > 0 }
        changes discount = d
      outcome discountedHeld: Open -> Held select { lines.length == 0 }
        changes discount = d, heldBy = "discount", note
    }
    command hold(by: String) Open -> Held changes heldBy = by
    command close(at: Timestamp, why: String?) Open | Held -> Closed | Open
      changes closedAt = at, reason = why, revision = before.revision + 1
    command touch() Open -> Open
      changes revision
      ensures { after.revision > before.revision }
  }

  aggregate Site {
    id: SiteId
    name: String
    note: String?
    score: Int
    state Active
    state Paused { reason: String }
    command pause(reason: String)
    kind Store {
      hours: Int
      create command openStore(id: SiteId, name: String, hours: Int) {
        outcome opened: -> Active
          changes id = id, name = name, hours = hours, score = 0
      }
      on pause {
        outcome paused: Active -> Paused
          changes reason = reason, score
          ensures { after.score > before.score }
      }
    }
    kind Center {
      docks: Int
      create command openCenter(id: SiteId, name: String, docks: Int) {
        outcome opened: -> Active
          changes id = id, name = name, docks = docks, score = 0
      }
      on pause {
        outcome paused: Active -> Paused
          changes reason = reason
          ensures { after.docks > 0 || before.docks <= 0 }
      }
    }
  }

  aggregate Card {
    id: CardId
    label: String
    command rename(newLabel: String) changes label = newLabel
    kind Gift {
      amount: Int
      create command makeGift(id: CardId, label: String, amount: Int) changes id = id, label = label, amount = amount
    }
    kind Member {
      level: Int
      create command makeMember(id: CardId, label: String, level: Int) changes id = id, label = label, level = level
    }
  }
}
`;

/** The commands implemented with `decide`, `decideNamed` and `decideByKind`, each checking its postconditions. */
const IMPLEMENTATION = `import { Shop, decide, decideByKind, decideNamed, decimalAdd, ok, parseDecimal, type Verify } from '../generated/index.js';

const zero = parseDecimal('0')!;

export const cart: Shop.CartCommands = {
    open: decideNamed<Shop.OpenCartDecision>()(
        Shop.CartShape,
        { opened: 'Open' },
        ({ id }) => ok({ opened: { set: { id, lines: [], total: zero, note: undefined, discount: undefined, revision: 0 }, events: {} } }),
        undefined,
        { ensures: Shop.checkOpenCartEnsures },
    ),
    addLine: decideNamed<Shop.AddLineCartDecision>()(
        Shop.CartShape,
        { added: 'Open' },
        (cart, { line }) => ok({ added: { set: { lines: [...cart.lines, line], total: decimalAdd(cart.total, line.price.amount), revision: cart.revision + 1 }, events: {} } }),
        { availability: Shop.CartAvailability, command: 'addLine' },
        { ensures: Shop.checkAddLineCartEnsures },
    ),
    applyDiscount: decideNamed<Shop.ApplyDiscountCartDecision>()(
        Shop.CartShape,
        { discounted: 'Open', discountedHeld: 'Held' },
        (cart, { d }) =>
            cart.lines.length > 0 ? ok({ discounted: { set: { discount: d }, events: {} } }) : ok({ discountedHeld: { set: { discount: d, heldBy: 'discount', note: cart.note }, events: {} } }),
        { availability: Shop.CartAvailability, command: 'applyDiscount' },
        { ensures: Shop.checkApplyDiscountCartEnsures },
    ),
    hold: decide<Shop.HoldCartDecision>(Shop.CartShape, { Open: (_cart, { by }) => ok({ Held: { set: { heldBy: by }, events: {} } }) }, {}, { ensures: Shop.checkHoldCartEnsures }),
    close: decide<Shop.CloseCartDecision>(
        Shop.CartShape,
        {
            Open: (cart, { at, why }) => ok({ Closed: { set: { closedAt: at, reason: why, revision: cart.revision + 1 }, events: {} } }),
            Held: (cart, { at, why }) => ok({ Closed: { set: { closedAt: at, reason: why, revision: cart.revision + 1 }, events: {} } }),
        },
        {},
        { ensures: Shop.checkCloseCartEnsures },
    ),
    touch: decide<Shop.TouchCartDecision>(Shop.CartShape, { Open: (cart) => ok({ Open: { set: { revision: cart.revision + 1 }, events: {} } }) }, {}, { ensures: Shop.checkTouchCartEnsures }),
};

export const site: Shop.SiteCommands = {
    openStore: decideNamed<Shop.OpenStoreSiteDecision>()(
        Shop.SiteShape,
        { opened: 'Active' },
        ({ id, name, hours }) => ok({ opened: { set: { kind: 'Store', id, name, hours, score: 0, note: undefined }, events: {} } }),
        undefined,
        { ensures: Shop.checkOpenStoreSiteEnsures },
    ),
    openCenter: decideNamed<Shop.OpenCenterSiteDecision>()(
        Shop.SiteShape,
        { opened: 'Active' },
        ({ id, name, docks }) => ok({ opened: { set: { kind: 'Center', id, name, docks, score: 0, note: undefined }, events: {} } }),
        undefined,
        { ensures: Shop.checkOpenCenterSiteEnsures },
    ),
    pause: decideByKind<Shop.PauseSiteDecision>()(
        Shop.SiteShape,
        { paused: 'Paused' },
        {
            Store: (site, { reason }) => ok({ paused: { set: { reason, score: site.score + 1 }, events: {} } }),
            Center: (_site, { reason }) => ok({ paused: { set: { reason }, events: {} } }),
        },
        { availability: Shop.SiteAvailability, command: 'pause' },
        { ensures: Shop.checkPauseSiteEnsures },
    ),
};

// the choice check takes both of its functions: one alone does not type-check
// @ts-expect-error choices without applicable
export const partial: Verify = { choices: () => ({}) };

/** The shorthand form with kinds: a command of every kind checks the fields each kind carries over. */
export const card: Shop.CardCommands = {
    makeGift: decide<Shop.MakeGiftCardDecision>(Shop.CardShape, ({ id, label, amount }) => ok({ Card: { set: { kind: 'Gift', id, label, amount }, events: {} } }), {}, { ensures: Shop.checkMakeGiftCardEnsures }),
    makeMember: decide<Shop.MakeMemberCardDecision>(Shop.CardShape, ({ id, label, level }) => ok({ Card: { set: { kind: 'Member', id, label, level }, events: {} } }), {}, { ensures: Shop.checkMakeMemberCardEnsures }),
    rename: decide<Shop.RenameCardDecision>(Shop.CardShape, (_card, { newLabel }) => ok({ Card: { set: { label: newLabel }, events: {} } }), {}, { ensures: Shop.checkRenameCardEnsures }),
};

// the check called directly, with the command's arguments and its success value
export function addLineChecked(open: Shop.OpenCart, line: Shop.Line): string | undefined {
    const r = cart.addLine(open, { line });
    if (!r.ok) return undefined;
    const violation = Shop.checkAddLineCartEnsures(open, { line }, r.value);
    violation?.id satisfies 'Shop.Cart:addLine->added.changes.lines' | 'Shop.Cart:addLine->added.changes.total' | 'Shop.Cart:addLine->added.unchanged.id' | 'Shop.Cart:addLine->added.unchanged.note' | 'Shop.Cart:addLine->added.unchanged.discount' | 'Shop.Cart:addLine->added.ensures' | undefined;
    return violation?.kind;
}
`;

describe('postcondition checks in the generated TypeScript', () => {
    let dir: string;

    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-ensures-'));
        const a = await check({ 'shop.dt': MODEL });
        expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        await mkdir(path.join(dir, 'generated'));
        for (const f of generateFromAnalysis(a)) await writeFile(path.join(dir, 'generated', f.path), f.content);
        await mkdir(path.join(dir, 'src'));
        await writeFile(path.join(dir, 'src', 'impl.ts'), IMPLEMENTATION);
    });

    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test('the checks and the commands that pass them to decide type-check strictly, without assertions', () => {
        const r = Bun.spawnSync(
            [
                process.execPath,
                TSC,
                '--noEmit',
                '--strict',
                '--noUnusedLocals',
                '--target',
                'ES2023',
                '--module',
                'preserve',
                '--moduleResolution',
                'bundler',
                '--lib',
                'ES2023,DOM',
                'src/impl.ts',
            ],
            { cwd: dir },
        );
        expect(r.stdout.toString() + r.stderr.toString()).toBe('');
        expect(r.exitCode).toBe(0);
    });

    test('a correct result passes the checks, through decide and called directly', async () => {
        const { cart, site, card, addLineChecked } = await import(path.join(dir, 'src', 'impl.ts'));
        const opened = cart.open({ id: CART });
        expect(opened.ok).toBe(true);
        const open = opened.value.opened.aggregate;
        expect(open).toEqual({ state: 'Open', id: CART, lines: [], total: '0', revision: 0 });
        expect(cart.addLine(open, { line: LINE }).ok).toBe(true);
        expect(addLineChecked(open, LINE)).toBeUndefined();
        expect(cart.applyDiscount(open, { d: { kind: 'Percent', rate: 5 } }).value.discountedHeld.aggregate.discount).toEqual({ kind: 'Percent', rate: 5 });
        expect(cart.hold(open, { by: 'x' }).ok).toBe(true);
        expect(cart.close(open, { at: AT }).value.Closed.aggregate).toMatchObject({ closedAt: AT, revision: 1 });
        expect(cart.touch(open).ok).toBe(true);
        const store = site.openStore({ id: SITE, name: 'a', hours: 9 }).value.opened.aggregate;
        expect(site.pause(store, { reason: 'r' }).value.paused.aggregate).toMatchObject({ kind: 'Store', state: 'Paused', score: 1 });
        const center = site.openCenter({ id: SITE, name: 'b', docks: 2 }).value.opened.aggregate;
        expect(site.pause(center, { reason: 'r' }).ok).toBe(true);
        const member = card.makeMember({ id: CART, label: 'm', level: 2 }).value.Card.aggregate;
        expect(card.rename(member, { newLabel: 'n' }).value.Card.aggregate).toEqual({ kind: 'Member', id: CART, label: 'n', level: 2 });
    });

    test('decide, decideNamed and decideByKind throw for a wrong changes value, a changed field kept and a violated ensures', async () => {
        const rt = await import(path.join(dir, 'generated', '_runtime.ts'));
        const Shop = await import(path.join(dir, 'generated', 'Shop.ts'));
        const open = { state: 'Open', id: CART, lines: [], total: '0', revision: 0 };
        const ok = (value: object) => ({ ok: true, value });
        const violated = (f: () => unknown, message: string, cause: object) => {
            let thrown: unknown;
            try {
                f();
            } catch (e) {
                thrown = e;
            }
            expect(thrown).toBeInstanceOf(Error);
            expect((thrown as Error).message).toBe(`DomainTrail postcondition violated: ${message}`);
            expect((thrown as Error).cause).toMatchObject(cause);
        };
        // decide (the shorthand form)
        const touch = (set: object) =>
            rt.decide(Shop.CartShape, { Open: () => ok({ Open: { set, events: {} } }) }, {}, { ensures: Shop.checkTouchCartEnsures })(open);
        const hold = (by: string) =>
            rt.decide(
                Shop.CartShape,
                { Open: () => ok({ Held: { set: { heldBy: by }, events: {} } }) },
                {},
                { ensures: Shop.checkHoldCartEnsures },
            )(open, { by: 'x' });
        expect(touch({ revision: 1 }).ok).toBe(true);
        violated(() => hold('y'), 'Shop.Cart:hold.changes.heldBy: heldBy = by', { outcome: 'Held', kind: 'changes', field: 'heldBy' });
        violated(() => touch({ revision: 1, note: 'sneaked' }), 'Shop.Cart:touch->Open.unchanged.note: after.note == before.note', {
            kind: 'unchanged',
            field: 'note',
        });
        violated(() => touch({ revision: 0 }), 'Shop.Cart:touch.ensures: after.revision > before.revision', { outcome: 'Open', kind: 'ensures' });
        // decideNamed
        const where = { availability: Shop.CartAvailability, command: 'addLine' };
        const addLine = (set: object) =>
            rt.decideNamed()(Shop.CartShape, { added: 'Open' }, () => ok({ added: { set, events: {} } }), where, { ensures: Shop.checkAddLineCartEnsures })(
                open,
                { line: LINE },
            );
        expect(addLine({ lines: [LINE], total: '1.5', revision: 1 }).ok).toBe(true); // Decimal by value: 1.5 == 1.50
        violated(
            () => addLine({ lines: [LINE], total: '2.50', revision: 1 }),
            'Shop.Cart:addLine->added.changes.total: total = before.total + line.price.amount',
            {
                kind: 'changes',
                field: 'total',
            },
        );
        violated(
            () => addLine({ lines: [{ ...LINE, qty: 2 }], total: '1.50', revision: 1 }),
            'Shop.Cart:addLine->added.changes.lines: lines = [... before.lines, line]',
            {
                field: 'lines',
            },
        );
        violated(() => addLine({ lines: [LINE], total: '1.50', revision: 1, id: OTHER }), 'Shop.Cart:addLine->added.unchanged.id: after.id == before.id', {
            kind: 'unchanged',
            field: 'id',
        });
        violated(() => addLine({ lines: [LINE], total: '1.50', revision: 0 }), 'Shop.Cart:addLine->added.ensures: after.revision > before.revision', {
            kind: 'ensures',
        });
        // an optional field a create does not list starts absent
        const create = (set: object) =>
            rt.decideNamed()(Shop.CartShape, { opened: 'Open' }, () => ok({ opened: { set, events: {} } }), undefined, { ensures: Shop.checkOpenCartEnsures })({
                id: CART,
            });
        expect(create({ id: CART, lines: [], total: '0.00', revision: 0 }).ok).toBe(true);
        violated(() => create({ id: CART, lines: [], total: '0', revision: 0, note: 'x' }), 'Shop.Cart:open->opened.unchanged.note: after.note == null', {
            outcome: 'opened',
            field: 'note',
        });
        // decideByKind
        const store = { kind: 'Store', state: 'Active', id: SITE, name: 'a', score: 0, hours: 9 };
        const pause = (set: object) =>
            rt.decideByKind()(
                Shop.SiteShape,
                { paused: 'Paused' },
                { Store: () => ok({ paused: { set, events: {} } }), Center: () => ok({ paused: { set, events: {} } }) },
                { availability: Shop.SiteAvailability, command: 'pause' },
                { ensures: Shop.checkPauseSiteEnsures },
            )(store, { reason: 'r' });
        expect(pause({ reason: 'r', score: 1 }).ok).toBe(true);
        violated(() => pause({ reason: 's', score: 1 }), 'Shop.Site/Store:on:pause->paused.changes.reason: reason = reason', { field: 'reason' });
        violated(() => pause({ reason: 'r', score: 1, hours: 10 }), 'Shop.Site/Store:on:pause->paused.unchanged.hours: after.hours == before.hours', {
            field: 'hours',
        });
        violated(() => pause({ reason: 'r', score: 1, kind: 'Center' }), 'Shop.Site/Store:on:pause->paused.unchanged.kind: after.kind == before.kind', {
            field: 'kind',
        });
        violated(() => pause({ reason: 'r', score: 0 }), 'Shop.Site/Store:on:pause->paused.ensures: after.score > before.score', { kind: 'ensures' });
        const gift = { kind: 'Gift', id: CART, label: 'a', amount: 5 };
        const rename = (set: object) =>
            rt.decide(Shop.CardShape, () => ok({ Card: { set, events: {} } }), {}, { ensures: Shop.checkRenameCardEnsures })(gift, { newLabel: 'b' });
        expect(rename({ label: 'b' }).ok).toBe(true);
        violated(() => rename({ label: 'b', amount: 6 }), 'Shop.Card:rename->*.unchanged.amount: after.amount == before.amount', {
            outcome: 'Card',
            field: 'amount',
        });
        // a result the check does not hold an outcome of passes (no outcome reached): the choice is not its business
        expect(Shop.checkTouchCartEnsures(open, {})).toBeUndefined();
    });
});

const CART = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000009';
const SITE = '00000000-0000-4000-8000-000000000003';
const AT = '2026-01-01T00:00:00.000Z';
const LINE = { id: '00000000-0000-4000-8000-000000000002', qty: 1, price: { amount: '1.50', currency: 'JPY' } };
