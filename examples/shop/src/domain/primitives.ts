// Constructors of domain primitives. Every invariant of this model has an expression, so the generated constructors
// (`Sales.makeQuantity`, …) are complete and used as they are: they check exactly the DSL's invariants and return the
// first one violated. A hand-written one would implement the same `Make<Name>` type and be checked by the generated
// tests (src/contract.test.ts) against the generated checks; this module is the one place to swap it in.
import { Billing, Common, Sales } from '../../generated/domain/index.js';

export const makeQuantity: Sales.MakeQuantity = Sales.makeQuantity;
export const makeSku: Sales.MakeSku = Sales.makeSku;
export const makeEmailAddress: Common.MakeEmailAddress = Common.makeEmailAddress;
export const makeAmount: Common.MakeAmount = Common.makeAmount;

// IDs without invariants cannot fail.
export const makeCustomerId: Sales.MakeCustomerId = Sales.makeCustomerId;
export const makeOrderId: Sales.MakeOrderId = Sales.makeOrderId;
export const makeOrderItemId: Sales.MakeOrderItemId = Sales.makeOrderItemId;
export const makeInvoiceId: Billing.MakeInvoiceId = Billing.makeInvoiceId;

