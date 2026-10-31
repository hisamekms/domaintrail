import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Storming, ViewOptions } from '../src/dtes/ir.js';
import { parseStormings } from '../src/dtes/parse.js';
import { matchRenderNodes, projectView } from '../src/dtes/project/render.js';
import { renderToGraph, stormingGraphId, stormingViewKey } from '../src/dtes/view/graph.js';
import type { LaidOutGraph, NodeLayout } from '../src/graph/ir.js';
import { ElkLayoutEngine } from '../src/layout/elk.js';
import type { ViewPayload } from '../src/server/protocol.js';
import { startViewServer, type ViewServer } from '../src/server/server.js';
import { ViewSession } from '../src/server/session.js';
import { I18nProvider } from '../web/i18n.js';
import { StormingDetails } from '../web/storming.js';

const SAMPLE = await readFile(path.join(import.meta.dir, 'fixtures', 'dtes', 'delivery-cancellation.dtes'), 'utf8');

async function parse(text: string): Promise<Storming> {
    const { stormings, diagnostics } = await parseStormings([{ path: 'es.dtes', text }]);
    expect(diagnostics).toEqual([]);
    return stormings[0];
}

const graphOf = (storming: Storming, options: ViewOptions) => renderToGraph(projectView(storming, options), storming);

const engine = new ElkLayoutEngine();
afterAll(() => engine.dispose());

