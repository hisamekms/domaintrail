import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runCli } from '../src/presentation/cli/main.js';
import { EXAMPLES } from './helpers.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out, err };
}

const shop = (...args: string[]) => run('-r', EXAMPLES, 'show', ...args);

async function workspace(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-show-'));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
    return dir;
}

describe('dt show', () => {
    test('an element by its qualified name: fields, labels, invariants, states, commands, used by', async () => {
        const r = await shop('Sales.Order');
        expect(r.code).toBe(0);
        expect(r.err).toEqual([]);
        expect(r.out).toContain('aggregate Sales.Order "注文"  // sales/order.dt:13');
        expect(r.out).toContain('  /// 顧客からの購入依頼。確定後は明細を変更できない。'.trimStart());
        expect(r.out).toContain('  owns items: OrderItem[0..*] "明細"');
        expect(r.out).toContain('  references customer: CustomerId -> Customer "顧客" (from type)');
        expect(r.out).toContain('  note: String? "備考" (from term)');
        expect(r.out).toContain('  invariant distinctSkus "商品コードは明細ごとに一意" { unique(items, item => item.sku) }');
        expect(r.out).toContain('  state Cancelled "取消済み"  // sales/order.dt:37');
        expect(r.out).toContain('    reason: CancelReason "取消理由" (from term)');
        expect(r.out).toContain(
            '  create command place(id: OrderId "注文ID" (from type), customer: CustomerId "顧客ID" (from type)) "注文する"  // sales/order.dt:26',
        );
        expect(r.out).toContain('    emits OrderCancelled, RefundRequested when Confirmed ->');
        expect(r.out).toContain('      Confirmed -> Cancelled: emits OrderCancelled, RefundRequested');
        expect(r.out).toContain('    emits NoteChanged?');
        expect(r.out).toContain('    errors DuplicateSku, CurrencyMismatch');
        expect(r.out.slice(-3)).toEqual([
            'used by',
            '  referenced by: Billing.Invoice.order',
            '  ID used by: Billing.Invoice.issue(order), Sales.Order.place(id), Sales.OrderPlaced.orderId, Sales.OrderConfirmed.orderId, Sales.OrderCancelled.orderId, Sales.RefundRequested.orderId, Sales.NoteChanged.orderId',
        ]);
    });

    test('a short name that names one thing only', async () => {
        expect((await shop('Order')).out).toEqual((await shop('Sales.Order')).out);
        expect((await shop('Money')).out[0]).toBe('value Common.Money "金額"  // common/context.dt:15');
    });

    test('a command: its full contract, with events per outcome and the fields each outcome sets', async () => {
        const r = await shop('Order.confirm');
        expect(r.code).toBe(0);
        expect(r.out).toEqual([
            'command Sales.Order.confirm(at: Timestamp "日時" (from term)) "注文を確定する"  // sales/order.dt:51',
            '  Draft -> Confirmed',
            '  requires hasItems "明細が1件以上" { count(items) > 0 } else EmptyOrder',
            '  emits OrderConfirmed',
            '  outcomes',
            '    Draft -> Confirmed: emits OrderConfirmed',
            '      sets confirmedAt; carries id, items, customer, note',
            '  events',
            '    OrderConfirmed "注文確定" { orderId: OrderId "注文ID" (from term), confirmedAt: Timestamp "確定日時" (from term) }  // sales/order.dt:84',
            '  errors',
            '    EmptyOrder "明細なし"  // sales/order.dt:105',
        ]);
        const cancel = await shop('Sales.Order.cancel');
        expect(cancel.out).toContain('    Draft -> Cancelled: emits OrderCancelled');
        expect(cancel.out).toContain('      sets reason; carries id, items, customer, note; drops confirmedAt');
        expect(cancel.out).toContain('    NoteRequired "備考なし"  // sales/order.dt:116');
    });

    test('a state: its fields, invariants and the commands that enter and leave it', async () => {
        const r = await shop('Sales.Order.Confirmed');
        expect(r.code).toBe(0);
        expect(r.out).toEqual([
            'state Sales.Order.Confirmed "確定済み"  // sales/order.dt:32',
            '  /// 顧客が注文を確定した日時。キャンセル可否の判定に使う。',
            '  confirmedAt: Timestamp "確定日時" (from term)',
            '  invariant hasItems "明細が1件以上" { count(items) > 0 }',
            '  common fields of Order: id, items, customer, note',
            '  entered by: confirm (Draft -> Confirmed), changeNote (Confirmed -> Confirmed)',
            '  left by: cancel (Confirmed -> Cancelled), changeNote (Confirmed -> Confirmed)',
        ]);
    });

    test('a context: its elements, one line each', async () => {
        const r = await shop('Billing');
        expect(r.out).toEqual([
            'context Billing "請求"',
            '  /// 注文への請求と支払いを扱う。',
            '  terms paidAt "支払日時", invoiceId "請求書ID"',
            '  policy BillConfirmedOrder "確定した注文に請求する" when Sales.OrderConfirmed -> Invoice.issue  // billing/context.dt:9',
            '  id InvoiceId "請求書ID": UUID  // billing/invoice.dt:2',
            '  aggregate Invoice "請求書" (states Open, Paid)  // billing/invoice.dt:4',
            '  persistent event InvoicePaid "支払完了"  // billing/invoice.dt:22',
        ]);
    });

    test('without a name: the contexts and their elements', async () => {
        const r = await shop();
        expect(r.code).toBe(0);
        expect(r.out.slice(0, 6)).toEqual([
            'context Billing "請求"',
            '  aggregate Invoice',
            '  id InvoiceId',
            '  event InvoicePaid',
            '  policy BillConfirmedOrder',
            'shared context Common "共通"',
        ]);
        expect(r.out).toContain('shared context Common "共通"');
    });

    test('used by: who emits an event, returns an error, owns a value', async () => {
        expect((await shop('RefundRequested')).out).toContain('  emitted by: Sales.Order.cancel');
        expect((await shop('CurrencyMismatch')).out).toContain('  returned by: Sales.Order.addItem');
        expect((await shop('Money')).out).toContain('  owned by: Sales.OrderItem.unitPrice');
        expect((await shop('NoteChanged')).out).toContain('  emitted by: Sales.Order.changeNote');
    });

    test('an unknown name: did you mean, exit 1', async () => {
        const r = await shop('Ordr');
        expect(r.code).toBe(1);
        expect(r.out).toEqual([]);
        expect(r.err).toEqual(["Unknown name 'Ordr'; did you mean 'Sales.Order'?"]);
        expect((await shop('Order.confim')).err[0]).toStartWith("Unknown name 'Order.confim'; did you mean 'Sales.Order.confirm',");
    });

    test('an ambiguous name: the candidates, exit 1', async () => {
        const dir = await workspace({
            'a.dt': `context A { id XId: UUID aggregate X { id: XId state Open command close() Open -> Open } }`,
            'b.dt': `context B { id XId: UUID aggregate X { id: XId state Open } }`,
        });
        const r = await run('-r', dir, 'show', 'X');
        expect(r.code).toBe(1);
        expect(r.err).toEqual(["'X' is ambiguous: A.X, B.X. Use the full name."]);
        expect((await run('-r', dir, 'show', 'Open')).err).toEqual(["'Open' is ambiguous: A.X.Open, B.X.Open. Use the full name."]);
        expect((await run('-r', dir, 'show', 'close')).code).toBe(0);
        const json = await run('-r', dir, 'show', 'X', '--format', 'json');
        expect(json.code).toBe(1);
        expect(JSON.parse(json.out.join('\n'))).toEqual({ error: "'X' is ambiguous: A.X, B.X. Use the full name.", candidates: ['A.X', 'B.X'] });
    });

    test('fields of field sets are inline, marked with their set', async () => {
        const dir = await workspace({
            'common.dt': `shared context Common { primitive TenantId "テナントID": UUID fields Tenanted "テナント所属" { tenant: TenantId "テナント" } }`,
            'sales.dt': `context Sales {
  id OrderId: UUID
  aggregate Order with Tenanted { id: OrderId }
}`,
        });
        const r = await run('-r', dir, 'show', 'Order');
        expect(r.code).toBe(0);
        expect(r.out.slice(0, 3)).toEqual([
            'aggregate Sales.Order with Common.Tenanted  // sales.dt:3',
            '  tenant: Common.TenantId "テナント"  // with Common.Tenanted',
            '  id: OrderId',
        ]);
        expect((await run('-r', dir, 'show', 'Tenanted')).out).toContain('  taken on by (with): Sales.Order');
    });

    test('a model with semantic errors is shown as far as it resolves, exit 0 with a note', async () => {
        const dir = await workspace({
            'sales.dt': `context Sales { id OrderId: UUID aggregate Order { id: OrderId total: Mony state Draft command confirm() Draft -> Done } }`,
        });
        const r = await run('-r', dir, 'show', 'Order');
        expect(r.code).toBe(0);
        expect(r.out).toContain('  total: Mony (unresolved)');
        expect(r.err).toEqual(['note: the model has 2 error(s) (see `dt check`); shown as far as it resolves.']);
        const json = await run('-r', dir, 'show', 'Order', '--format', 'json');
        expect(json.code).toBe(0);
        expect(JSON.parse(json.out.join('\n')).modelErrors).toBe(2);
    });

    test('a model with syntax errors, no .dt file, a bad config', async () => {
        const broken = await workspace({ 'sales.dt': 'context Sales { aggregate }' });
        expect((await run('-r', broken, 'show')).code).toBe(1);
        const empty = await workspace({});
        expect((await run('-r', empty, 'show')).code).toBe(1);
        const badConfig = await workspace({ 'domaintrail.jsonc': '{ "sources": 1 }' });
        expect((await run('-r', badConfig, 'show')).code).toBe(2);
    });
});

