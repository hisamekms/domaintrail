// Hand-written constructors of domain primitives, checked against the generated contracts.
// The generator documents each invariant; enforcing it at run time is the job of these functions.
import { err, ok, type Common, type Sales } from '../generated/domain/index.js';

export const makeQuantity: Sales.MakeQuantity = (value) =>
    Number.isInteger(value) && value >= 1 && value <= 999 ? ok(value as Sales.Quantity) : err({ type: 'InvalidQuantity', value, invariant: 'valid' });

export const makeSku: Sales.MakeSku = (value) =>
    /^[A-Z]{3}-\d{4}$/.test(value) ? ok(value as Sales.Sku) : err({ type: 'InvalidSku', value, invariant: 'valid' });

export const makeEmailAddress: Common.MakeEmailAddress = (value) => {
    if (!/^[^@\s]+@[^@\s]+$/.test(value)) return err({ type: 'InvalidEmailAddress', value, invariant: 'format' });
    if (value.length > 254) return err({ type: 'InvalidEmailAddress', value, invariant: 'maxLength' });
    return ok(value as Common.EmailAddress);
};

// IDs without invariants cannot fail.
export const makeOrderId: Sales.MakeOrderId = (value) => value as Sales.OrderId;
