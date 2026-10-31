import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildStructureGraph } from '@domaintrail/visualization/domain/graph/build';
import { generateTypeScript } from '@domaintrail/modeling/generator/typescript';
import { contextDependencies } from '@domaintrail/modeling/model/dependencies';
import { OutcomeCard } from '@domaintrail/web/behavior';
import { MESSAGES } from '@domaintrail/web/i18n';
import { catalogSections, fieldSetUsers, namer } from '@domaintrail/web/model-utils';
import { usagesOf } from '@domaintrail/web/usages';
import { check, checkSales, codes, only } from './helpers.js';

const FILES = {
    'common.dt': `shared context Common {
  primitive TenantId "テナントID": UUID
  /// 契約者ごとにデータを分ける。
  fields Tenanted "テナント所属" {
    tenant: TenantId "テナント"
  }
}`,
    'sales.dt': `context Sales {
  id OrderId: UUID
  id OrderItemId: UUID
  id StaffId: UUID

  fields Performed "実施記録" { performedBy: StaffId "実施者" }

  aggregate Order "注文" with Common.Tenanted {
    id: OrderId
    owns items: OrderItem[0..*]
    invariant sameTenant { all(items, i => i.tenant == tenant) }
    create command place(id: OrderId) -> Draft emits OrderPlaced
    command confirm() Draft -> Confirmed emits OrderConfirmed, Billing.Billed
    state Draft
    state Confirmed { confirmedAt: Timestamp }
  }

  entity OrderItem with Tenanted {
    id: OrderItemId
  }

  event OrderPlaced with Tenanted, Performed { orderId: OrderId }
  event OrderConfirmed { orderId: OrderId }
}`,
    'billing.dt': `context Billing {
  id InvoiceId: UUID
  aggregate Invoice with Sales.Performed {
    id: InvoiceId
    command bill() emits Billed
  }
  event Billed { invoiceId: InvoiceId orderId: Sales.OrderId }
}`,
};

const ts = (files: Awaited<ReturnType<typeof check>>, ctx: string): string => generateTypeScript(files.model!).find((f) => f.path === `${ctx}.ts`)!.content;

