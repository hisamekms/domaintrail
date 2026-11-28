// `match` over the aggregate in the generated TypeScript: `match (this)` in requirements, choice rules and the
// aggregate's invariants, `match (before)` / `match (after)` in `changes x = e` and `ensures` (the rules of the DSL:
// contexts/modeling/src/domain/rules/state-match.test.ts). Conditionals on `state` / `kind` that TypeScript narrows,
// over the cases the aggregate can be in where the expression is; type-checked strictly, and run by `decideNamed`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { check, generateFromAnalysis } from '../test-helpers.js';
import { irMisses, irSymbolMisses, resetIrMisses } from './checks.js';

const TSC = path.join(import.meta.dir, '..', '..', '..', '..', 'node_modules', '.bin', 'tsc');

/** Order: states (requires, an invariant, changes and ensures, the shorthand form). Site: kinds with states (a nested match). */
const MODEL = `context Shop {
  id OrderId: UUID
  id SiteId: UUID

  aggregate Order {
    id: OrderId
    note: String?
    total: Int
    initial Draft
    state Draft
    state Confirmed { confirmedAt: Timestamp }
    state Cancelled { reason: String }
    invariant reasonGiven { match (this) { Draft => true, Confirmed => total > 0, Cancelled { reason } => reason != "" } }
    create command open(id: OrderId) {
      outcome opened: -> Draft
        changes id = id, total = 0
    }
    command confirm(at: Timestamp) {
      outcome confirmed: Draft -> Confirmed
        changes confirmedAt = at
    }
    command cancel(why: String, lateWhy: String, at: Timestamp) {
      requires notLate { match (this) { Draft => true, Confirmed { confirmedAt } => confirmedAt <= at } } else TooLate
      outcome cancelled: Draft | Confirmed -> Cancelled
        changes reason = match (before) { Draft => why, Confirmed => lateWhy }, total
        ensures {
          match (before) { Draft => after.total == 0, Confirmed { total } => after.total == total }
            && match (after) { Cancelled { reason } => reason != "" }
        }
    }
    command amend(n: Int) Draft -> Draft
      Confirmed -> Confirmed
      requires positive { match (this) { Draft => n >= 0, Confirmed => n > 0 } } else TooLate
      changes total = match (before) { Draft => n, Confirmed => before.total + n }
      ensures {
        match (after) {
          Draft => true,
          Confirmed { total } => match (before) { Confirmed { confirmedAt } => total > before.total || after.confirmedAt == confirmedAt }
        }
      }
  }

  aggregate Site {
    id: SiteId
    name: String
    score: Int
    state Active
    state Paused { reason: String }
    invariant positive {
      match (this) {
        Store { hours } => hours > 0,
        Center { docks } => match (this) { Active => docks >= 0, Paused { reason } => docks > 0 || reason != "" }
      }
    }
    command pause(reason: String)
    // decided per kind from other states: Store resumes from Paused, Center from Active
    command resume(by: Int) {
      requires resumable { match (this) { Store => match (this) { Paused { reason } => reason != "" }, Center { docks } => by <= docks } } else TooLate
    }
    command rate(by: Int) {
      requires sensible { match (this) { Store { hours } => by <= hours, Center => true } } else TooLate
      outcome rated: Active -> Active select { match (this) { Store => true, Center { docks } => docks > 0 } }
        changes score = match (before) { Store => before.score + by, Center => before.score }
        ensures { match (after) { Store { hours } => hours > 0, Center => true } }
    }
    kind Store {
      hours: Int
      create command openStore(id: SiteId, name: String, hours: Int) {
        outcome opened: -> Active
          changes id = id, name = name, hours = hours, score = 0
          ensures { match (after) { Store => after.hours > 0 } }
      }
      on pause {
        requires open { match (this) { Active => hours > 0 } } else TooLate
        outcome paused: Active -> Paused
          changes reason = reason, score
          ensures { match (before) { Store { score } => after.score > score } }
      }
      on resume {
        outcome resumed: Paused -> Active
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
      }
      on resume {
        outcome resumed: Active -> Active
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

describe('match over the aggregate in the generated TypeScript', () => {
    test('an invariant of the aggregate: its check takes the aggregate in any state, and tests the state it is in', async () => {
        const code = await generated();
        expect(fn(code, 'checkOrderCommon')).toBe(
            [
                "export function checkOrderCommon(order: Order): readonly 'reasonGiven'[] {",
                "    const violated: 'reasonGiven'[] = [];",
                "    if (!(order.state === 'Draft' ? true : order.state === 'Confirmed' ? (order.total > 0) : !(order.reason === ''))) violated.push('reasonGiven');",
                '    return violated;',
                '}',
            ].join('\n'),
        );
        // a kind case narrows the states of a match inside it to those of the kind
        expect(fn(code, 'checkSiteCommon')).toContain(
            "if (!(site.kind === 'Store' ? (site.hours > 0) : (site.state === 'Active' ? (site.docks >= 0) : ((site.docks > 0) || !(site.reason === ''))))) violated.push('positive');",
        );
        // the check of a state still passes its own type
        expect(fn(code, 'checkConfirmedOrder')).toContain('return checkOrderCommon(order);');
    });

    test('a requirement and a choice rule test the source states (or the kinds) of the command; one case is its body', async () => {
        const code = await generated();
        expect(fn(code, 'checkCancelOrderRequires')).toContain("if (!((order.state === 'Draft' ? true : (order.confirmedAt <= params.at)))) return 'notLate';");
        expect(fn(code, 'checkAmendOrderRequires')).toContain("if (!(order.state === 'Draft' ? (params.n >= 0) : (params.n > 0))) return 'positive';");
        expect(fn(code, 'checkRateSiteRequires')).toContain("if (!((site.kind === 'Store' ? (params.by <= site.hours) : true))) return 'sensible';");
        expect(fn(code, 'checkPauseSiteRequires')).toContain(
            "if ((site.kind === 'Store') && (site.state === 'Active')) { if (!((site.hours > 0))) return 'Store_open'; }",
        );
        // the (kind, state) pairs of a command decided per kind: a Store is Paused, a Center Active
        expect(fn(code, 'checkResumeSiteRequires')).toContain(
            "export function checkResumeSiteRequires(site: StorePausedSite | CenterActiveSite, params: ResumeSiteParams): 'resumable' | undefined {\n    if (!((site.kind === 'Store' ? !(site.reason === '') : (params.by <= site.docks)))) return 'resumable';",
        );
        expect(fn(code, 'checkRateSiteChoice')).toContain("rated: ((site.state === 'Active')) && ((site.kind === 'Store' ? true : (site.docks > 0)))");
    });

    test('changes and ensures: each source state (and kind) is a branch of its own, where the case of before and after is chosen', async () => {
        const code = await generated();
        const cancel = fn(code, 'checkCancelOrderEnsures');
        expect(cancel).not.toContain("order.state === 'Confirmed' ?");
        expect(cancel).toContain(
            "if ('cancelled' in value && value.cancelled !== undefined && order.state === 'Draft') {\n        if (value.cancelled.aggregate.reason !== params.why)",
        );
        expect(cancel).toContain("if (!(value.cancelled.aggregate.total === 0)) return { id: 'Shop.Order:cancel->cancelled.ensures'");
        expect(cancel).toContain(
            "if ('cancelled' in value && value.cancelled !== undefined && order.state === 'Confirmed') {\n        if (value.cancelled.aggregate.reason !== params.lateWhy)",
        );
        expect(cancel).toContain("if (!(value.cancelled.aggregate.total === order.total)) return { id: 'Shop.Order:cancel->cancelled.ensures'");
        // after in Confirmed came from Confirmed: the case of before is chosen with it
        const amend = fn(code, 'checkAmendOrderEnsures');
        expect(amend).toContain('if (value.Confirmed.aggregate.total !== (order.total + params.n))');
        expect(amend).toContain(
            "if (!((value.Confirmed.aggregate.total > order.total) || (value.Confirmed.aggregate.confirmedAt === order.confirmedAt))) return { id: 'Shop.Order:amend.ensures', outcome: 'Confirmed'",
        );
        const rate = fn(code, 'checkRateSiteEnsures');
        expect(rate).toContain("if (value.rated.aggregate.score !== (site.score + params.by)) return { id: 'Shop.Site:rate->rated.changes.score'");
        expect(rate).toContain("if (value.rated.aggregate.score !== site.score) return { id: 'Shop.Site:rate->rated.changes.score'");
        expect(rate).toContain("if (!(value.rated.aggregate.hours > 0)) return { id: 'Shop.Site:rate->rated.ensures'");
    });

    test('every expression of a match over the aggregate has a Semantic IR node and symbol', async () => {
        const a = await check({ 'shop.dt': MODEL });
        resetIrMisses();
        generateFromAnalysis(a);
        expect(irMisses).toBe(0);
        expect(irSymbolMisses).toBe(0);
    });
});

/** The commands of Order with `decideNamed` and `decide`, checking their postconditions. */
const IMPLEMENTATION = `import { Shop, decide, ok } from '../generated/index.js';

