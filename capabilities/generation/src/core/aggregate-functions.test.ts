// Functions of the aggregate in the generated TypeScript (state match B; the rules of the DSL:
// contexts/modeling/src/domain/rules/aggregate-functions.test.ts): a parameter of an aggregate's type is typed as the
// aggregate (`o: Order`), which every state type of it is assignable to, and `match (o)` tests its state or kind; the
// checks pass `this`, `before` and `after` as they are. Type-checked strictly, and run by the checks and `decideNamed`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { check, generateFromAnalysis } from '../test-helpers.js';
import { irMisses, irSymbolMisses, resetIrMisses } from './checks.js';

const TSC = path.join(import.meta.dir, '..', '..', '..', '..', 'node_modules', '.bin', 'tsc');

/** Order: states (the functions in an invariant, requires, a choice rule, changes and ensures). Site: kinds with states. */
const MODEL = `context Shop {
  id OrderId: UUID
  id SiteId: UUID

  function isOpen(o: Order): Bool { match (o) { Draft => true, Confirmed => true, Cancelled => false } }
  /// what an open order is worth at a time: a confirmed one only once confirmed
  function openTotal(o: Order, at: Timestamp): Int {
    isOpen(o) ? match (o) { Draft => o.total, Confirmed { confirmedAt } => confirmedAt <= at ? o.total : 0, Cancelled => 0 } : 0
  }
  /// an optional field, compared with null first
  function noted(o: Order): Bool { o.note != null && o.note.length > 0 }
  function busy(s: Site): Bool {
    match (s) { Store { hours } => hours > 8, Center => match (s) { Active => s.docks > 0, Paused { reason } => reason != "" } }
  }

  aggregate Order {
    id: OrderId
    note: String?
    total: Int
    initial Draft
    state Draft
    state Confirmed { confirmedAt: Timestamp }
    state Cancelled { reason: String }
    invariant closedHasNoTotal { isOpen(this) || total == 0 }
    create command open(id: OrderId) {
      outcome opened: -> Draft
        changes id = id, total = 0
        ensures { isOpen(after) }
    }
    command confirm(at: Timestamp) {
      outcome confirmed: Draft -> Confirmed
        changes confirmedAt = at
    }
    command cancel(why: String, at: Timestamp) {
      requires worthCancelling { openTotal(this, at) < 100 } else TooLate
      outcome cancelled: Draft | Confirmed -> Cancelled select { isOpen(this) }
        changes reason = openTotal(before, at) > 0 ? why : "empty", total = 0
        ensures { isOpen(before) && !isOpen(after) }
    }
    command annotate(n: String) {
      requires fresh { !noted(this) } else TooLate
      outcome annotated: Draft -> Draft
        changes note = n
        ensures { (before.note == null || before.note.length >= 0) && after.note != null && after.note.length > 0 }
    }
  }

  aggregate Site {
    id: SiteId
    state Active
    state Paused { reason: String }
    invariant sane { busy(this) || true }
    command pause(why: String) {
      requires idle { !busy(this) } else TooLate
    }
    kind Store {
      hours: Int
      create command openStore(id: SiteId, hours: Int) {
        outcome opened: -> Active
          changes id = id, hours = hours
      }
      on pause {
        outcome paused: Active -> Paused
          changes reason = why
      }
    }
    kind Center {
      docks: Int
      create command openCenter(id: SiteId, docks: Int) {
        outcome opened: -> Active
          changes id = id, docks = docks
      }
      on pause {
        outcome paused: Active -> Paused
          changes reason = why
      }
    }
  }
  error TooLate
}
`;

const generated = async (): Promise<string> => {
    const a = await check({ 'shop.dt': MODEL });
    expect(a.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)).toEqual([]);
    return generateFromAnalysis(a).find((f) => f.path === 'Shop.ts')!.content;
};

