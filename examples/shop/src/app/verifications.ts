// The factories of the verified types: the checks a pure command cannot make, because they read beyond its aggregate.
// Each one is the only code that asserts its type (`as Sales.AvailableEmail`); a command that takes the type cannot be
// called without it. The check holds at the moment it is made: two registrations at once may both pass, so a real
// store enforces the same rule where it saves (a unique index on the email address) and reports the conflict.
import { err, ok, type Sales } from '../../generated/domain/index.js';
import type { CustomerRepository } from './repositories.js';

export interface Verifications {
    readonly makeAvailableEmail: Sales.MakeAvailableEmail;
}

export function verifications(customers: CustomerRepository): Verifications {
    return {
        // `customer` is the one whose email changes, so that keeping one's own address is not "taken"; none on register.
        async makeAvailableEmail(email, customer) {
            const holder = await customers.find((c) => c.email === email && c.id !== customer);
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory of the verified type: the check above is the evidence
            return holder ? err({ type: 'EmailTaken', email }) : ok(email as Sales.AvailableEmail);
        },
    };
}
