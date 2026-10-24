// The commands of Sales.Customer, an aggregate without states: each command is decided by one function, and its
// outcome is keyed by the aggregate's name. The email address arrives as a `Sales.AvailableEmail`, so it has been made
// (and checked against the other customers, see src/app/verifications.ts) before the command runs; the command itself
// cannot fail, and stores it as the `Common.EmailAddress` it is.
import { Sales, decide, ok } from '../../generated/domain/index.js';

export const customerCommands: Sales.CustomerCommands = {
    register: decide<Sales.RegisterCustomerDecision>(Sales.CustomerShape, (id, name, email) =>
        ok({ Customer: { set: { id, name, email }, events: { CustomerRegistered: { type: 'CustomerRegistered', customerId: id } } } }),
    ),

    // `changes name` and no `emits`: renaming is not a fact other contexts react to.
    rename: decide<Sales.RenameCustomerDecision>(Sales.CustomerShape, (_customer, name) => ok({ Customer: { set: { name }, events: {} } })),

    changeEmail: decide<Sales.ChangeEmailCustomerDecision>(Sales.CustomerShape, (_customer, email) => ok({ Customer: { set: { email }, events: {} } })),
};