describe('dt show --format json', () => {
    const json = async (...args: string[]) => {
        const r = await shop(...args, '--format', 'json');
        expect(r.code).toBe(0);
        return JSON.parse(r.out.join('\n'));
    };

    test('an element: the Typed Model with outcomes per command, and who uses it', async () => {
        const doc = await json('Sales.Order');
        expect(doc.show).toBe('element');
        expect(doc.modelErrors).toBeUndefined();
        expect(doc.element.id).toBe('Sales.Order');
        expect(doc.element.location).toEqual({ file: 'sales/order.dt', line: 13, endLine: 71 });
        expect(doc.element.fields.find((f: { name: string }) => f.name === 'note')).toMatchObject({ label: '備考', labelSource: 'term', multiplicity: '?' });
        const cancel = doc.element.commands.find((c: { name: string }) => c.name === 'cancel');
        expect(cancel.outcomes).toEqual([
            {
                from: 'Draft',
                to: 'Cancelled',
                emits: [{ event: 'Sales.OrderCancelled', multiplicity: '', lower: 1, upper: 1 }],
                sets: ['reason'],
                carries: ['id', 'items', 'customer', 'note'],
                drops: [],
            },
            {
                from: 'Confirmed',
                to: 'Cancelled',
                emits: [
                    { event: 'Sales.OrderCancelled', multiplicity: '', lower: 1, upper: 1 },
                    { event: 'Sales.RefundRequested', multiplicity: '', lower: 1, upper: 1 },
                ],
                sets: ['reason'],
                carries: ['id', 'items', 'customer', 'note'],
                drops: ['confirmedAt'],
            },
        ]);
        expect(doc.usedBy).toEqual({
            takenOnBy: [],
            ownedBy: [],
            typeOf: [],
            referencedBy: ['Billing.Invoice.order'],
            idUsedBy: expect.arrayContaining(['Billing.Invoice.issue(order)', 'Sales.OrderPlaced.orderId']),
            emittedBy: [],
            returnedBy: [],
            verifiedAs: [],
            contextOf: [],
            discriminatorOf: [],
            reactedToBy: [],
        });
    });

    test('a command, a state, a context and the overview', async () => {
        const command = await json('Order.confirm');
        expect(command).toMatchObject({ show: 'command', aggregate: 'Sales.Order', command: { name: 'confirm', errors: ['Sales.EmptyOrder'] } });
        expect(command.command.requires).toEqual([{ name: 'hasItems', label: '明細が1件以上', source: 'count(items) > 0', error: 'Sales.EmptyOrder' }]);
        const state = await json('Order.Draft');
        expect(state.show).toBe('state');
        expect(state.enteredBy).toContainEqual({ command: 'place', to: 'Draft' });
        expect(state.leftBy).toContainEqual({ command: 'confirm', from: 'Draft', to: 'Confirmed' });
        const context = await json('Billing');
        expect(context.context).toMatchObject({ name: 'Billing', label: '請求', shared: false });
        expect(context.context.elements[0]).toMatchObject({ id: 'Billing.BillConfirmedOrder', kind: 'policy' });
        expect(context.context.elements[1]).toEqual({
            id: 'Billing.InvoiceId',
            kind: 'id',
            name: 'InvoiceId',
            label: '請求書ID',
            location: { file: 'billing/invoice.dt', line: 2, endLine: 2 },
        });
        const overview = await json();
        expect(overview.show).toBe('overview');
        expect(overview.contexts.map((c: { name: string }) => c.name)).toEqual(['Billing', 'Common', 'Sales']);
    });

    test('an unknown name: the error and the suggestions', async () => {
        const r = await shop('Ordr', '--format', 'json');
        expect(r.code).toBe(1);
        expect(JSON.parse(r.out.join('\n'))).toEqual({ error: "Unknown name 'Ordr'; did you mean 'Sales.Order'?", candidates: ['Sales.Order'] });
    });
});