describe('field sets', () => {
    test('a valid model checks clean; elements get the fields of their field sets first', async () => {
        const a = await check(FILES);
        expect(a.diagnostics).toEqual([]);
        const els = a.model!.elements;
        expect(els['Common.Tenanted'].kind).toBe('fieldSet');
        expect(els['Common.Tenanted'].fields.map((f) => [f.name, f.label])).toEqual([['tenant', 'テナント']]);
        expect(els['Sales.Order'].fieldSets).toEqual(['Common.Tenanted']);
        expect(els['Sales.Order'].fields.map((f) => [f.name, f.fieldSet])).toEqual([
            ['tenant', 'Common.Tenanted'],
            ['id', undefined],
            ['items', undefined],
        ]);
        expect(els['Sales.OrderPlaced'].fields.map((f) => f.name)).toEqual(['tenant', 'performedBy', 'orderId']);
        expect(els['Sales.OrderConfirmed'].fieldSets).toBeUndefined();
    });

    test('`fields` and `with` stay usable as field names', async () => {
        const a = await checkSales('value V { fields: String with: Int }');
        expect(a.diagnostics).toEqual([]);
        expect(a.model!.elements['Sales.V'].fields.map((f) => f.name)).toEqual(['fields', 'with']);
    });

    test('M016: with only on aggregates, entities and events', async () => {
        const a = await checkSales(`
  fields F { x: Int }
  fields G with F { y: Int }
  value V with F { v: Int }
  error E with F`);
        expect(only(a, 'M016').map((d) => d.message)).toEqual([
            "'with' is only for aggregates, entities and events; field set 'G' cannot include other field sets.",
            "'with' is only for aggregates, entities and events; value object 'V' cannot take field sets.",
            "'with' is only for aggregates, entities and events; error 'E' cannot take field sets.",
        ]);
    });

    test('M016: a field set holds plain fields only, and no id', async () => {
        const a = await checkSales(`
  id AId: UUID
  aggregate A { id: AId }
  value Money { amount: Decimal }
  fields F {
    id: AId
    owns money: Money
    references a: AId -> A
    invariant positive { true }
  }`);
        expect(only(a, 'M016').map((d) => d.message)).toEqual([
            "Field set 'F' cannot declare 'id'; the identity is declared by each aggregate and entity itself.",
            "A field set holds plain fields only; 'money' is declared with 'owns'.",
            "A field set holds plain fields only; 'a' is declared with 'references'.",
            "Field set 'F' cannot hold invariants; write invariant 'positive' in the elements that use it.",
        ]);
    });

    test('M016: each field name comes from one place', async () => {
        const a = await checkSales(`
  id AId: UUID
  fields F { x: Int y: Int }
  fields G { y: Int }
  aggregate A with F, G {
    id: AId
    x: String
    state S { y: Bool }
  }
  event Ev with F, F { aId: AId }`);
        expect(only(a, 'M016').map((d) => `${d.severity} ${d.message}`)).toEqual([
            "error Field 'y' of field set 'G' is also declared in field set 'F', both used by 'A'.",
            "error Field 'x' of 'A' is already taken from field set 'F'.",
            "error Field 'y' of state 'S' shadows the field of field set 'F' in 'A'.",
            "warning Field set 'F' is listed more than once.",
        ]);
    });

    test('M016: an unknown field set; a type is not a field set', async () => {
        const a = await checkSales(`
  id AId: UUID
  value V { x: Int }
  aggregate A with Missing, V { id: AId }`);
        expect(only(a, 'M016').map((d) => d.message)).toEqual([
            "Cannot resolve field set 'Missing' in this context (use Context.Name for other contexts).",
            "Cannot resolve field set 'V' in this context (use Context.Name for other contexts).",
        ]);
    });

    test('the fields of field sets are plain fields: no entities or aggregates as values (M004)', async () => {
        const a = await checkSales(`
  id AId: UUID
  id EId: UUID
  aggregate A { id: AId owns e: E }
  entity E { id: EId }
  fields F { e: E }`);
        expect(only(a, 'M004').map((d) => d.message)).toEqual(["Entity 'E' cannot be embedded as a plain field; declare it with 'owns' inside its aggregate."]);
    });

    test('invariants see the fields of field sets; state-specific fields stay in their states', async () => {
        const a = await checkSales(`
  id AId: UUID
  fields Limited { limit: Int }
  aggregate A with Limited {
    id: AId
    owns b: B
    used: Int
    invariant withinLimit { used <= limit }
    state S
  }
  entity B with Limited { id: AId2 invariant positive { limit > 0 } }
  id AId2: UUID`);
        expect(a.diagnostics).toEqual([]);
        const bad = await checkSales(`
  id AId: UUID
  fields Limited { limit: Int }
  aggregate A with Limited { id: AId invariant x { limit == "a" } }`);
        expect(codes(bad)).toEqual(['M009']);
    });

    test('shared contexts may hold field sets, which depend only on shared contexts (M014)', async () => {
        const a = await check({
            'common.dt': 'shared context Common { fields F { order: Sales.OrderId } }',
            'sales.dt': 'context Sales { id OrderId: UUID }',
        });
        expect(only(a, 'M014').map((d) => d.message)).toEqual(["Shared context 'Common' cannot depend on 'Sales.OrderId' of a non-shared context."]);
    });

    test('M011: an event field named type from a field set; the new unions collide like other names', async () => {
        const a = await checkSales(`
  id AId: UUID
  fields Typed { type: String }
  aggregate A { id: AId command c() emits Ev }
  event Ev with Typed { aId: AId }
  value AEvent
  value DomainEvent`);
        expect(only(a, 'M011').map((d) => d.message)).toEqual([
            "Generated TypeScript name 'DomainEvent' for the union of the events collides with value object 'DomainEvent'.",
            "Field 'type' of field set 'Typed' is reserved for the discriminant of generated event types.",
            "Generated TypeScript name 'AEvent' for value object 'AEvent' collides with the union of the events of 'A'.",
        ]);
    });

    test('labels: fields of field sets are named in their own context, and share the namespace of the element (L003)', async () => {
        const a = await checkSales(`
  id AId: UUID
  fields F { tenant: String "所属" }
  aggregate A with F { id: AId org: String "所属" }`);
        expect(only(a, 'L003').map((d) => d.message)).toEqual(["'org' and 'tenant' are both named '所属' in 'A'."]);
    });
});

