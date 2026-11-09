import { expect, test } from 'bun:test';
import * as fc from 'fast-check';
import { commandCases } from 'domaintrail/testing';

test('contract tests reject a named outcome whose choice rule is false', () => {
    const cases = commandCases({
        name: 'Request.audit',
        run: () => ({ ok: true, value: { denied: { aggregate: { kind: 'COLLECT', state: 'Assigned' }, events: {} } } }),
        input: () => fc.constant([{ kind: 'COLLECT', state: 'Assigned' }]),
        examples: [],
        factory: false,
        requires: [],
        declaredRequires: [],
        declaredInvariants: [],
        stateful: true,
        counted: [],
        kindField: 'kind',
        validStates: [{ kind: 'COLLECT', states: ['Assigned'] }],
        outcomes: [
            { name: 'approved', from: ['Assigned'], to: 'Assigned', kinds: ['COLLECT'] },
            { name: 'denied', from: ['Assigned'], to: 'Assigned', kinds: ['COLLECT'] },
        ],
        choices: () => ({ approved: true, denied: false }),
    }, { runs: 1 });
    const selection = cases.find((c) => c.name.includes('selects one applicable named outcome'))!;
    expect(() => selection.run()).toThrow("returned outcome 'denied' although its choice rule is false");
});
