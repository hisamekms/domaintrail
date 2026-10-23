// The contract tests generated from the model, registered with bun:test. Run `dt generate ts` first (the config's
// `generate.ts.tests` writes them), then `bun test` in this directory.
import { Common, Sales, register } from '../generated/domain/tests/index.js';
import { orderCommands } from './order-commands.js';
import { makeEmailAddress, makeOrderId, makeQuantity, makeSku } from './primitives.js';

register(Sales.contract({ make: { Quantity: makeQuantity, Sku: makeSku, OrderId: makeOrderId }, Order: orderCommands }));
register(Common.contract({ make: { EmailAddress: makeEmailAddress } }));