describe('M017: events carry the ID of their aggregate', () => {
    test('warns when an emitted event has no field of the aggregate ID type', async () => {
        const a = await checkSales(`
  id AId: UUID
  aggregate A { id: AId command c() emits Ev, Ok  command d() emits Ev }
  event Ev { note: String }
  event Ok { a: AId? }`);
        expect(only(a, 'M017').map((d) => `${d.severity} ${d.elementId} ${d.message}`)).toEqual([
            "warning Sales.A:c Event 'Ev' emitted by 'A.c' has no field of type 'AId' to tell which 'A' it is about.",
        ]);
        expect(only(a, 'M017')[0].hint).toBe("add a field such as 'aId: AId' to event 'Ev'");
    });

    test('a field from a field set counts; an event of several aggregates needs the ID of each', async () => {
        const a = await check({
            'sales.dt': `context Sales {
  id AId: UUID
  id BId: UUID
  fields OfA { a: AId }
  aggregate A { id: AId command c() emits Ev, Billing.Shared }
  aggregate B { id: BId command c() emits Ev }
  event Ev with OfA { }
}`,
            'billing.dt': 'context Billing { event Shared { a: Sales.AId } }',
        });
        expect(only(a, 'M017').map((d) => d.message)).toEqual(["Event 'Ev' emitted by 'B.c' has no field of type 'BId' to tell which 'B' it is about."]);
        const b = await check({
            'billing.dt': 'context Billing { id IId: UUID aggregate I { id: IId command c() emits Sales.Ev } }',
            'sales.dt': 'context Sales { event Ev }',
        });
        expect(only(b, 'M017').map((d) => [d.message, d.hint])).toEqual([
            ["Event 'Ev' emitted by 'I.c' has no field of type 'IId' to tell which 'I' it is about.", "add a field such as 'iId: Billing.IId' to event 'Ev'"],
        ]);
    });
});

describe('field sets: generated TypeScript', () => {
    let dir: string;
    let a: Awaited<ReturnType<typeof check>>;
    beforeAll(async () => {
        a = await check(FILES);
        dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-fieldsets-'));
        await mkdir(path.join(dir, 'generated'), { recursive: true });
        for (const f of generateTypeScript(a.model!)) await writeFile(path.join(dir, 'generated', f.path), f.content);
    });
    afterAll(() => rm(dir, { recursive: true, force: true }));

    test('a field set is an interface that the elements using it extend', () => {
        expect(ts(a, 'Common')).toContain(
            '/**\n * テナント所属\n * 契約者ごとにデータを分ける。\n * Fields taken on with `with Tenanted`.\n * @see common.dt:4\n */\nexport interface Tenanted {\n    /** テナント */\n    readonly tenant: TenantId;\n}',
        );
        const sales = ts(a, 'Sales');
        expect(sales).toContain("import type * as Common from './Common.js';");
        expect(sales).toMatch(
            /export interface OrderCommon extends Common\.Tenanted \{\n    readonly id: OrderId;\n    readonly items: readonly OrderItem\[\];\n\}/,
        );
        expect(sales).toContain('export interface ConfirmedOrder extends OrderCommon {');
        expect(sales).toMatch(/export interface OrderItem extends Common\.Tenanted \{\n    readonly id: OrderItemId;\n\}/);
        expect(sales).toMatch(
            /export interface OrderPlaced extends Common\.Tenanted, Performed \{\n    readonly type: 'OrderPlaced';\n    readonly orderId: OrderId;\n\}/,
        );
        expect(sales).toContain('export interface OrderConfirmed {');
        expect(ts(a, 'Billing')).toMatch(/export interface Invoice extends Sales\.Performed \{\n    readonly id: InvoiceId;\n\}/);
    });

    test('unions of the events, the aggregates and the events of each aggregate', () => {
        const sales = ts(a, 'Sales');
        expect(sales).toContain(
            '/**\n * Events that the commands of Order may emit.\n * @see sales.dt:8\n */\nexport type OrderEvent = OrderPlaced | OrderConfirmed | Billing.Billed;',
        );
        expect(sales).toContain('/** Events of Sales. */\nexport type DomainEvent = OrderPlaced | OrderConfirmed;');
        expect(sales).toContain('/** Aggregates of Sales. */\nexport type Aggregate = Order;');
        const common = ts(a, 'Common');
        expect(common).not.toContain('DomainEvent');
        expect(common).not.toContain('Aggregate');
    });

    test('compiles, and the extended fields are required', async () => {
        await writeFile(
            path.join(dir, 'use.ts'),
            `import type { Common, Sales } from './generated/index.js';
declare const tenant: Common.TenantId;
declare const staff: Sales.StaffId;
declare const order: Sales.OrderId;
export const placed: Sales.OrderPlaced = { type: 'OrderPlaced', tenant, performedBy: staff, orderId: order };
export const events: readonly Sales.OrderEvent[] = [placed];
export const all: readonly Sales.DomainEvent[] = [placed];
// @ts-expect-error the tenant comes from the field set and is required
export const missing: Sales.OrderPlaced = { type: 'OrderPlaced', performedBy: staff, orderId: order };
`,
        );
        const tsc = path.join(import.meta.dir, '..', 'node_modules', '.bin', 'tsc');
        const r = Bun.spawnSync(
            [process.execPath, tsc, '--noEmit', '--strict', '--target', 'ES2023', '--module', 'preserve', '--moduleResolution', 'bundler', 'use.ts'],
            { cwd: dir },
        );
        expect(r.stdout.toString() + r.stderr.toString()).toBe('');
        expect(r.exitCode).toBe(0);
    });
});

