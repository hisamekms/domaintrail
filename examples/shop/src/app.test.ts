// Tests of the application layer: what the contract tests cannot see, because it happens around the commands —
// saving with versions, recording and publishing events, the policies, and the checks before a command runs.
import { describe, expect, test } from 'bun:test';
import { fixedProviders } from './app/providers.js';
import { createShop } from './app/shop.js';
import { verifications } from './app/verifications.js';
import { makeEmailAddress, makeOrderId } from './domain/primitives.js';

async function confirmedOrder() {
    const shop = createShop(fixedProviders());
    const customer = await shop.app.registerCustomer('山田 花子', 'hanako@example.com');
    if (!customer.ok) throw new Error(customer.error.type);
    const order = await shop.app.placeOrder(customer.value.id);
    if (!order.ok) throw new Error(order.error.type);
    await shop.app.addItem(order.value.id, { sku: 'ABC-0001', quantity: 3, unitPrice: { amount: '12.50', currency: 'USD' } });
    await shop.app.addItem(order.value.id, { sku: 'ABC-0002', quantity: 1, unitPrice: { amount: '0.05', currency: 'USD' } });
    const confirmed = await shop.app.confirmOrder(order.value.id);
    if (!confirmed.ok) throw new Error(confirmed.error.type);
    return { shop, order: confirmed.value };
}

describe('use cases', () => {
    test('a successful command saves the aggregate with a new version and records its events', async () => {
        const { shop, order } = await confirmedOrder();
        const saved = await shop.orders.load(order.id);
        expect(saved?.aggregate.state).toBe('Confirmed');
        expect(saved?.meta.version).toBe(4); // placed, two items added, confirmed
        expect(shop.events.stored.map((s) => s.event.type)).toEqual(['OrderPlaced', 'OrderConfirmed']);
    });

    test('a domain error saves nothing and records no event', async () => {
        const { shop, order } = await confirmedOrder();
        const before = shop.events.stored.length;
        const r = await shop.app.cancelOrder(order.id, 'Other');
        expect(r).toEqual({ ok: false, error: { type: 'NoteRequired' } });
        expect((await shop.orders.load(order.id))?.aggregate.state).toBe('Confirmed');
        expect(shop.events.stored.length).toBe(before);
    });

    test('invalid input is rejected by the constructors of the domain primitives before any command', async () => {
        const shop = createShop(fixedProviders());
        expect(await shop.app.registerCustomer('x', 'no-at-sign')).toEqual({
            ok: false,
            error: { type: 'InvalidEmailAddress', value: 'no-at-sign', invariant: 'format' },
        });
        const r = await shop.app.addItem(makeOrderId('order-1'), { sku: 'abc', quantity: 1, unitPrice: { amount: '1', currency: 'JPY' } });
        expect(r).toEqual({ ok: false, error: { type: 'InvalidSku', value: 'abc', invariant: 'valid' } });
    });

    test("a command the aggregate's state does not accept is not called", async () => {
        const { shop, order } = await confirmedOrder();
        const r = await shop.app.addItem(order.id, { sku: 'XYZ-0001', quantity: 1, unitPrice: { amount: '1', currency: 'USD' } });
        expect(r).toEqual({ ok: false, error: { type: 'NotAllowed', command: 'addItem', state: 'Confirmed' } });
    });

    test('saving over a newer version is a conflict', async () => {
        const { shop, order } = await confirmedOrder();
        const stale = await shop.orders.load(order.id);
        expect(await shop.app.changeNote(order.id, 'gift wrap')).toMatchObject({ ok: true });
        const r = await shop.orders.save(stale!.aggregate, stale!.meta.version, new Date());
        expect(r).toEqual({ ok: false, error: { type: 'VersionConflict', id: order.id, expected: 4, actual: 5 } });
    });
});

describe('verified types', () => {
    const address = (text: string) => {
        const r = makeEmailAddress(text);
        if (!r.ok) throw new Error(r.error.type);
        return r.value;
    };

    test('makeAvailableEmail rejects an address another customer uses, and leaves out the customer given', async () => {
        const shop = createShop(fixedProviders());
        const hanako = await shop.app.registerCustomer('山田 花子', 'hanako@example.com');
        if (!hanako.ok) throw new Error(hanako.error.type);
        const { makeAvailableEmail } = verifications(shop.customers);
        expect<unknown>(await makeAvailableEmail(address('hanako@example.com'), undefined)).toEqual({
            ok: false,
            error: { type: 'EmailTaken', email: 'hanako@example.com' },
        });
        expect<unknown>(await makeAvailableEmail(address('hanako@example.com'), hanako.value.id)).toEqual({ ok: true, value: 'hanako@example.com' });
        expect<unknown>(await makeAvailableEmail(address('taro@example.com'), undefined)).toEqual({ ok: true, value: 'taro@example.com' });
    });

    test('registering or changing to a taken address returns EmailTaken and saves nothing', async () => {
        const shop = createShop(fixedProviders());
        const hanako = await shop.app.registerCustomer('山田 花子', 'hanako@example.com');
        const ichiro = await shop.app.registerCustomer('佐藤 一郎', 'ichiro@example.com');
        if (!hanako.ok || !ichiro.ok) throw new Error('registration failed');
        expect<unknown>(await shop.app.registerCustomer('山田 太郎', 'hanako@example.com')).toEqual({
            ok: false,
            error: { type: 'EmailTaken', email: 'hanako@example.com' },
        });
        expect<unknown>(await shop.app.changeEmail(ichiro.value.id, 'hanako@example.com')).toEqual({
            ok: false,
            error: { type: 'EmailTaken', email: 'hanako@example.com' },
        });
        expect<unknown>((await shop.customers.load(ichiro.value.id))?.aggregate.email).toBe('ichiro@example.com');
        expect<unknown>(await shop.app.changeEmail(ichiro.value.id, 'ichiro@example.com')).toMatchObject({ ok: true }); // its own address
        expect<unknown>(await shop.app.changeEmail(ichiro.value.id, 'ichiro@example.org')).toMatchObject({ ok: true, value: { email: 'ichiro@example.org' } });
    });
});

describe('policies', () => {
    test('a confirmed order is invoiced for its total, caused by OrderConfirmed', async () => {
        const { shop, order } = await confirmedOrder();
        const invoice = await shop.invoices.find((i) => i.order === order.id);
        expect(invoice?.aggregate).toMatchObject({ state: 'Open', billedAmount: { amount: '37.55', currency: 'USD' } });
        const paid = await shop.app.payInvoice(invoice!.aggregate.id);
        expect(paid).toMatchObject({ ok: true, value: { state: 'Paid' } });
        const [stored] = shop.events.stored.filter((s) => s.event.type === 'InvoicePaid');
        expect(stored.event).toEqual({ type: 'InvoicePaid', invoiceId: invoice!.aggregate.id, paidAt: expect.any(Date) });
    });

    test('cancelling a confirmed order records a refund request; cancelling a draft does not', async () => {
        const { shop, order } = await confirmedOrder();
        expect(await shop.app.cancelOrder(order.id, 'Requested')).toMatchObject({ ok: true });
        const draft = await shop.app.placeOrder(order.customer);
        if (!draft.ok) throw new Error(draft.error.type);
        expect(await shop.app.cancelOrder(draft.value.id, 'Requested')).toMatchObject({ ok: true });
        expect(shop.policies.refundRequests).toEqual([{ order: order.id, invoice: { id: expect.any(String), state: 'Open' }, requestedAt: expect.any(Date) }]);
    });
});
