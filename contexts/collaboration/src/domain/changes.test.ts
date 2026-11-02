// What a unit changed in the model's words (domain/changes.ts): the `.dt` and `.dtes` elements two analyses differ by.
import { describe, expect, test } from 'bun:test';
import { check } from '../test-helpers.js';
import { elementChanges, type ElementChange } from './changes.js';

const dt = (body: string): string => `context Sales {\n  id OrderId: UUID\n${body}}\n`;
const order = (inner: string): string => `  aggregate Order "注文" {\n    id: OrderId\n${inner}  }\n`;

/** A change as one line: the mark, the ID, the kind and the owner. */
const line = (c: ElementChange): string =>
    `${c.change} ${c.language === 'Dt' ? c.element : `es/${c.storming}/${c.local}`} ${c.kind}${c.label ? ` "${c.label}"` : ''}${c.owner ? ` of ${c.owner.name}` : ''}`;

describe('element changes', () => {
    test('states and commands by stable ID; an aggregate is changed by its own parts, not by its states or commands', async () => {
        const before = await check({
            'sales.dt': dt(order('    note: String\n    state Draft\n    create command place(id: OrderId)\n      -> Draft\n')),
        });
        const after = await check({
            'sales.dt': dt(
                order(
                    '    note: String\n    state Draft\n    state Confirmed "確定済み"\n    create command place(id: OrderId, at: Timestamp)\n      -> Draft\n    command confirm()\n      Draft -> Confirmed\n',
                ),
            ),
        });
        expect(elementChanges(before, after).changes.map(line)).toEqual([
            'added Sales.Order#Confirmed state "確定済み" of Order',
            'added Sales.Order:confirm command of Order',
            // a parameter is a part of its command
            'changed Sales.Order:place command of Order',
        ]);
        expect(elementChanges(before, after).complete).toBe(true);
    });

    test('a field is a part of its element; an element removed is named from the model before', async () => {
        const before = await check({ 'sales.dt': dt(order('    note: String\n') + '  event Placed {\n    id: OrderId\n  }\n') });
        const after = await check({ 'sales.dt': dt(order('')) });
        expect(elementChanges(before, after).changes.map(line)).toEqual(['changed Sales.Order aggregate "注文"', 'removed Sales.Placed event']);
    });

    test('moving code around changes nothing', async () => {
        const text = dt(order('    state Draft\n'));
        const before = await check({ 'sales.dt': text });
        const after = await check({ 'sales.dt': `// moved\n\n${text}` });
        expect(elementChanges(before, after).changes).toEqual([]);
    });

    test('storming declarations by storming and local ID, without their source ranges; a timeline not for its groups', async () => {
        const storming = (events: string, group: string): string =>
            `storming Returns "返品" {\n  event Requested "返品依頼"\n${events}  policy Refund\n  timeline Flow {\n    Requested\n    group Closing {\n${group}    }\n  }\n}\n`;
        const before = await check({ 'returns.dtes': storming('  event Received\n', '      Requested\n') });
        const after = await check({ 'returns.dtes': `\n${storming('  event Rejected\n  hotspot Who "誰？"\n', '      Rejected\n')}` });
        expect(elementChanges(before, after).changes.map(line)).toEqual([
            'added es/Returns/Rejected event of Returns',
            'added es/Returns/Who hotspot "誰？" of Returns',
            'changed es/Returns/Closing group of Returns',
            'removed es/Returns/Received event of Returns',
        ]);
    });

    test('a side that does not parse: no changes of its DSL, and the list is incomplete', async () => {
        const good = await check({ 'sales.dt': dt(order('')), 'returns.dtes': 'storming Returns {\n  event Requested\n}\n' });
        const broken = await check({ 'sales.dt': 'context Sales {', 'returns.dtes': 'storming Returns {\n  event Requested\n  event Received\n}\n' });
        const r = elementChanges(good, broken);
        expect(r.complete).toBe(false);
        expect(r.changes.map(line)).toEqual(['added es/Returns/Received event of Returns']);
        expect(elementChanges(broken, broken).complete).toBe(false);
    });
});
