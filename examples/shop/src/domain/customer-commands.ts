// The commands of Sales.Customer, an aggregate without states: each command is decided by one function, and its
// outcome is keyed by the aggregate's name. The email address arrives as a `Common.EmailAddress`, so it has been made
// (and checked) before the command runs; the command itself cannot fail.
import { Sales, decide, ok } from '../../generated/domain/index.js';

export const customerCommands: Sales.CustomerCommands = {
    register: decide<Sales.RegisterCustomerDecision>(Sales.CustomerShape, (id, name, email) =>
        ok({ Customer: { set: { id, name, email }, events: { CustomerRegistered: { type: 'CustomerRegistered', customerId: id } } } }),
    ),

    // `changes name` and no `emits`: renaming is not a fact other contexts react to.
    rename: decide<Sales.RenameCustomerDecision>(Sales.CustomerShape, (_customer, name) => ok({ Customer: { set: { name }, events: {} } })),
};
