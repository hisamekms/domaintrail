import { describe, expect, test } from 'bun:test';
import { check, only } from '../../test-helpers.js';

const CUSTOMER = `/// Selling to customers.
context Sales {
  value Customer { name: String }
}
`;

const INVOICE = `/// Invoices of the sales.
context Sales {
  value Invoice { total: Int }
}
`;

const ORDER = `context Sales {
  value Order { note: String }
}
`;

/** A diagnostic as `file:line:column severity code message (hint)`. */
const lines = (files: Record<string, string>): Promise<string[]> =>
    check(files).then((a) => only(a, 'M025').map((d) => `${d.file}:${d.start.line}:${d.start.column} ${d.severity} ${d.code} ${d.message} (${d.hint})`));

describe("a context's description", () => {
    test('M025: a second `///` on one context is an error on it, naming the first', async () => {
        expect(await lines({ 'sales/customer.dt': CUSTOMER, 'sales/invoice.dt': INVOICE })).toEqual([
            "sales/invoice.dt:1:1 error M025 Context 'Sales' already has a description at sales/customer.dt:1. " +
                '(merge this description into the one at sales/customer.dt:1, and remove it here)',
        ]);
    });

    test('M025: the range covers every `///` line of the later description, and the context is its element', async () => {
        const a = await check({ 'a.dt': CUSTOMER, 'b.dt': `  /// Invoices\n  /// of the sales.\n${INVOICE.split('\n').slice(1).join('\n')}` });
        const [d] = only(a, 'M025');
        expect([d.start, d.end, d.elementId]).toEqual([{ line: 1, column: 3 }, { line: 2, column: 20 }, 'Sales']);
    });

    test('one `///` on a split context, or one per context, is no error', async () => {
        expect(await lines({ 'sales/customer.dt': CUSTOMER, 'sales/order.dt': ORDER })).toEqual([]);
        expect(await lines({ 'sales/customer.dt': CUSTOMER, 'billing.dt': INVOICE.replace('Sales', 'Billing') })).toEqual([]);
        // `///` above an element of the context is that element's description, not the context's
        expect(await lines({ 'sales/customer.dt': CUSTOMER, 'sales/order.dt': ORDER.replace('  value', '  /// An order.\n  value') })).toEqual([]);
    });

    test('M025: with three files, the two after the first in file-name order are errors', async () => {
        const a = await check({
            'sales/a.dt': CUSTOMER,
            'sales/b.dt': ORDER,
            'sales/c.dt': INVOICE,
            'sales/d.dt': `/// Orders.\n${ORDER.replace('Order', 'Quote')}`,
        });
        expect(only(a, 'M025').map((d) => [d.file, d.message])).toEqual([
            ['sales/c.dt', "Context 'Sales' already has a description at sales/a.dt:1."],
            ['sales/d.dt', "Context 'Sales' already has a description at sales/a.dt:1."],
        ]);
        // the Typed Model keeps the first, as before
        expect(a.model?.contexts.find((c) => c.name === 'Sales')?.doc).toBe('Selling to customers.');
    });
});
