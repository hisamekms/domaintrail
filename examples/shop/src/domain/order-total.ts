// The amount to bill for a confirmed order: Σ unit price × quantity. A computed value is not part of the DSL (it
// describes structure and contracts, not calculations), so it is written here, relying on what the contract guarantees
// of a Confirmed order: at least one item (`hasItems`) and one currency for all of them (`singleCurrency`).
import { parseDecimal, type Common, type Decimal, type Sales } from '../../generated/domain/index.js';
import { makeAmount } from './primitives.js';

const fractionDigits = (d: Decimal): number => d.split('.')[1]?.length ?? 0;

/** The decimal as an integer of `scale` fraction digits: exact, unlike `Number`. */
const scaled = (d: Decimal, scale: number): bigint => {
    const [whole, fraction = ''] = d.split('.');
    return BigInt(whole + fraction.padEnd(scale, '0'));
};

export function orderTotal(order: Sales.ConfirmedOrder): Common.Money {
    const scale = Math.max(0, ...order.items.map((i) => fractionDigits(i.unitPrice.amount)));
    const total = order.items.reduce((sum, i) => sum + scaled(i.unitPrice.amount, scale) * BigInt(i.quantity), 0n);
    const digits = total.toString().padStart(scale + 1, '0');
    const amount = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
    // A sum of non-negative amounts is an Amount (`nonNegative`), so a failure here is a bug, not a domain error.
    const decimal = parseDecimal(amount);
    const made = decimal === undefined ? undefined : makeAmount(decimal);
    if (!made?.ok) throw new Error(`orderTotal: the sum ${amount} of the order's amounts is not an Amount`);
    return { amount: made.value, currency: order.items[0].unitPrice.currency };
}