describe('field sets: Live View', () => {
    test('the structure diagram lists the fields of field sets first, with the field set faded after them', async () => {
        const a = await check(FILES);
        const node = buildStructureGraph(a.model!).nodes.find((n) => n.id === 'Sales.Order')!;
        expect(node.lines.map((l) => l.key.ja.name)).toEqual(['tenant', 'id', '◆ items', '状態']);
        expect(node.lines[0].origin?.ja).toEqual({ name: 'Tenanted', label: 'テナント所属', both: 'テナント所属' });
        expect(node.lines.slice(1).every((l) => !l.origin)).toBe(true);
    });

    test("an event card's payload marks the fields of field sets", async () => {
        const model = (await check(FILES)).model!;
        const order = model.elements['Sales.Order'];
        const html = renderToStaticMarkup(
            <OutcomeCard
                id="Sales.OrderPlaced"
                commands={order.commands!.slice(0, 1)}
                model={model}
                names={namer('label', model)}
                tx={MESSAGES.ja}
                onSelect={() => {}}
            />,
        );
        expect(html.match(/class="field-origin"[^>]*>[^<]*</g)?.map((m) => m.replace(/.*>/, '').replace('<', ''))).toEqual(['テナント所属', '実施記録']);
    });

    test('a field set is used by its elements and counts its field types once', async () => {
        const a = await check(FILES);
        const model = a.model!;
        expect(fieldSetUsers(model, 'Common.Tenanted').map((e) => e.id)).toEqual(['Sales.Order', 'Sales.OrderItem', 'Sales.OrderPlaced']);
        expect(usagesOf(model, 'Common.TenantId').map((u) => u.key)).toEqual(['Common.Tenanted.tenant']);
        expect(usagesOf(model, 'Sales.StaffId').map((u) => u.key)).toEqual(['Sales.Performed.performedBy']);
        const deps = contextDependencies(model).filter((d) => d.path === 'with');
        expect(deps.map((d) => `${d.source} -> ${d.target}`)).toEqual([
            'Sales.Order -> Common.Tenanted',
            'Sales.OrderItem -> Common.Tenanted',
            'Sales.OrderPlaced -> Common.Tenanted',
            'Billing.Invoice -> Sales.Performed',
        ]);
        const sets = catalogSections(model).find((s) => s.key === 'fieldSets')!;
        expect(sets.groups.map((g) => [g.context, g.items.map((e) => e.name)])).toEqual([
            ['Common', ['Tenanted']],
            ['Sales', ['Performed']],
        ]);
    });
});
