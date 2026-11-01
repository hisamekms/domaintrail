import { describe, expect, test } from 'bun:test';
import { analyzeDomain } from '../../application/analyze.js';
import { RuleSink } from '../../domain/diagnostics.js';
import { exampleSources } from '../../test-helpers.js';
import { DiagnosticSink } from './diagnostic-sink.js';

describe('the rule sink', () => {
    test('reports at a site of the model as written what the diagnostic sink reports on the AST node, field for field', async () => {
        const a = await analyzeDomain(await exampleSources());
        const items = a.index.elements.length;
        const sink = new DiagnosticSink(a.resolveFile);
        const rules = new RuleSink();
        a.index.elements.forEach((el, i) => {
            sink.error('M002', `name ${i}`, el, 'name', undefined, 'a hint');
            sink.warning('L003', `label ${i}`, el, 'label');
        });
        a.sourceModel!.elements.forEach((el, i) => {
            rules.error('M002', `name ${i}`, el.nameAt, 'a hint');
            rules.warning('L003', `label ${i}`, el.labelAt);
        });
        expect(rules.items.length).toBe(2 * items);
        // the same text, so `dt check`'s JSON and the Live View payloads do not change when a rule moves
        expect(JSON.stringify(rules.items)).toBe(JSON.stringify(sink.items));
    });

    test('shares a list with the diagnostic sink, keeping the order in which they report', async () => {
        const a = await analyzeDomain(await exampleSources());
        const sink = new DiagnosticSink(a.resolveFile);
        const rules = new RuleSink(sink.items);
        sink.error('M002', 'first', a.index.elements[0], 'name');
        rules.error('M002', 'second', a.sourceModel!.elements[1].nameAt);
        expect(sink.items.map((d) => d.message)).toEqual(['first', 'second']);
    });
});
