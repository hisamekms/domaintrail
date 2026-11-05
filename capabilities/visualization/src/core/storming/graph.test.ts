import { afterAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { STICKY_NOTE, type Storming } from '@domaintrail/storming';
import { analyze } from '@domaintrail/analysis';
import type { ViewOptions } from './ir.js';
import { matchRenderNodes, projectView } from './render.js';
import { renderToGraph, stormingGraphId, stormingViewKey } from './graph.js';
import { graphSignature, type LaidOutGraph, type NodeLayout } from '../graph/ir.js';
import { ElkLayoutEngine } from '../../adapters/elk.js';

const SAMPLE = await readFile(path.join(import.meta.dir, '..', '..', '..', '..', '..', 'test', 'fixtures', 'dtes', 'delivery-cancellation.dtes'), 'utf8');

async function parse(text: string): Promise<Storming> {
    const { stormings, diagnostics } = (await analyze([{ path: 'es.dtes', text }])).stormings;
    // without a .dt model its refs name nothing (S010–S013); the storming itself parses and validates clean, but for an
    // incomplete design (S024, S027), which is drawn as written
    expect(diagnostics.filter((d) => !['S010', 'S011', 'S012', 'S013', 'S024', 'S027'].includes(d.code))).toEqual([]);
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
        // command → aggregate → event: the aggregate decides and emits the command's events
        expect(kinds['handledBy:ReleaseSlot->ShipmentSlot@n:ReleaseSlot->n:ShipmentSlot@ReleaseSlot']).toBe('esCausal');
        expect(kinds[`emits:ReleaseSlot->SlotReleased@n:ShipmentSlot@ReleaseSlot->${group}/SlotReleased`]).toBe('esCausal');
        expect(Object.keys(kinds).filter((id) => id.startsWith('emits:ReleaseSlot->') && id.includes('@n:ReleaseSlot->'))).toEqual([]);
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
        expect(node('n:PaymentGateway@ReceivePaymentNotice')).toMatchObject({ kind: 'esExternal', elementId: 'es/DeliveryCancellation/PaymentGateway' });
        expect(node('n:CancelShipment').label.en).toEqual({ label: '配送キャンセル', name: 'CancelShipment', both: '配送キャンセル (CancelShipment)' });
        expect(node('n:Compensation').stereotype).toEqual({
            ja: { label: '«ホットスポット»', name: '«ホットスポット»', both: '«ホットスポット»' },
            en: { label: '«hotspot»', name: '«hotspot»', both: '«hotspot»' },
        });

        const edge = (id: string) => graph.edges.find((e) => e.id === id);
        expect(edge('on:ShipmentCancelled->CleanupAfterCancel@e:ShipmentCancelled->n:CleanupAfterCancel')?.kind).toBe('esCausal');
        expect(edge('issues:CleanupAfterCancel->ReleaseBike@n:CleanupAfterCancel->n:ReleaseBike')?.kind).toBe('esCausal');
        expect(edge('handledBy:ReleaseSlot->ShipmentSlot@n:ReleaseSlot->n:ShipmentSlot@ReleaseSlot')?.kind).toBe('esCausal');
        expect(edge('by:Customer->CancelShipment@n:Customer@CancelShipment->n:CancelShipment')?.kind).toBe('esRelated');
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

    test('carries a resolved hotspot’s status and resolution on its note, in every view; an open one carries neither', async () => {
        const storming = await parse(`storming S {
  event Placed "注文された"
  hotspot Open "誰が確定する？" {
    on Placed
  }
  hotspot Settled "通貨は混在する？" {
    on Placed
    status resolved
    resolution "一つの注文は一つの通貨"
  }
  timeline T {
    Placed
  }
}`);
        const views: ViewOptions[] = [{ level: 'design-level' }, { level: 'big-picture' }, { level: 'design-level', timelineId: 'T' }];
        for (const options of views) {
            const graph = graphOf(storming, options);
            const note = (id: string) => graph.nodes.find((n) => n.elementId === `es/S/${id}`)!;
            expect(note('Settled')).toMatchObject({ kind: 'esHotspot', status: 'resolved', resolution: '一つの注文は一つの通貨' });
            expect(note('Open').status).toBeUndefined();
            expect(note('Open').resolution).toBeUndefined();
            expect(note('Placed').status).toBeUndefined();
        }
        // resolving a hotspot changes the graph's signature (the page keeps compact layouts by it), not its size
        const open = graphOf(await parse(`storming S {\n  event Placed\n  hotspot H {\n    on Placed\n  }\n}`), { level: 'design-level' });
        const settled = graphOf(
            await parse(`storming S {\n  event Placed\n  hotspot H {\n    on Placed\n    status resolved\n    resolution "決めた"\n  }\n}`),
            {
                level: 'design-level',
            },
        );
        expect(graphSignature(settled)).not.toBe(graphSignature(open));
    });

    test('draws every note as the same square, however long its label (the canvas fits the label to it)', async () => {
        const long = 'マイナンバーカードの暗証番号を三回間違えてロックされたので市役所の窓口で再設定の手続きをした';
        const storming = await parse(`storming S {
  event Short "届いた"
  event Long "${long}"
  command Unlabelled {
    emits Long
  }
  hotspot Question "${long}？" {
    on Long
  }
  timeline T {
    Short
    group G {
      Long
    }
  }
}`);
        for (const options of [{ level: 'design-level' }, { level: 'design-level', timelineId: 'T' }] satisfies ViewOptions[]) {
            const graph = graphOf(storming, options);
            const notes = graph.nodes.filter((n) => n.kind !== 'esGroup');
            expect(notes.length).toBeGreaterThanOrEqual(3);
            for (const n of notes) expect([n.width, n.height]).toEqual([STICKY_NOTE.side, STICKY_NOTE.side]);
            expect(notes.find((n) => n.elementId === 'es/S/Long')?.label.ja.label).toBe(long);
            expectReadable(await engine.layout(graph));
        }
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

    test('draws the grammar left to right: read model → actor → command → aggregate → event; short edges', async () => {
        const storming = await parse(`storming S {
  event Opened event Approved event Shipped event Closed
  actor Clerk
  readmodel Board
  aggregate Ticket
  command Open { by Clerk reads Board handledBy Ticket emits Opened }
  command Approve { emits Approved }
  command Ship { emits Shipped }
  command Close { reads Board handledBy Ticket emits Closed }
  command Note { by Clerk handledBy Ticket emits Approved }
  policy P1 { on Opened issues Approve }
  policy P2 { on Approved issues Ship }
  policy P3 { on Shipped issues Close }
  timeline T { Opened Approved Shipped Closed }
}`);
        for (const options of [{ level: 'design-level' }, { level: 'design-level', timelineId: 'T' }] satisfies ViewOptions[]) {
            const laid = await engine.layout(graphOf(storming, options));
            expectReadable(laid);
            const box = (id: string): NodeLayout => laid.nodeLayout[id]!;
            const centre = (id: string): number => box(id).x + box(id).width / 2;
            const eventOf = (event: string): string => laid.nodes.find((n) => n.kind === 'esEvent' && n.elementId.endsWith(`/${event}`))!.id;
            // Open: the read model is what its actor looks at, so it reads read model → actor → command → aggregate → event
            expect(centre('n:Board@Open')).toBeLessThan(centre('n:Clerk@Open'));
            expect(centre('n:Clerk@Open')).toBeLessThan(centre('n:Open'));
            expect(centre('n:Ticket@Open')).toBeGreaterThan(centre('n:Open'));
            expect(centre('n:Ticket@Open')).toBeLessThan(centre(eventOf('Opened')));
            // Close, which a policy issues: the read model goes to the command itself
            expect(centre('n:Board@Close')).toBeLessThan(centre('n:Close'));
            expect(centre('n:Ticket@Close')).toBeLessThan(centre(eventOf('Closed')));
            // Note: an actor that nothing leads to is stuck on top of its command
            if (options.timelineId === undefined) {
                expect(laid.nodes.find((n) => n.id === 'n:Clerk@Note')?.attachTo).toBe('n:Note');
                expect(box('n:Clerk@Note').x).toBe(box('n:Note').x);
                expect(box('n:Clerk@Note').y + box('n:Clerk@Note').height).toBeLessThan(box('n:Note').y);
            }
            // each copy's edges are short: no longer than a few notes, though the two commands lie far apart
            for (const [command, copies] of [
                ['Open', ['Clerk', 'Board', 'Ticket']],
                ['Close', ['Board', 'Ticket']],
            ] as const) {
                for (const copy of copies) {
                    for (const edge of laid.edges.filter((e) => [e.source, e.target].includes(`n:${copy}@${command}`))) {
                        const points = laid.edgeLayout[edge.id]!.points;
                        const length = points.slice(1).reduce((sum, p, i) => sum + Math.abs(p.x - points[i]!.x) + Math.abs(p.y - points[i]!.y), 0);
                        expect(length).toBeLessThan(3 * STICKY_NOTE.side);
                    }
                }
            }
            if (options.timelineId === undefined) expect(centre('n:Close') - centre('n:Open')).toBeGreaterThan(6 * STICKY_NOTE.side);
        }
    });

    test('sticks a hotspot on its event: above it, not a step of the flow', async () => {
        const storming = await parse(`storming S {
  event A event B
  hotspot H1 { on B }
  hotspot H2 { on B }
  timeline T { A B }
}`);
        for (const options of [{ level: 'big-picture' }, { level: 'big-picture', timelineId: 'T' }] satisfies ViewOptions[]) {
            const laid = await engine.layout(graphOf(storming, options));
            expectReadable(laid);
            const id = (name: string): string => laid.nodes.find((n) => n.elementId.endsWith(`/${name}`))!.id;
            const box = (name: string): NodeLayout => laid.nodeLayout[id(name)]!;
            for (const h of ['H1', 'H2']) {
                expect(box(h).x).toBe(box('B').x);
                expect(box(h).y + box(h).height).toBeLessThan(box('B').y);
            }
            // B is the step right after A: no layer of hotspots between them
            expect(box('B').x - (box('A').x + box('A').width)).toBeLessThan(STICKY_NOTE.side);
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