describe('an Event Storming view as a graph', () => {
    test('keeps the render graph: its node IDs, a group as the container of its events, and §9.4 edge kinds', async () => {
        const storming = await parse(SAMPLE);
        const graph = graphOf(storming, { level: 'design-level' });
        expect(graph.id).toBe('storming:DeliveryCancellation:design-level:*');
        expect(graph.nodes.map((n) => n.id)).toEqual(projectView(storming, { level: 'design-level' }).nodes.map((n) => n.id));
        const node = (id: string) => graph.nodes.find((n) => n.id === id)!;
        const group = 't:e:ShipmentCancelled>g:BikeReleased,SlotReleased';
        expect(node(group)).toMatchObject({ kind: 'esGroup', elementId: 'es/DeliveryCancellation/CleanupResults' });
        expect(node(group).label.ja.both).toBe('後処理 (CleanupResults)');
        expect(node(`${group}/BikeReleased`)).toMatchObject({ kind: 'esEvent', parent: group, elementId: 'es/DeliveryCancellation/BikeReleased' });
        expect(node('n:PaymentGateway')).toMatchObject({ kind: 'esExternal', elementId: 'es/DeliveryCancellation/PaymentGateway' });
        expect(node('n:CancelShipment').label.en).toEqual({ label: '配送キャンセル', name: 'CancelShipment', both: '配送キャンセル (CancelShipment)' });
        expect(node('n:Compensation').stereotype).toEqual({
            ja: { label: '«ホットスポット»', name: '«ホットスポット»', both: '«ホットスポット»' },
            en: { label: '«hotspot»', name: '«hotspot»', both: '«hotspot»' },
        });

        const kinds = Object.fromEntries(graph.edges.map((e) => [e.id, e.kind]));
        expect(kinds['on:ShipmentCancelled->CleanupAfterCancel@t:e:ShipmentCancelled->n:CleanupAfterCancel']).toBe('esCausal');
        expect(kinds['issues:CleanupAfterCancel->ReleaseBike@n:CleanupAfterCancel->n:ReleaseBike']).toBe('esCausal');
        expect(kinds[`emits:ReleaseSlot->SlotReleased@n:ReleaseSlot->${group}/SlotReleased`]).toBe('esCausal');
        expect(kinds['target:ReleaseSlot->ShipmentSlot@n:ReleaseSlot->n:ShipmentSlot']).toBe('esRelated');
        expect(kinds['actor:Customer->CancelShipment@n:Customer->n:CancelShipment']).toBe('esRelated');
        expect(kinds['hotspot-on:Compensation->ReleaseFailed@n:Compensation->t:e:ShipmentCancelled>e:ReleaseFailed']).toBe('esRelated');
        expect(kinds[`s:t:e:ShipmentCancelled->${group}`]).toBe('esSequence');
        // nothing is added: one graph edge per render edge, and no sequence edge inside the group (R04)
        expect(graph.edges).toHaveLength(projectView(storming, { level: 'design-level' }).edges.length);
        expect(graph.edges.filter((e) => e.kind === 'esSequence' && e.source.startsWith(`${group}/`))).toEqual([]);
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
  timeline T2 { X Y }
}`);
        // inserting Z before A renames T1's nodes (t:e:Z>e:A …), which canonical layout would sort after T2's
        const after = await parse(`storming S { event A event B event C event X event Y event Z
  timeline T1 { Z A B C }
  timeline T2 { X Y }
}`);
        const options: ViewOptions = { level: 'big-picture' };
        const [previous, next] = [projectView(before, options), projectView(after, options)];
        const old = await engine.layout(renderToGraph(previous, before));
        const positions = Object.fromEntries([...matchRenderNodes(previous, next)].map(([n, p]) => [n, old.nodeLayout[p]]));
        expect(Object.keys(positions)).toContain('t:e:Z>e:A');
        const canonical = await engine.layout(renderToGraph(next, after));
        const incremental = await engine.layout(renderToGraph(next, after), { positions });
        const above = (l: LaidOutGraph) => l.nodeLayout['t:e:Z>e:A'].y < l.nodeLayout['t:e:X>e:Y'].y;
        expect(old.nodeLayout['t:e:A>e:B'].y).toBeLessThan(old.nodeLayout['t:e:X>e:Y'].y);
        expect(above(canonical)).toBe(false);
        expect(above(incremental)).toBe(true);
        expectReadable(incremental);
    });
});

describe('the Live View of a workspace with stormings', () => {
    let dir: string;
    const file = () => path.join(dir, 'delivery.dtes');
    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-dtes-'));
        await writeFile(file(), SAMPLE);
    });
    afterAll(() => rm(dir, { recursive: true, force: true }));

    test('pushes every view of every storming; switching level or timeline is the page’s and never touches the .dtes (R11, R12)', async () => {
        const before = await stat(file());
        const session = new ViewSession(dir, engine);
        const state = await session.refresh();
        expect(state.status).not.toBe('empty');
        expect(state.files).toEqual(['delivery.dtes']);
        const [view] = state.stormings;
        expect(view).toMatchObject({ id: 'DeliveryCancellation', label: '配送キャンセル', file: 'delivery.dtes', stale: false });
        expect(view.timelines).toEqual([
            { id: 'Normal', label: '通常キャンセル' },
            { id: 'Failure', label: '車両解放失敗' },
        ]);
        expect(Object.keys(view.views).sort()).toEqual([
            'big-picture|',
            'big-picture|Failure',
            'big-picture|Normal',
            'design-level|',
            'design-level|Failure',
            'design-level|Normal',
        ]);
        for (const [key, { render, graph }] of Object.entries(view.views)) {
            expect(stormingViewKey(render.options)).toBe(key);
            expect(graph.id).toBe(stormingGraphId(view.id, render.options));
            expect(Object.keys(graph.nodeLayout).sort()).toEqual(graph.nodes.map((n) => n.id).sort());
        }
        await session.refresh();
        const after = await stat(file());
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(await readFile(file(), 'utf8')).toBe(SAMPLE);
    });

    test('shows external systems at the Design Level only, and every event at both levels (R14, R17)', async () => {
        const [view] = (await new ViewSession(dir, engine).refresh()).stormings;
        const ids = (key: string) => view.views[key].graph.nodes.map((n) => n.id);
        expect(ids('design-level|')).toContain('n:PaymentGateway');
        expect(ids('big-picture|')).not.toContain('n:PaymentGateway');
        const events = (key: string) => view.views[key].graph.nodes.filter((n) => n.kind === 'esEvent').map((n) => n.id);
        expect(events('big-picture|')).toEqual(events('design-level|'));
        expect(ids('big-picture|Failure')).toEqual(['n:Compensation', 't:e:ShipmentCancelled', 't:e:ShipmentCancelled>e:ReleaseFailed']);
    });

    test('keeps a storming whose file stops parsing, as stale, and lays out an edit incrementally', async () => {
        const session = new ViewSession(dir, engine);
        await session.refresh();
        await writeFile(file(), SAMPLE.replace('timeline Failure', 'timeline Failure {'));
        const broken = await session.refresh();
        expect(broken.stormings.map((s) => [s.id, s.stale])).toEqual([['DeliveryCancellation', true]]);
        expect(broken.diagnostics.some((d) => d.file === 'delivery.dtes' && d.code === 'SYNTAX')).toBe(true);
        await writeFile(file(), SAMPLE.replace('event SlotReleased', 'event Refunded "返金された"\n  event SlotReleased'));
        const fixed = await session.refresh();
        expect(fixed.stormings[0].stale).toBe(false);
        expect(fixed.stormings[0].views['big-picture|'].graph.nodes.map((n) => n.id)).toContain('e:Refunded');
        await writeFile(file(), SAMPLE);
    });

    test('reloads on .dtes edits like on .dt edits', async () => {
        const server: ViewServer = await startViewServer({ root: dir, port: 0, debounceMs: 30, engine: new ElkLayoutEngine() });
        const received: ViewPayload[] = [];
        const ws = new WebSocket(server.url.replace('http', 'ws') + 'ws');
        try {
            ws.onmessage = (ev) => received.push(JSON.parse(ev.data as string));
            await new Promise((r) => (ws.onopen = r));
            await server.ready;
            while (received.length === 0) await Bun.sleep(10);
            await writeFile(file(), SAMPLE.replace('event SlotReleased', 'event Rescheduled\n  event SlotReleased'));
            const deadline = Date.now() + 8000;
            const has = (p: ViewPayload) => p.stormings[0]?.views['big-picture|'].graph.nodes.some((n) => n.id === 'e:Rescheduled');
            while (!received.some(has) && Date.now() < deadline) await Bun.sleep(20);
            expect(received.some(has)).toBe(true);
        } finally {
            ws.close();
            await server.stop();
            await writeFile(file(), SAMPLE);
        }
    });
});

describe('the inspector of a storming element', () => {
    test('shows the .dt ref, the relations, and the timelines a shared note stands for (§6, §8.4)', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-dtes-'));
        try {
            await writeFile(path.join(dir, 'delivery.dtes'), SAMPLE);
            const { stormings, diagnostics } = await new ViewSession(dir, engine).refresh();
            const html = (id: string, key = 'design-level|') =>
                renderToStaticMarkup(
                    <I18nProvider lang="en">
                        <StormingDetails
                            stormings={stormings}
                            selected={`es/DeliveryCancellation/${id}`}
                            render={stormings[0].views[key].render}
                            model={null}
                            mode="name"
                            diagnostics={diagnostics}
                            history={null}
                            onSelect={() => {}}
                        />
                    </I18nProvider>,
                );
            const event = html('ShipmentCancelled');
            expect(event).toContain('Delivery.ShipmentCancelled');
            expect(event).toContain('Normal · step 1');
            expect(event).toContain('Failure · step 1');
            expect(event).toContain('Notes in this view (1)');
            expect(event).toContain('Failure · step 1 / Normal · step 1');
            expect(event).toContain('they are not necessarily the same happening');
            // in the Failure timeline, the note stands for that timeline's occurrence only
            const filtered = html('ShipmentCancelled', 'big-picture|Failure');
            expect(filtered).toContain(
                '<li>Failure · step 1</li></ul></section><section><h3>Notes in this view (1)</h3><ul class="es-list"><li>Failure · step 1</li>',
            );
            expect(filtered).not.toContain('they are not necessarily the same happening');
            expect(html('BikeReleased')).toContain('Normal · step 2 · group CleanupResults');
            const policy = html('CleanupAfterCancel');
            expect(policy).toContain('ShipmentCancelled</a> → <a>CleanupAfterCancel');
            expect(policy).not.toContain('In .dt');
            expect(html('Compensation')).toContain('<div>open</div>');
            expect(html('Nope')).toContain('Nope is not in the storming');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
