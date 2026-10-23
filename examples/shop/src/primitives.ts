// Constructors of domain primitives. The generator writes them from the invariants of the DSL (`Sales.makeQuantity`,
// …), returning the first invariant violated; a hand-written one, like `makeEmailAddress`, implements the same contract
// and is checked by the generated tests (src/contract.test.ts) against the generated checks.
import { Sales, err, ok, type Common } from '../generated/domain/index.js';

export const makeQuantity: Sales.MakeQuantity = Sales.makeQuantity;
export const makeSku: Sales.MakeSku = Sales.makeSku;

export const makeEmailAddress: Common.MakeEmailAddress = (value) => {
    if (!/^[^@\s]+@[^@\s]+$/.test(value)) return err({ type: 'InvalidEmailAddress', value, invariant: 'format' });
    if (value.length > 254) return err({ type: 'InvalidEmailAddress', value, invariant: 'maxLength' });
    return ok(value as Common.EmailAddress);
};

// IDs without invariants cannot fail.
export const makeOrderId: Sales.MakeOrderId = Sales.makeOrderId;