/** The lines of the generated function `name`, from its `export` to its closing brace. */
const fn = (code: string, name: string): string => {
    const start = code.indexOf(`export function ${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    return code.slice(start, code.indexOf('\n}\n', start) + 2);
};

describe('functions of the aggregate in the generated TypeScript', () => {
    test('a function takes the aggregate in any state, and tests its state or kind', async () => {
        const code = await generated();
        expect(fn(code, 'isOpen')).toBe(
            ['export function isOpen(o: Order): boolean {', "    return (o.state === 'Draft' ? true : o.state === 'Confirmed' ? true : false);", '}'].join(
                '\n',
            ),
        );
        expect(fn(code, 'openTotal')).toBe(
            [
                'export function openTotal(o: Order, at: Timestamp): number {',
                "    return (isOpen(o) ? (o.state === 'Draft' ? o.total : o.state === 'Confirmed' ? ((o.confirmedAt <= at) ? o.total : 0) : 0) : 0);",
                '}',
            ].join('\n'),
        );
        // an optional field compared with null: TypeScript narrows it as the checker does
        expect(fn(code, 'noted')).toBe(
            ['export function noted(o: Order): boolean {', '    return ((o.note !== undefined) && (Array.from(o.note).length > 0));', '}'].join('\n'),
        );
        expect(fn(code, 'busy')).toBe(
            [
                'export function busy(s: Site): boolean {',
                "    return (s.kind === 'Store' ? (s.hours > 8) : (s.state === 'Active' ? (s.docks > 0) : !(s.reason === '')));",
                '}',
            ].join('\n'),
        );
    });

    test('the checks pass this, before and after: the aggregate check takes the aggregate, the others their narrower types', async () => {
        const code = await generated();
        expect(fn(code, 'checkOrderCommon')).toBe(
            [
                "export function checkOrderCommon(order: Order): readonly 'closedHasNoTotal'[] {",
                "    const violated: 'closedHasNoTotal'[] = [];",
                "    if (!(isOpen(order) || (order.total === 0))) violated.push('closedHasNoTotal');",
                '    return violated;',
                '}',
            ].join('\n'),
        );
        expect(fn(code, 'checkCancelOrderRequires')).toBe(
            [
                "export function checkCancelOrderRequires(order: DraftOrder | ConfirmedOrder, params: CancelOrderParams): 'worthCancelling' | undefined {",
                "    if (!((openTotal(order, params.at) < 100))) return 'worthCancelling';",
                '    return undefined;',
                '}',
            ].join('\n'),
        );
        expect(fn(code, 'checkCancelOrderChoice')).toContain('isOpen(order)');
        const ensures = fn(code, 'checkCancelOrderEnsures');
        expect(ensures).toContain(
            "if (value.cancelled.aggregate.reason !== ((openTotal(order, params.at) > 0) ? params.why : 'empty')) return { id: 'Shop.Order:cancel->cancelled.changes.reason'",
        );
        expect(ensures).toContain(
            "if (!(isOpen(order))) return { id: 'Shop.Order:cancel->cancelled.ensures', outcome: 'cancelled', kind: 'ensures', source: 'isOpen(before)' };",
        );
        expect(ensures).toContain(
            "if (!(!(isOpen(value.cancelled.aggregate)))) return { id: 'Shop.Order:cancel->cancelled.ensures', outcome: 'cancelled', kind: 'ensures', source: '!isOpen(after)' };",
        );
        expect(fn(code, 'checkOpenOrderEnsures')).toContain('if (!(isOpen(value.opened.aggregate)))');
        // before.note and after.note, narrowed by their comparisons with null
        const annotate = fn(code, 'checkAnnotateOrderEnsures');
        expect(annotate).toContain('if (order.note !== undefined && !(Array.from(order.note).length >= 0)) return {');
        expect(annotate).toContain('if (!(value.annotated.aggregate.note !== undefined)) return {');
        expect(annotate).toContain('if (!(Array.from(value.annotated.aggregate.note).length > 0)) return {');
        expect(fn(code, 'checkAnnotateOrderRequires')).toContain("if (!(!(noted(order)))) return 'fresh';");
        expect(fn(code, 'checkSiteCommon')).toContain("if (!(busy(site) || true)) violated.push('sane');");
        expect(fn(code, 'checkPauseSiteRequires')).toContain("if (!(!(busy(site)))) return 'idle';");
    });

    test('every expression of a function of the aggregate, and of its calls, has a Semantic IR node and symbol', async () => {
        const a = await check({ 'shop.dt': MODEL });
        resetIrMisses();
        generateFromAnalysis(a);
        expect(irMisses).toBe(0);
        expect(irSymbolMisses).toBe(0);
    });
});

/** The functions called directly with each state type, and the checks of Order through `decideNamed`. */
const IMPLEMENTATION = `import { Shop } from '../generated/index.js';

export const open = (order: Shop.DraftOrder | Shop.ConfirmedOrder | Shop.CancelledOrder): boolean => Shop.isOpen(order);
export const total = (order: Shop.ConfirmedOrder, at: Shop.CancelOrderParams['at']): number => Shop.openTotal(order, at);
export const noted = (order: Shop.DraftOrder): boolean => Shop.noted(order);
export const busy = (site: Shop.StoreActiveSite | Shop.CenterPausedSite): boolean => Shop.busy(site);
export const invariants = (order: Shop.Order): readonly string[] => Shop.checkOrder(order);
export const requires = (order: Shop.DraftOrder | Shop.ConfirmedOrder, at: Shop.CancelOrderParams['at']) =>
    Shop.checkCancelOrderRequires(order, { why: 'w', at });
`;

describe('functions of the aggregate: the generated code type-checks and runs', () => {
    let dir: string;

    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-aggregate-functions-'));
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

    test('strictly, without assertions', () => {
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

    test('the functions choose by the state and kind, in the invariant, the requirement and the postconditions', async () => {
        const { open, total, noted, busy, invariants, requires } = await import(path.join(dir, 'src', 'impl.ts'));
        const rt = await import(path.join(dir, 'generated', '_runtime.ts'));
        const Shop = await import(path.join(dir, 'generated', 'Shop.ts'));
        const id = '6f1c2f4e-8a3b-4c5d-9e7f-0a1b2c3d4e5f';
        const at = '2026-11-29T10:00:00Z';
        const draft = { state: 'Draft', id, total: 5 };
        const confirmed = { state: 'Confirmed', id, total: 500, confirmedAt: at };
        expect(open(draft)).toBe(true);
        expect(open({ state: 'Cancelled', id, total: 0, reason: 'r' })).toBe(false);
        expect(total(confirmed, '2026-11-30T10:00:00Z')).toBe(500);
        expect(total(confirmed, '2026-11-28T10:00:00Z')).toBe(0);
        expect(noted(draft)).toBe(false);
        expect(noted({ ...draft, note: '' })).toBe(false);
        expect(noted({ ...draft, note: 'n' })).toBe(true);
        expect(busy({ state: 'Active', kind: 'Store', id, hours: 9 })).toBe(true);
        expect(busy({ state: 'Paused', kind: 'Center', id, docks: 0, reason: '' })).toBe(false);
        // the invariant: a cancelled order keeps no total
        expect(invariants({ state: 'Cancelled', id, total: 3, reason: 'r' })).toEqual(['closedHasNoTotal']);
        expect(invariants(draft)).toEqual([]);
        // the requirement: what the order is worth at the time
        expect(requires(confirmed, '2026-11-30T10:00:00Z')).toBe('worthCancelling');
        expect(requires(confirmed, '2026-11-28T10:00:00Z')).toBeUndefined();
        // through decideNamed: the reason of an order worth something is the one given
        const cancel = (reason: string) =>
            rt.decideNamed()(
                Shop.OrderShape,
                { cancelled: 'Cancelled' },
                () => ok({ cancelled: { set: { reason, total: 0 }, events: {} } }),
                { availability: Shop.OrderAvailability, command: 'cancel' },
                { ensures: Shop.checkCancelOrderEnsures },
            );
        expect(cancel('w')(draft, { why: 'w', at }).ok).toBe(true);
        expect(cancel('empty')({ ...draft, total: 0 }, { why: 'w', at }).ok).toBe(true);
        let thrown: unknown;
        try {
            cancel('empty')(draft, { why: 'w', at });
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe(
            'DomainTrail postcondition violated: Shop.Order:cancel->cancelled.changes.reason: reason = openTotal(before, at) > 0? why: "empty"',
        );
    });
});

const ok = (value: object) => ({ ok: true, value });