/** The postconditions of cancel, called directly with the command's arguments and a success value. */
export function cancelChecked(order: Shop.DraftOrder | Shop.ConfirmedOrder, total: number): string | undefined {
    const params = { why: 'w', lateWhy: 'l', at: order.state === 'Confirmed' ? order.confirmedAt : ('2026-11-29T10:00:00Z' as Shop.CancelOrderParams['at']) };
    const reason = order.state === 'Draft' ? params.why : params.lateWhy;
    const cancelled: Shop.CancelledOrder = { state: 'Cancelled', id: order.id, total, reason, ...(order.note !== undefined && { note: order.note }) };
    return Shop.checkCancelOrderEnsures(order, params, { cancelled: { aggregate: cancelled, events: {} } })?.source;
}

export const amend = decide<Shop.AmendOrderDecision>(
    Shop.OrderShape,
    {
        Draft: (_order, { n }) => ok({ Draft: { set: { total: n }, events: {} } }),
        Confirmed: (order, { n }) => ok({ Confirmed: { set: { total: order.total + n }, events: {} } }),
    },
    {},
    { ensures: Shop.checkAmendOrderEnsures },
);

export const invariants = (order: Shop.Order): readonly string[] => Shop.checkOrder(order);
export const requires = (order: Shop.DraftOrder | Shop.ConfirmedOrder, at: Shop.CancelOrderParams['at']) =>
    Shop.checkCancelOrderRequires(order, { why: 'w', lateWhy: 'l', at });
