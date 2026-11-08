// Where 探す takes the page for an item of the domain model (search/reveal.ts, search/model.ts), on examples/shop's
// payload: the view that draws it, and what is taken away first when the view hides it.
import { beforeAll, describe, expect, test } from 'bun:test';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import { MESSAGES } from '../i18n';
import { exampleSources, viewPayloads } from '../test-helpers';
import { modelFindables } from './model';
import { contextsShowing, modelDestination, modelNotes, type ModelViews } from './reveal';

let payload: ViewPayload;
beforeAll(async () => {
    [payload] = (await viewPayloads(await exampleSources())) as [ViewPayload];
});

const views = (over: Partial<ModelViews> = {}): ModelViews => ({
    graphs: { detail: payload.structure, overview: payload.overview, aggregates: payload.aggregates },
    level: 'detail',
    contexts: null,
    focusContexts: payload.focusContexts,
    catalog: { query: '', sections: [], contexts: null },
    ...over,
});
const go = (id: string, over: Partial<ModelViews> = {}) => (payload.model ? modelDestination(payload.model, id, views(over)) : undefined);

describe('a command or a state', () => {
    test('the Structure View with its aggregate selected, the detail on 状態 showing it', () => {
        expect(go('Sales.Order:confirm')).toEqual({ select: 'Sales.Order:confirm', place: { view: 'structure', show: 'Sales.Order' }, inspector: 'states' });
        expect(go('Sales.Order#Confirmed')).toEqual({
            select: 'Sales.Order#Confirmed',
            place: { view: 'structure', show: 'Sales.Order' },
            inspector: 'states',
        });
    });
});

describe('what the Structure View draws', () => {
    test('an aggregate there, its detail on 状態; an entity, a value object and a context there too', () => {
        expect(go('Sales.Order')).toEqual({ select: 'Sales.Order', place: { view: 'structure', show: 'Sales.Order' }, inspector: 'states' });
        expect(go('Sales.OrderItem')).toEqual({ select: 'Sales.OrderItem', place: { view: 'structure', show: 'Sales.OrderItem' } });
        expect(go('Common.Money')?.place).toEqual({ view: 'structure', show: 'Common.Money' });
        expect(go('Sales')?.place).toEqual({ view: 'structure', show: 'Sales' });
    });

    test('a level that does not draw it: the first that does', () => {
        expect(go('Sales.OrderItem', { level: 'aggregates' })?.place).toEqual({ view: 'structure', show: 'Sales.OrderItem', level: 'detail' });
        expect(go('Sales.Order', { level: 'aggregates' })?.place).toEqual({ view: 'structure', show: 'Sales.Order' });
        expect(go('Sales.Order', { level: 'overview' })?.place).toEqual({ view: 'structure', show: 'Sales.Order' });
    });

    test('the contexts narrowed without its own: it is added (all of them for a shared one, which cannot be chosen)', () => {
        expect(go('Sales.Order:confirm', { contexts: ['Billing'] })?.place).toEqual({ view: 'structure', show: 'Sales.Order', contexts: ['Billing', 'Sales'] });
        expect(go('Sales.Order', { contexts: ['Sales'] })?.place).toEqual({ view: 'structure', show: 'Sales.Order' });
        expect(go('Common.Money', { contexts: ['Sales'] })?.place).toEqual({ view: 'structure', show: 'Common.Money', contexts: null });
        expect(contextsShowing(null, ['A', 'B'], 'A')).toBeUndefined();
        expect(contextsShowing(['A', 'B'], ['A', 'B'], 'C')).toBeUndefined();
        expect(contextsShowing([], ['A', 'B'], 'B')).toEqual(['B']);
    });

    test('a value object the Structure View never draws (no aggregate holds it): the catalog', () => {
        const graphs = { detail: { nodes: [] }, overview: { nodes: [] }, aggregates: { nodes: [] } };
        expect(go('Common.Money', { graphs })).toEqual({ select: 'Common.Money', place: { view: 'catalog', clearFilter: false } });
        // a context no view draws: the context map
        expect(go('Sales', { graphs })?.place).toEqual({ view: 'contextMap' });
    });
});

describe('the catalog’s kinds', () => {
    test('the catalog, its filter cleared only when it hides the element', () => {
        expect(go('Sales.Sku')).toEqual({ select: 'Sales.Sku', place: { view: 'catalog', clearFilter: false } });
        expect(go('Sales.Sku', { catalog: { query: '商品', sections: [], contexts: null } })?.place).toEqual({ view: 'catalog', clearFilter: false });
        expect(go('Sales.Sku', { catalog: { query: '請求', sections: [], contexts: null } })?.place).toEqual({ view: 'catalog', clearFilter: true });
        expect(go('Sales.Sku', { catalog: { query: '', sections: ['events'], contexts: null } })?.place).toEqual({ view: 'catalog', clearFilter: true });
        expect(go('Sales.Sku', { catalog: { query: '', sections: ['primitives'], contexts: ['Billing'] } })?.place).toEqual({
            view: 'catalog',
            clearFilter: true,
        });
        expect(go('Sales.OrderPlaced')?.place).toEqual({ view: 'catalog', clearFilter: false });
    });

    test('what the model does not have: nowhere', () => {
        expect(go('Sales.Nothing')).toBeUndefined();
    });
});

describe('what was taken away, to say it', () => {
    test('a level, a narrowing (the contexts, the catalog’s filter)', () => {
        expect(modelNotes({ view: 'structure', show: 'X', level: 'detail', contexts: null })).toEqual({ level: 'detail', filter: true });
        expect(modelNotes({ view: 'structure', show: 'X' })).toEqual({ filter: false });
        expect(modelNotes({ view: 'catalog', clearFilter: true })).toEqual({ filter: true });
        expect(modelNotes({ view: 'source' })).toEqual({ filter: false });
    });
});

describe('what 探す finds of the model', () => {
    test('contexts, elements, commands and states, by their qualified names and labels, placed in their context and aggregate', () => {
        const found = modelFindables(payload.model, 'label', MESSAGES.ja, () => {});
        const of = (key: string) => found.find((f) => f.key === key);
        expect(of('Sales')).toMatchObject({ kind: 'context', name: 'Sales', label: '販売', kindName: 'コンテキスト' });
        expect(of('Sales')?.place).toBeUndefined();
        expect(of('Sales.Order')).toMatchObject({ kind: 'aggregate', name: 'Sales.Order', label: '注文', place: '販売' });
        expect(of('Sales.Order:confirm')).toMatchObject({ kind: 'command', name: 'Sales.Order.confirm', label: '注文を確定する', place: '販売 › 注文' });
        expect(of('Sales.Order#Draft')).toMatchObject({ kind: 'state', name: 'Sales.Order.Draft', label: '下書き', kindName: '状態' });
        // in the order they are written: an aggregate's commands and states after it
        const keys = found.map((f) => f.key);
        expect(keys.indexOf('Sales.Order')).toBeLessThan(keys.indexOf('Sales.Order:place'));
        expect(keys.indexOf('Sales.Order:place')).toBeLessThan(keys.indexOf('Sales.OrderItem'));
        // the places follow the display mode
        expect(modelFindables(payload.model, 'name', MESSAGES.ja, () => {}).find((f) => f.key === 'Sales.Order:confirm')?.place).toBe('Sales › Order');
    });
});
