// Element references in the agent's reply (apps/web/session/references.ts): the token grammar, both kinds, resolution in the
// name display setting, and what is left as text.
import { describe, expect, test } from 'bun:test';
import { analyze } from '@domaintrail/analysis';
import { parseReplyText, referenceText, type ReplySegment } from './references';
import type { NamingContext } from './targets';
import { exampleSources } from '../test-helpers';

const refs = (text: string): ReplySegment[] => parseReplyText(text);

describe('reply text with element references', () => {
    test('text without tokens is one text segment, unchanged; none for empty text', () => {
        expect(refs('注文を確定できるようにしました。')).toEqual([{ kind: 'text', text: '注文を確定できるようにしました。' }]);
        expect(refs('')).toEqual([]);
        // a request body's mention is not a reference
        expect(refs('@注文[1] と @{} と @ {x}')).toEqual([{ kind: 'text', text: '@注文[1] と @{} と @ {x}' }]);
    });

    test('.dt elements, states and commands, and .dtes elements, next to punctuation and Japanese text', () => {
        expect(refs('@{Sales.Order}に@{Sales.Order#Draft}を足し、@{Sales.Order:confirm}。（@{es:Returns/ReturnRequested}）')).toEqual([
            { kind: 'ref', target: { kind: 'DtElement', element: 'Sales.Order' }, id: 'Sales.Order' },
            { kind: 'text', text: 'に' },
            { kind: 'ref', target: { kind: 'DtElement', element: 'Sales.Order#Draft' }, id: 'Sales.Order#Draft' },
            { kind: 'text', text: 'を足し、' },
            { kind: 'ref', target: { kind: 'DtElement', element: 'Sales.Order:confirm' }, id: 'Sales.Order:confirm' },
            { kind: 'text', text: '。（' },
            { kind: 'ref', target: { kind: 'DtesElement', storming: 'Returns', local: 'ReturnRequested' }, id: 'es:Returns/ReturnRequested' },
            { kind: 'text', text: '）' },
        ]);
    });

    test('`\\@{` is a literal `@{`; a malformed storming reference stays as written', () => {
        expect(refs('write \\@{Sales.Order} literally')).toEqual([{ kind: 'text', text: 'write @{Sales.Order} literally' }]);
        expect(refs('@{es:Returns} and @{es:a/b/c}')).toEqual([{ kind: 'text', text: '@{es:Returns} and @{es:a/b/c}' }]);
    });

    test('resolved in the display setting; unresolved as the identifier, without braces', async () => {
        const files = await exampleSources();
        const a = await analyze(files);
        const stormings = a.stormings.stormings.map((s) => ({ id: s.id, storming: s }));
        const naming = (mode: NamingContext['mode']): NamingContext => ({ mode, model: a.model ?? null, stormings });
        const [order] = refs('@{Sales.Order}');
        const [returned] = refs('@{es:Returns/ReturnRequested}');
        const [gone] = refs('@{Sales.Gone}');
        const [goneEs] = refs('@{es:Returns/Gone}');
        if (order?.kind !== 'ref' || returned?.kind !== 'ref' || gone?.kind !== 'ref' || goneEs?.kind !== 'ref') throw new Error('not references');
        expect(referenceText(order, naming('label'))).toEqual({ text: '注文', resolved: true });
        expect(referenceText(order, naming('name'))).toEqual({ text: 'Order', resolved: true });
        // its own name shown; what it is in only in the path (the tooltip)
        expect(referenceText(returned, naming('name'))).toEqual({ text: 'ReturnRequested', resolved: true, path: 'Returns / ReturnRequested' });
        expect(referenceText(gone, naming('label'))).toEqual({ text: 'Sales.Gone', resolved: false });
        expect(referenceText(goneEs, naming('label'))).toEqual({ text: 'Returns/Gone', resolved: false });
        expect(referenceText(order, undefined)).toEqual({ text: 'Sales.Order', resolved: false });
        const [draft] = refs('@{Sales.Order#Draft}');
        const [confirm] = refs('@{Sales.Order:confirm}');
        if (draft?.kind !== 'ref' || confirm?.kind !== 'ref') throw new Error('not references');
        expect(referenceText(draft, naming('label'))).toEqual({ text: '下書き', resolved: true, path: '注文.下書き' });
        expect(referenceText(confirm, naming('name'))).toEqual({ text: 'confirm', resolved: true, path: 'Order.confirm' });
        expect(referenceText(draft, naming('both'))).toMatchObject({ text: '下書き (Draft)', resolved: true });
    });
});
