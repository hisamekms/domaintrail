import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { catalogSections, commandsWithOutcome, inCatalog } from '../web/model-utils.js';
import { check, EXAMPLES } from './helpers.js';

async function shopModel() {
    const files = (await readdir(EXAMPLES)).filter((f) => f.endsWith('.dt'));
    const sources = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await readFile(path.join(EXAMPLES, f), 'utf8')] as const)));
    return (await check(sources)).model!;
}

describe('catalog', () => {
    test('has a section per kind of element, with every element in exactly one', async () => {
        const model = await shopModel();
        const sections = catalogSections(model);
        expect(sections.map((s) => s.key)).toEqual(['aggregates', 'entities', 'values', 'primitives', 'events', 'errors']);
        const ids = sections.flatMap((s) => s.groups.flatMap((g) => g.items.map((e) => e.id)));
        expect(ids.sort()).toEqual(Object.keys(model.elements).sort());
        expect(Object.values(model.elements).every((e) => inCatalog(e.kind))).toBe(true);
        for (const s of sections) expect(s.count).toBe(s.groups.reduce((n, g) => n + g.items.length, 0));
    });

    test('groups by context, shared contexts first, and leaves out contexts without such elements', async () => {
        const model = await shopModel();
        const primitives = catalogSections(model).find((s) => s.key === 'primitives')!;
        expect(primitives.groups[0].context).toBe('Common');
        const sales = primitives.groups.find((g) => g.context === 'Sales')!;
        // by kind (primitive, id, enum), then by name
        expect(sales.items.map((e) => e.name)).toEqual(['Quantity', 'Sku', 'CustomerId', 'OrderId', 'OrderItemId', 'CancelReason']);
        const aggregates = catalogSections(model).find((s) => s.key === 'aggregates')!;
        expect(aggregates.groups.some((g) => g.context === 'Common')).toBe(false);
    });

    test('finds the commands that emit an event or return an error', async () => {
        const model = await shopModel();
        expect(commandsWithOutcome(model, 'Sales.OrderConfirmed').map((c) => c.command.name)).toEqual(['confirm']);
        expect(commandsWithOutcome(model, 'Sales.EmptyOrder').map((c) => `${c.agg.name}.${c.command.name}`)).toEqual(['Order.confirm']);
    });
});
