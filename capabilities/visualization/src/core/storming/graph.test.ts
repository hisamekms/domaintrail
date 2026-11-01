import { afterAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { analyze, type Storming } from '@domaintrail/modeling';
import type { ViewOptions } from './ir.js';
import { matchRenderNodes, projectView } from './render.js';
import { renderToGraph, stormingGraphId, stormingViewKey } from './graph.js';
import type { LaidOutGraph, NodeLayout } from '../graph/ir.js';
import { ElkLayoutEngine } from '../../adapters/elk.js';

const SAMPLE = await readFile(path.join(import.meta.dir, '..', '..', '..', '..', '..', 'test', 'fixtures', 'dtes', 'delivery-cancellation.dtes'), 'utf8');

async function parse(text: string): Promise<Storming> {
    const { stormings, diagnostics } = (await analyze([{ path: 'es.dtes', text }])).stormings;
    // without a .dt model its refs name nothing (S010–S013); the storming itself parses and validates clean
    expect(diagnostics.filter((d) => !['S010', 'S011', 'S012', 'S013'].includes(d.code))).toEqual([]);
    return stormings[0];
}

const graphOf = (storming: Storming, options: ViewOptions) => renderToGraph(projectView(storming, options), storming);

const engine = new ElkLayoutEngine();
afterAll(() => engine.dispose());

describe('an Event Storming view as a graph', () => {
    test('keeps the render graph of a timeline: its node IDs, a group as the container of its events, and §9.4 edge kinds', async () => {
        const storming = await parse(SAMPLE);
        const options: ViewOptions = { level: 'design-level', timelineId: 'Normal' };
        const graph = graphOf(storming, options);
        expect(graph.id).toBe('storming:DeliveryCancellation:design-level:Normal');
        expect(graph.nodes.map((n) => n.id)).toEqual(projectView(storming, options).nodes.map((n) => n.id));
        const node = (id: string) => graph.nodes.find((n) => n.id === id)!;
        const group = 't:e:ShipmentCancelled>g:BikeReleased,SlotReleased';
        expect(node(group)).toMatchObject({ kind: 'esGroup', elementId: 'es/DeliveryCancellation/CleanupResults' });
        expect(node(group).label.ja.both).toBe('後処理 (CleanupResults)');
        expect(node(`${group}/BikeReleased`)).toMatchObject({ kind: 'esEvent', parent: group, elementId: 'es/DeliveryCancellation/BikeReleased' });
        expect(node('n:ReleaseSlot')).toMatchObject({ kind: 'esCommand', elementId: 'es/DeliveryCancellation/ReleaseSlot' });

        const kinds = Object.fromEntries(graph.edges.map((e) => [e.id, e.kind]));
        expect(kinds['on:ShipmentCancelled->CleanupAfterCancel@t:e:ShipmentCancelled->n:CleanupAfterCancel']).toBe('esCausal');
        expect(kinds[`emits:ReleaseSlot->SlotReleased@n:ReleaseSlot->${group}/SlotReleased`]).toBe('esCausal');
        expect(kinds[`s:t:e:ShipmentCancelled->${group}`]).toBe('esSequence');
        // nothing is added: one graph edge per render edge, and no sequence edge inside the group (R04)
        expect(graph.edges).toHaveLength(projectView(storming, options).edges.length);
        expect(graph.edges.filter((e) => e.kind === 'esSequence' && e.source.startsWith(`${group}/`))).toEqual([]);
    });

    test('draws each event once in the integrated view, without groups, naming the timelines of a partial time order', async () => {
        const storming = await parse(SAMPLE);
        const graph = graphOf(storming, { level: 'design-level' });
        expect(graph.id).toBe('storming:DeliveryCancellation:design-level:*');
        const node = (id: string) => graph.nodes.find((n) => n.id === id)!;
        expect(graph.nodes.filter((n) => n.kind === 'esGroup')).toEqual([]);
        expect(
            graph.nodes
                .filter((n) => n.kind === 'esEvent')
                .map((n) => n.id)
                .sort(),
        ).toEqual(['e:BikeReleased', 'e:ReleaseFailed', 'e:ShipmentCancelled', 'e:SlotReleased'].sort());
        expect(node('e:BikeReleased')).toMatchObject({ elementId: 'es/DeliveryCancellation/BikeReleased' });
        expect(node('e:BikeReleased').parent).toBeUndefined();
        expect(node('n:PaymentGateway')).toMatchObject({ kind: 'esExternal', elementId: 'es/DeliveryCancellation/PaymentGateway' });
        expect(node('n:CancelShipment').label.en).toEqual({ label: '配送キャンセル', name: 'CancelShipment', both: '配送キャンセル (CancelShipment)' });
        expect(node('n:Compensation').stereotype).toEqual({
            ja: { label: '«ホットスポット»', name: '«ホットスポット»', both: '«ホットスポット»' },
            en: { label: '«hotspot»', name: '«hotspot»', both: '«hotspot»' },
        });

        const edge = (id: string) => graph.edges.find((e) => e.id === id);
        expect(edge('on:ShipmentCancelled->CleanupAfterCancel@e:ShipmentCancelled->n:CleanupAfterCancel')?.kind).toBe('esCausal');
        expect(edge('issues:CleanupAfterCancel->ReleaseBike@n:CleanupAfterCancel->n:ReleaseBike')?.kind).toBe('esCausal');
        expect(edge('target:ReleaseSlot->ShipmentSlot@n:ReleaseSlot->n:ShipmentSlot')?.kind).toBe('esRelated');
        expect(edge('actor:Customer->CancelShipment@n:Customer->n:CancelShipment')?.kind).toBe('esRelated');
        expect(edge('hotspot-on:Compensation->ReleaseFailed@n:Compensation->e:ReleaseFailed')?.kind).toBe('esHotspot');
        // a step into a group is a time order to each of its events; each names the one timeline it is in
        for (const target of ['e:BikeReleased', 'e:SlotReleased']) {
            expect(edge(`s:e:ShipmentCancelled->${target}`)).toMatchObject({ kind: 'esSequence', label: { ja: { label: '通常キャンセル' } } });
        }
        expect(edge('s:e:ShipmentCancelled->e:ReleaseFailed')?.label?.ja.both).toBe('車両解放失敗 (Failure)');
    });

    test('leaves unnamed a time order every timeline has, and draws a repeated event as a loop on its note', async () => {
        const storming = await parse(`storming S { event A event B event C
  timeline T1 { A B B C }
  timeline T2 { A B C }
}`);
        const edges = Object.fromEntries(graphOf(storming, { level: 'big-picture' }).edges.map((e) => [e.id, e]));
        expect(Object.keys(edges).sort()).toEqual(['s:e:A->e:B', 's:e:B->e:B', 's:e:B->e:C']);
        expect(edges['s:e:A->e:B'].label).toBeUndefined();
        expect(edges['s:e:B->e:C'].label).toBeUndefined();
        expect(edges['s:e:B->e:B'].label?.ja.name).toBe('T1');
    });

    test('has one graph ID per storming, level and timeline', () => {
        expect(stormingGraphId('S', { level: 'big-picture' })).toBe('storming:S:big-picture:*');
        expect(stormingGraphId('S', { level: 'design-level', timelineId: 'Normal' })).toBe('storming:S:design-level:Normal');
        expect(stormingViewKey({ level: 'big-picture' })).toBe('big-picture|');
        expect(stormingViewKey({ level: 'design-level', timelineId: 'Normal' })).toBe('design-level|Normal');
    });

    test('names the kinds in Japanese in Japanese diagrams', async () => {
        const storming = await parse(SAMPLE);
        const words = graphOf(storming, { level: 'design-level' }).nodes.flatMap((n) => (n.stereotype ? [n.stereotype.ja.name] : []));
        expect(words.length).toBeGreaterThan(0);
        expect(words.filter((w) => /[A-Za-z]/.test(w))).toEqual([]);
    });
});

const right = (l: NodeLayout) => l.x + l.width;
const overlap = (a: NodeLayout, b: NodeLayout) => a.x < right(b) && b.x < right(a) && a.y < b.y + b.height && b.y < a.y + a.height;

function expectReadable(laid: LaidOutGraph): void {
    // left to right along every timeline (§10.1, §10.2 first priority)
    for (const e of laid.edges.filter((e) => e.kind === 'esSequence')) expect(right(laid.nodeLayout[e.source])).toBeLessThan(laid.nodeLayout[e.target].x);
    // no overlaps, but for a group and its events (§10.2)
    const outside = laid.nodes.filter((n) => !n.parent);
    for (const [i, a] of outside.entries()) for (const b of outside.slice(i + 1)) expect(overlap(laid.nodeLayout[a.id], laid.nodeLayout[b.id])).toBe(false);
    for (const g of laid.nodes.filter((n) => n.kind === 'esGroup')) {
        const members = laid.nodes.filter((n) => n.parent === g.id);
        for (const [i, a] of members.entries()) for (const b of members.slice(i + 1)) expect(overlap(laid.nodeLayout[a.id], laid.nodeLayout[b.id])).toBe(false);
    }
}

describe('layout of an Event Storming view', () => {
    test('runs left to right in timeline order without overlaps, in every view of the sample', async () => {
        const storming = await parse(SAMPLE);
        for (const level of ['big-picture', 'design-level'] as const) {
            for (const timelineId of [undefined, 'Normal', 'Failure']) {
                const laid = await engine.layout(graphOf(storming, timelineId ? { level, timelineId } : { level }));
                expectReadable(laid);
            }
        }
    });

    test('keeps timeline order against a causal cycle back to an earlier event (§10.2)', async () => {
        const storming = await parse(`storming S {
  event Ordered event Paid event Retried
  policy Again { on Paid issues Order }
  command Order { emits Ordered }
  timeline T { Ordered Paid Retried }
}`);
        expectReadable(await engine.layout(graphOf(storming, { level: 'design-level' })));
    });

    test('is canonical: the same layout for the same storming and view, whatever the declaration order (§10.1)', async () => {
        const a = await parse(SAMPLE);
        const swapped = SAMPLE.replace(/(\n {2}timeline Normal[\s\S]*?\n {2}\}\n)(\n {2}timeline Failure[\s\S]*?\n {2}\}\n)/, '$2$1');
        expect(swapped).not.toBe(SAMPLE);
        const b = await parse(swapped);
        for (const options of [{ level: 'design-level' }, { level: 'big-picture', timelineId: 'Failure' }] satisfies ViewOptions[]) {
            const first = await engine.layout(graphOf(a, options));
            const again = await engine.layout(graphOf(a, options));
            const reordered = await engine.layout(graphOf(b, options));
            expect(again.nodeLayout).toEqual(first.nodeLayout);
            expect(again.edgeLayout).toEqual(first.edgeLayout);
            expect(reordered.nodeLayout).toEqual(first.nodeLayout);
        }
    });

    test('incrementally keeps the order of paired nodes within their layers, and timeline order (§10.2, §10.3)', async () => {
        const before = await parse(`storming S { event A event B event C event X event Y event Z
  timeline T1 { A B C }
}`);
        // inserting Z before A renames the timeline's nodes (t:e:Z>e:A …), which matchRenderNodes pairs with the old ones
        const after = await parse(`storming S { event A event B event C event X event Y event Z
  timeline T1 { Z A B C }
}`);
        const options: ViewOptions = { level: 'big-picture', timelineId: 'T1' };
        const [previous, next] = [projectView(before, options), projectView(after, options)];
        const old = await engine.layout(renderToGraph(previous, before));
        const positions = Object.fromEntries([...matchRenderNodes(previous, next)].map(([n, p]) => [n, old.nodeLayout[p]]));
        expect(Object.keys(positions)).toContain('t:e:Z>e:A');
        expect(positions['t:e:Z>e:A']).toEqual(old.nodeLayout['t:e:A']);
        expectReadable(await engine.layout(renderToGraph(next, after), { positions }));
    });
});
