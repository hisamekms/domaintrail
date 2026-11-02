// Display names (apps/web/model-utils.ts): a label missing, empty or only whitespace counts as none in every display mode.
import { describe, expect, test } from 'bun:test';
import { elementOf, fieldsOf } from '@domaintrail/modeling';
import { labelOrName, nameIn, namer, withLabel } from './model-utils';
import { check } from './test-helpers';

const NO_LABEL = [undefined, '', '   ', '　'];

describe('names without a label', () => {
    test('nameIn shows the name in every display mode', () => {
        for (const label of NO_LABEL) {
            expect(nameIn('label', 'Order', label)).toBe('Order');
            expect(nameIn('name', 'Order', label)).toBe('Order');
            expect(nameIn('both', 'Order', label)).toBe('Order');
        }
    });

    test('nameIn shows a label as written', () => {
        expect(nameIn('label', 'Order', '注文')).toBe('注文');
        expect(nameIn('name', 'Order', '注文')).toBe('Order');
        expect(nameIn('both', 'Order', '注文')).toBe('注文 (Order)');
    });

    test('withLabel and labelOrName fall back to the name', () => {
        for (const label of NO_LABEL) {
            expect(withLabel({ name: 'Order', label })).toBe('Order');
            expect(labelOrName({ name: 'Order', label })).toBe('Order');
        }
        expect(withLabel({ name: 'Order', label: '注文' })).toBe('注文 (Order)');
        expect(labelOrName({ name: 'Order', label: '注文' })).toBe('注文');
    });

    test('the namer names elements, states, commands and types without a label by their names', async () => {
        const model = (
            await check({
                'a.dt': `context Sales " " {
  id OrderId "": UUID
  aggregate Order "  " {
    id: OrderId
    state Draft ""
    state Confirmed "確定済み"
    command confirm() "" Draft -> Confirmed
  }
}`,
            })
        ).model!;
        for (const mode of ['label', 'name', 'both'] as const) {
            const names = namer(mode, model);
            expect(names.id('Sales')).toBe('Sales');
            expect(names.id('Sales.Order')).toBe('Order');
            expect(names.id('Sales.Order#Draft')).toBe('Order.Draft');
            expect(names.id('Sales.Order:confirm')).toBe('Order.confirm');
            expect(names.short('Sales.Order')).toBe('Order');
            const order = elementOf(model, 'Sales.Order')!;
            expect(names.type(fieldsOf(order).find((f) => f.name === 'id')!.type, 'Sales')).toBe('OrderId');
        }
        expect(namer('label', model).id('Sales.Order#Confirmed')).toBe('Order.確定済み');
    });
});
