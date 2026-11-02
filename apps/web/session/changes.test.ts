// What a unit changed, in the model's words (apps/web/session/changes.ts): the elements named as the target chips are —
// from the model now while they are there, else as the server gave them — with what each is and where it goes.
import { describe, expect, test } from 'bun:test';
import { analyze } from '@domaintrail/analysis';
import { MESSAGES } from '../i18n';
import { changeFullName, changeGroups, changeShortName, changeTarget, changeWhat, type ElementChange } from './changes';
import type { NamingContext } from './targets';
import { exampleSources } from '../test-helpers';

const draft: ElementChange = { change: 'changed', language: 'Dt', element: 'Sales.Order#Draft', kind: 'state', name: 'Draft', owner: { name: 'Order' } };
const gone: ElementChange = {
    change: 'removed',
    language: 'Dt',
    element: 'Sales.Order#Gone',
    kind: 'state',
    name: 'Gone',
    label: '消えた',
    owner: { name: 'Order', label: '注文' },
};
const order: ElementChange = { change: 'added', language: 'Dt', element: 'Sales.Order', kind: 'aggregate', name: 'Order', label: '注文' };
const returned: ElementChange = {
    change: 'added',
    language: 'Dtes',
    storming: 'Returns',
    local: 'ReturnRequested',
    kind: 'event',
    name: 'ReturnRequested',
    owner: { name: 'Returns', label: '返品' },
};

describe('changes in the model words', () => {
    test('named from the model now in the display mode; a removed one as the server gave it', async () => {
        const a = await analyze(await exampleSources());
        const stormings = a.stormings.stormings.map((s) => ({ id: s.id, storming: s }));
        const naming = (mode: NamingContext['mode']): NamingContext => ({ mode, model: a.model ?? null, stormings });
        expect(changeShortName(draft, naming('label'))).toBe('下書き');
        expect(changeFullName(draft, naming('label'))).toBe('注文.下書き');
        expect(changeShortName(returned, naming('label'))).toBe('返品が依頼された');
        expect(changeFullName(returned, naming('name'))).toBe('Returns / ReturnRequested');
        // not in the model now: the names the server gave
        expect(changeShortName(gone, naming('label'))).toBe('消えた');
        expect(changeFullName(gone, naming('both'))).toBe('注文 (Order).消えた (Gone)');
        expect(changeShortName(gone, undefined)).toBe('Gone');
        expect(changeFullName(order, undefined)).toBe('Sales.Order');
    });

    test('what each is, its owner first; where it goes; grouped by kind of change, only the kinds there are', () => {
        const of = MESSAGES.ja.session.comparison.of;
        expect(changeWhat(draft, MESSAGES.ja, of, undefined)).toBe('Order の状態');
        expect(changeWhat(order, MESSAGES.ja, of, undefined)).toBe('集約');
        expect(changeWhat(returned, MESSAGES.ja, of, { mode: 'label', model: null, stormings: [] })).toBe('返品 のイベント');
        expect(changeTarget(draft)).toEqual({ kind: 'DtElement', element: 'Sales.Order#Draft' });
        expect(changeTarget(returned)).toEqual({ kind: 'DtesElement', storming: 'Returns', local: 'ReturnRequested' });
        expect(changeGroups([gone, order, draft, returned]).map((g) => [g.change, g.items.map((c) => c.name)])).toEqual([
            ['added', ['Order', 'ReturnRequested']],
            ['changed', ['Draft']],
            ['removed', ['Gone']],
        ]);
    });
});
