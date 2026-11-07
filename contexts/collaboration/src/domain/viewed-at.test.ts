// Where the requester was looking: read as a page sends it, its names checked against the workspace, and as the
// prompts show it.
import { describe, expect, test } from 'bun:test';
import type { Collaboration } from '../generated/index.js';
import { type KnownViewNames, readViewedAt, resolveViewedAt, viewedAtData } from './viewed-at.js';

const storming = { kind: 'Storming', storming: 'OrderToCash', level: 'DesignLevel', stage: 'Payment', exceptions: false };

const known: KnownViewNames = {
    contexts: new Set(['Sales', 'Billing']),
    aggregates: new Set(['Sales.Order']),
    stormings: new Map([['OrderToCash', { timelines: new Set(['Normal', 'PaymentFailed']), stages: new Set(['Payment']) }]]),
};

/** A view read from JSON: the test's inputs are valid. */
function read(v: unknown): Collaboration.ViewedAt {
    const r = readViewedAt(v);
    if (!r.ok) throw new Error(`${r.error.path}: ${r.error.message}`);
    return r.value;
}

describe('readViewedAt', () => {
    test('each kind of view, with the state diagram the inspector shows', () => {
        expect(read({ view: { kind: 'ContextMap', all: true } }) as unknown).toEqual({ view: { kind: 'ContextMap', all: true } });
        expect(read({ view: { kind: 'Structure', level: 'Overview', focus: ['Sales'] }, states: 'Sales.Order' }) as unknown).toEqual({
            view: { kind: 'Structure', level: 'Overview', focus: ['Sales'] },
            states: 'Sales.Order',
        });
        expect(read({ view: { kind: 'Catalog', query: ' 注文 ', sections: ['aggregates'] } }) as unknown).toEqual({
            view: { kind: 'Catalog', query: '注文', sections: ['aggregates'], contexts: [] },
        });
        expect(read({ view: storming }) as unknown).toEqual({ view: storming });
        // the exceptions are shown unless said otherwise
        expect(read({ view: { kind: 'Storming', storming: 'OrderToCash', level: 'BigPicture' } }) as unknown).toEqual({
            view: { kind: 'Storming', storming: 'OrderToCash', level: 'BigPicture', exceptions: true },
        });
        // one exception's case: the exception chosen
        const failed = { ...storming, exceptions: true, exception: 'PaymentFailed' };
        expect(read({ view: failed }) as unknown).toEqual({ view: failed });
    });

    test('refuses what is not a view, naming the field', () => {
        const path = (v: unknown): string | undefined => {
            const r = readViewedAt(v);
            return r.ok ? undefined : r.error.path;
        };
        expect(path('storming')).toBe('viewedAt');
        expect(path({ view: { kind: 'Inspector' } })).toBe('viewedAt.view.kind');
        expect(path({ view: { kind: 'Storming', storming: 'A', level: 'Design' } })).toBe('viewedAt.view.level');
        expect(path({ view: { ...storming, timeline: 'Normal' } })).toBe('viewedAt.view.stage');
        expect(path({ view: { kind: 'Storming', storming: 'A', level: 'BigPicture', timeline: 'Normal', exception: 'Failed' } })).toBe(
            'viewedAt.view.exception',
        );
        expect(path({ view: { ...storming, exception: '' } })).toBe('viewedAt.view.exception');
        expect(path({ view: { kind: 'Structure', level: 'Detail', focus: ['Sales', 'Sales'] } })).toBe('viewedAt.view.focus[1]');
        expect(path({ view: { kind: 'Structure', level: 'Detail', focus: Array.from({ length: 51 }, (_, i) => `C${i}`) } })).toBe('viewedAt.view.focus');
        expect(path({ view: { kind: 'Catalog', query: 'x'.repeat(201) } })).toBe('viewedAt.view.query');
        expect(path({ view: { kind: 'ContextMap', all: false, camera: 1 } })).toBe('viewedAt.view.camera');
        expect(path({ view: { kind: 'ContextMap', all: false }, states: 'a\nb' })).toBe('viewedAt.states');
    });
});

describe('resolveViewedAt', () => {
    test('keeps the names the workspace has', () => {
        const v = read({ view: storming, states: 'Sales.Order' });
        expect(resolveViewedAt(v, known)).toEqual(v);
    });

    test('drops what the workspace lacks: a stage or timeline, contexts, an aggregate; a storming drops the view', () => {
        expect(resolveViewedAt(read({ view: { ...storming, stage: 'Gone' }, states: 'Sales.Gone' }), known) as unknown).toEqual({
            view: { kind: 'Storming', storming: 'OrderToCash', level: 'DesignLevel', exceptions: false },
        });
        expect(resolveViewedAt(read({ view: { kind: 'Storming', storming: 'OrderToCash', level: 'BigPicture', timeline: 'Gone' } }), known) as unknown).toEqual(
            {
                view: { kind: 'Storming', storming: 'OrderToCash', level: 'BigPicture', exceptions: true },
            },
        );
        expect(resolveViewedAt(read({ view: { kind: 'Structure', level: 'Detail', focus: ['Sales', 'Gone'] } }), known) as unknown).toEqual({
            view: { kind: 'Structure', level: 'Detail', focus: ['Sales'] },
        });
        expect(resolveViewedAt(read({ view: { kind: 'Catalog', contexts: ['Gone'] } }), known) as unknown).toEqual({
            view: { kind: 'Catalog', sections: [], contexts: [] },
        });
        expect(resolveViewedAt(read({ view: { ...storming, storming: 'Returns' } }), known)).toBeUndefined();
        // an exception gone: every exception, as the page shows it then
        expect(resolveViewedAt(read({ view: { ...storming, exceptions: true, exception: 'Gone' } }), known) as unknown).toEqual({
            view: { ...storming, exceptions: true },
        });
    });
});

describe('viewedAtData', () => {
    test("a storming as the prompts show it: its reference, the level's word, the stage, the exceptions", () => {
        expect(viewedAtData(read({ view: storming }))).toEqual({
            view: 'storming',
            storming: '@{es:OrderToCash}',
            level: 'design',
            stage: 'Payment',
            exceptions: false,
        });
        expect(viewedAtData(read({ view: { ...storming, exceptions: true, exception: 'PaymentFailed' } }))).toMatchObject({
            stage: 'Payment',
            exceptions: true,
            exception: 'PaymentFailed',
        });
    });

    test('the .dt views, with only what narrows them, and the state diagram', () => {
        expect(viewedAtData(read({ view: { kind: 'ContextMap', all: false } }))).toEqual({ view: 'context map' });
        expect(viewedAtData(read({ view: { kind: 'Structure', level: 'Aggregates', focus: ['Sales'] }, states: 'Sales.Order' }))).toEqual({
            view: 'structure',
            detail: 'aggregates',
            contexts: ['Sales'],
            stateDiagramOf: '@{Sales.Order}',
        });
        expect(viewedAtData(read({ view: { kind: 'Catalog', query: '注文' } }))).toEqual({ view: 'catalog', filter: '注文' });
    });
});
