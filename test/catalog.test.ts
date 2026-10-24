import { describe, expect, test } from 'bun:test';
import { analyze } from '../src/core/analyze.js';
import { loadWorkspace } from '../src/core/files.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InvariantModel } from '../src/model/model.js';
import { CardHead, Invariants as CardInvariants } from '../web/catalog.js';
import { MESSAGES } from '../web/i18n.js';
import { Invariants as InspectorInvariants } from '../web/inspector.js';
import { catalogSections, commandsWithOutcome, filterCatalog, inCatalog, isCatalogFiltered, matchesQuery, namer, type CatalogFilter } from '../web/model-utils.js';
import { EXAMPLES } from './helpers.js';

async function shopModel() {
    return (await analyze(await loadWorkspace(EXAMPLES))).model!;
}

describe('catalog', () => {
    test('has a section per kind of element, with every element in exactly one', async () => {
        const model = await shopModel();
        const sections = catalogSections(model);
        expect(sections.map((s) => s.key)).toEqual(['aggregates', 'entities', 'values', 'primitives', 'fieldSets', 'events', 'errors', 'policies']);
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
        // by kind (primitive, verified, id, enum), then by name
        expect(sales.items.map((e) => e.name)).toEqual(['Quantity', 'Sku', 'AvailableEmail', 'CustomerId', 'OrderId', 'OrderItemId', 'CancelReason']);
        const aggregates = catalogSections(model).find((s) => s.key === 'aggregates')!;
        expect(aggregates.groups.some((g) => g.context === 'Common')).toBe(false);
    });

    test('finds the commands that emit an event or return an error', async () => {
        const model = await shopModel();
        expect(commandsWithOutcome(model, 'Sales.OrderConfirmed').map((c) => c.command.name)).toEqual(['confirm']);
        expect(commandsWithOutcome(model, 'Sales.EmptyOrder').map((c) => `${c.agg.name}.${c.command.name}`)).toEqual(['Order.confirm']);
    });

    describe('filter', () => {
        const none: CatalogFilter = { query: '', sections: [], contexts: null };
        const shown = (sections: ReturnType<typeof filterCatalog>) => sections.flatMap((s) => s.groups.flatMap((g) => g.items.map((e) => e.id)));

        test('keeps everything when nothing is set', async () => {
            const sections = catalogSections(await shopModel());
            expect(isCatalogFiltered(none)).toBe(false);
            expect(isCatalogFiltered({ ...none, query: '  ' })).toBe(false);
            const all = filterCatalog(sections, none);
            expect(all.map((s) => s.shown)).toEqual(sections.map((s) => s.count));
        });

        test('matches the label, name or description, ignoring case', () => {
            const el = { name: 'OrderPlaced', label: '注文確定', doc: 'Raised when the CUSTOMER pays' } as Parameters<typeof matchesQuery>[0];
            expect(matchesQuery(el, 'orderplaced')).toBe(true);
            expect(matchesQuery(el, '確定')).toBe(true);
            expect(matchesQuery(el, 'customer')).toBe(true);
            expect(matchesQuery(el, ' placed ')).toBe(true);
            expect(matchesQuery(el, 'shipped')).toBe(false);
            expect(matchesQuery({ name: 'Sku' } as Parameters<typeof matchesQuery>[0], 'sku')).toBe(true);
        });

        test('narrows by text, keeping each section total and counting the matches', async () => {
            const model = await shopModel();
            const sections = filterCatalog(catalogSections(model), { ...none, query: 'order' });
            const ids = shown(sections);
            expect(ids.length).toBeGreaterThan(0);
            expect(ids.every((id) => matchesQuery(model.elements[id], 'order'))).toBe(true);
            for (const s of sections) {
                expect(s.count).toBe(catalogSections(model).find((x) => x.key === s.key)!.count);
                expect(s.shown).toBe(s.groups.reduce((n, g) => n + g.items.length, 0));
                expect(s.groups.every((g) => g.items.length > 0)).toBe(true);
            }
        });

        test('narrows by kind of section and by context, all of them combined', async () => {
            const model = await shopModel();
            const byKind = filterCatalog(catalogSections(model), { ...none, sections: ['events', 'errors'] });
            expect(byKind.filter((s) => s.shown > 0).map((s) => s.key)).toEqual(['events', 'errors']);
            const byContext = filterCatalog(catalogSections(model), { ...none, contexts: ['Common'] });
            expect(shown(byContext).every((id) => model.elements[id].context === 'Common')).toBe(true);
            expect(shown(byContext).length).toBeGreaterThan(0);
            expect(shown(filterCatalog(catalogSections(model), { ...none, contexts: [] }))).toEqual([]);
            const combined = filterCatalog(catalogSections(model), { query: 'order', sections: ['events'], contexts: ['Sales'] });
            expect(shown(combined).every((id) => model.elements[id].kind === 'event' && model.elements[id].context === 'Sales')).toBe(true);
            expect(shown(filterCatalog(catalogSections(model), { ...none, query: 'no-such-element' }))).toEqual([]);
        });
    });

    describe('card heading', () => {
        const tx = MESSAGES.ja;
        const head = (el: Parameters<typeof CardHead>[0]['el']) => renderToStaticMarkup(CardHead({ el, tx }));
        const lines = (html: string) => [...html.matchAll(/class="(card-tags|card-name|card-subname)"/g)].map((m) => m[1]);

        test('puts the badges first, then the label over the name', async () => {
            const model = await shopModel();
            const event = Object.values(model.elements).find((e) => e.kind === 'event' && e.label && !e.persistent)!;
            const html = head(event);
            expect(lines(html)).toEqual(['card-tags', 'card-name', 'card-subname']);
            expect(html).toContain(`title="${event.label}">${event.label}</span>`);
            expect(html).toContain(`title="${event.name}">${event.name}</span>`);
            const tags = html.slice(html.indexOf('card-tags'), html.indexOf('card-name'));
            expect(tags.indexOf(tx.kinds.event)).toBeLessThan(tags.indexOf(tx.transient));
        });

        test('shows the name alone when there is no label, and the persistence badge only on events', async () => {
            const model = await shopModel();
            const order = Object.values(model.elements).find((e) => e.kind === 'aggregate')!;
            const el = { ...order, id: 'Sales.Audit', name: 'Audit', kind: 'fieldSet' as const, label: undefined };
            const html = head(el);
            expect(lines(html)).toEqual(['card-tags', 'card-name']);
            expect(html).toContain(`>${el.name}</span>`);
            expect(html).toContain(tx.kinds.fieldSet);
            expect(html).not.toContain('persistence-badge');
        });
    });
});

describe('invariants without an expression', () => {
    const invariants: InvariantModel[] = [
        { name: 'hasItems', label: '明細が1件以上', source: 'count(items) > 0' },
        { name: 'acyclicDeps', label: 'タスク依存が循環しない', doc: 'depends を辺とするグラフに閉路がない' },
    ];

    test('show that they are not expressed in the DSL, in place of the expression', () => {
        const card = renderToStaticMarkup(createElement(CardInvariants, { invariants, names: namer('both', null) }));
        expect(card).toContain('<code>count(items) &gt; 0</code>');
        expect(card).toContain(`<em class="not-in-dsl">${MESSAGES.ja.notInDsl}</em>`);
        const inspector = renderToStaticMarkup(createElement(InspectorInvariants, { items: invariants, title: MESSAGES.ja.invariants }));
        expect(inspector).toContain('<code class="block">count(items) &gt; 0</code>');
        expect(inspector).toContain('depends を辺とするグラフに閉路がない');
        expect(inspector).toContain(`<p class="not-in-dsl">${MESSAGES.ja.notInDsl}</p>`);
        expect(inspector.match(/<code/g)).toHaveLength(1);
    });
});