`;

describe('match over the aggregate: the generated checks type-check and run', () => {
    let dir: string;

    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-state-match-'));
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

    test('a result that holds the case of its source state passes; one that holds another case throws', async () => {
        const { cancelChecked, amend, invariants, requires } = await import(path.join(dir, 'src', 'impl.ts'));
        const rt = await import(path.join(dir, 'generated', '_runtime.ts'));
        const Shop = await import(path.join(dir, 'generated', 'Shop.ts'));
        const id = '6f1c2f4e-8a3b-4c5d-9e7f-0a1b2c3d4e5f';
        const at = '2026-11-29T10:00:00Z';
        const draft = { state: 'Draft', id, total: 5 };
        const confirmed = { state: 'Confirmed', id, total: 5, confirmedAt: at };
        // each source state holds its own case: from Draft the total is 0, from Confirmed it is kept
        expect(cancelChecked(draft, 0)).toBeUndefined();
        expect(cancelChecked(confirmed, 5)).toBeUndefined();
        expect(cancelChecked(draft, 5)).toBe('match (before) { Draft => after.total == 0, Confirmed { total } => after.total == total }');
        expect(cancelChecked(confirmed, 0)).toBe('match (before) { Draft => after.total == 0, Confirmed { total } => after.total == total }');
        expect(amend(confirmed, { n: 2 }).value.Confirmed.aggregate.total).toBe(7);
        // the invariant and the requirement choose by the state
        expect(invariants({ state: 'Cancelled', id, total: 0, reason: '' })).toEqual(['reasonGiven']);
        expect(invariants({ state: 'Confirmed', id, total: 0, confirmedAt: at })).toEqual(['reasonGiven']);
        expect(invariants({ state: 'Draft', id, total: 0 })).toEqual([]);
        expect(requires(confirmed, '2026-11-28T10:00:00Z')).toBe('notLate');
        expect(requires(draft, '2026-11-28T10:00:00Z')).toBeUndefined();
        // through decideNamed: from Confirmed, the total is kept, and the Draft case (total 0) does not hold there
        const wrong = rt.decideNamed()(
            Shop.OrderShape,
            { cancelled: 'Cancelled' },
            () => ok({ cancelled: { set: { reason: 'l', total: 0 }, events: {} } }),
            { availability: Shop.OrderAvailability, command: 'cancel' },
            { ensures: Shop.checkCancelOrderEnsures },
        );
        expect(wrong(draft, { why: 'l', lateWhy: 'l', at }).ok).toBe(true);
        let thrown: unknown;
        try {
            wrong(confirmed, { why: 'w', lateWhy: 'l', at });
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe(
            'DomainTrail postcondition violated: Shop.Order:cancel->cancelled.ensures: match (before) { Draft => after.total == 0, Confirmed { total } => after.total == total }',
        );
        expect((thrown as Error).cause).toMatchObject({ outcome: 'cancelled', kind: 'ensures' });
    });
});

const ok = (value: object) => ({ ok: true, value });
