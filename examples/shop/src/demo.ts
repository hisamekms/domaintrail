// A walk through the shop: `bun src/demo.ts` (after `dt generate ts`). Each line is a use case and its result, or an
// event as the bus publishes it; `stored` marks the events the DSL declares `persistent`.
import type { Result } from '../generated/domain/index.js';
import { fixedProviders } from './app/providers.js';
import { createShop } from './app/shop.js';

const log = (line: string) => console.log(line);
const shop = createShop(fixedProviders(), {
    log: (line) => log(`    ${line}`),
    onEvent: (s) => {
        const { type, ...fields } = s.event;
        const stored = shop.events.stored.some((e) => e.meta.eventId === s.meta.eventId) ? ', stored' : '';
        log(`  event ${type} ${JSON.stringify(fields)} (${s.meta.eventId}${stored})`);
    },
});
const { app } = shop;

/** Prints a use case's result and returns its value; a failure is printed with its error and ends nothing. */
async function step<T>(label: string, run: () => Promise<Result<T, { readonly type: string }>>, describe: (value: T) => string): Promise<T | undefined> {
    log(`> ${label}`);
    const r = await run();
    log(r.ok ? `  ok: ${describe(r.value)}` : `  error: ${JSON.stringify(r.error)}`);
    return r.ok ? r.value : undefined;
}

const customer = await step('register a customer', () => app.registerCustomer('山田 花子', 'hanako@example.com'), (c) => `${c.id} ${c.name} <${c.email}>`);
if (!customer) throw new Error('the demo needs the customer');
await step('register with an invalid email address', () => app.registerCustomer('名無し', 'not-an-address'), (c) => c.id);
await step('register another customer with the same email address', () => app.registerCustomer('山田 太郎', 'hanako@example.com'), (c) => c.id);
const other = await step('register another customer', () => app.registerCustomer('佐藤 一郎', 'ichiro@example.com'), (c) => `${c.id} ${c.name} <${c.email}>`);
if (!other) throw new Error('the demo needs the second customer');
await step("change the second customer's email address to the first one's", () => app.changeEmail(other.id, 'hanako@example.com'), (c) => `${c.id} <${c.email}>`);
await step("change the first customer's to a new one", () => app.changeEmail(customer.id, 'hanako@example.org'), (c) => `${c.id} <${c.email}>`);

const order = await step('place an order', () => app.placeOrder(customer.id), (o) => `${o.id} (${o.state})`);
if (!order) throw new Error('the demo needs the order');
const items = (o: { items: readonly { sku: string; quantity: number }[] }) => o.items.map((i) => `${i.sku}×${i.quantity}`).join(', ');
await step('add ABC-0001 × 2 at 1200 JPY', () => app.addItem(order.id, { sku: 'ABC-0001', quantity: 2, unitPrice: { amount: '1200', currency: 'JPY' } }), items);
await step('add XYZ-0420 × 1 at 980 JPY', () => app.addItem(order.id, { sku: 'XYZ-0420', quantity: 1, unitPrice: { amount: '980', currency: 'JPY' } }), items);
await step('add ABC-0001 again', () => app.addItem(order.id, { sku: 'ABC-0001', quantity: 1, unitPrice: { amount: '1200', currency: 'JPY' } }), items);
await step('add an item priced in USD', () => app.addItem(order.id, { sku: 'USD-0001', quantity: 1, unitPrice: { amount: '9.99', currency: 'USD' } }), items);
await step('confirm the order (Billing issues the invoice)', () => app.confirmOrder(order.id), (o) => `${o.id} (${o.state} at ${o.confirmedAt.toISOString()})`);

const invoice = await shop.invoices.find((i) => i.order === order.id);
if (!invoice) throw new Error('the policy should have issued an invoice');
await step('pay the invoice', () => app.payInvoice(invoice.aggregate.id), (i) => `${i.id} (${i.state} at ${i.paidAt.toISOString()})`);
await step('pay it again', () => app.payInvoice(invoice.aggregate.id), (i) => i.id);

const second = await step('place another order', () => app.placeOrder(customer.id), (o) => `${o.id} (${o.state})`);
if (!second) throw new Error('the demo needs the second order');
await step('add DEF-0007 × 3 at 450 JPY', () => app.addItem(second.id, { sku: 'DEF-0007', quantity: 3, unitPrice: { amount: '450', currency: 'JPY' } }), items);
await step('confirm it', () => app.confirmOrder(second.id), (o) => `${o.id} (${o.state})`);
await step('cancel it with reason Other, without a note', () => app.cancelOrder(second.id, 'Other'), (o) => `${o.id} (${o.state})`);
await step('note why', () => app.changeNote(second.id, 'お客様の転居により配送不可'), (o) => `${o.id} note: ${o.note}`);
await step('cancel it with reason Other', () => app.cancelOrder(second.id, 'Other'), (o) => `${o.id} (${o.state}, ${o.reason})`);

log('');
log(`stored events: ${shop.events.stored.map((s) => s.event.type).join(', ')}`);
log(`refund requests: ${shop.policies.refundRequests.map((r) => `${r.order} (${r.invoice?.id ?? 'no invoice'})`).join(', ') || 'none'}`);
