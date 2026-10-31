import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { startViewServer, type ViewServer } from '../src/server/server.js';
import type { ViewPayload } from '../src/visualization/protocol.js';
import { tempCopyOfExamples } from './helpers.js';

let dir: string;
let server: ViewServer;
let ws: WebSocket;
const received: ViewPayload[] = [];

/** Waits for the next pushed update that satisfies `pred`. */
async function nextUpdate(pred: (p: ViewPayload) => boolean = () => true, timeoutMs = 8000): Promise<ViewPayload> {
    const start = received.length;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const hit = received.slice(start).find(pred);
        if (hit) return hit;
        await Bun.sleep(20);
    }
    throw new Error('timed out waiting for an update');
}

beforeAll(async () => {
    dir = await tempCopyOfExamples();
    server = await startViewServer({ root: dir, port: 0, debounceMs: 30 });
    await server.ready;
    ws = new WebSocket(server.url.replace('http', 'ws') + 'ws');
    ws.onmessage = (ev) => received.push(JSON.parse(ev.data as string));
    await new Promise((r) => (ws.onopen = r));
    while (received.length === 0) await Bun.sleep(10);
});

afterAll(async () => {
    ws?.close();
    await server?.stop();
    await rm(dir, { recursive: true, force: true });
});

const order = () => path.join(dir, 'sales', 'order.dt');

describe('Live View', () => {
    test('serves the page and the current state', async () => {
        const html = await (await fetch(server.url)).text();
        expect(html).toContain('<div id="root"></div>');
        const state = (await (await fetch(`${server.url}api/state`)).json()) as ViewPayload;
        expect(state.status).toBe('ok');
        expect(state.files).toEqual([
            'billing/context.dt',
            'billing/invoice.dt',
            'common/context.dt',
            'sales/context.dt',
            'sales/customer.dt',
            'sales/order.dt',
            'stormings/order-to-cash.dtes',
            'stormings/returns.dtes',
        ]);
        expect(state.structure?.nodes.length).toBeGreaterThan(0);
        expect(state.aggregates?.nodes.filter((n) => n.kind === 'aggregate').map((n) => n.id)).toEqual(['Billing.Invoice', 'Sales.Customer', 'Sales.Order']);
        expect(Object.keys(state.states).sort()).toEqual(['Billing.Invoice', 'Sales.Customer', 'Sales.Order']);
        // laid out for each way of labeling transitions
        expect(Object.values(state.states['Sales.Order']).map((g) => g.id)).toEqual([
            'states:Sales.Order:command',
            'states:Sales.Order:event',
            'states:Sales.Order',
        ]);
        expect(state.sources.map((x) => x.path)).toEqual(state.files);
        const order = state.model!.elements['Sales.Order'].location;
        const lines = state.sources.find((x) => x.path === order.file)!.text.split('\n');
        expect(lines[order.line - 1]).toContain('aggregate Order');
        expect(lines[order.endLine - 1].trim()).toBe('}');
    });

    test('serves the Context Map and focused Structure Views on request', async () => {
        const state = (await (await fetch(`${server.url}api/state`)).json()) as ViewPayload;
        expect(state.focusContexts).toEqual(['Billing', 'Sales']);
        expect(state.contextMap?.edges.map((e) => e.id)).toEqual(['Billing|Sales']);
        const focus = await fetch(`${server.url}api/focus?contexts=Billing,Unknown&overview=1`);
        expect(focus.status).toBe(200);
        const graph = (await focus.json()) as { id: string; nodeLayout: Record<string, unknown> };
        expect(graph.id).toBe('structure-focus:Billing:overview');
        expect(Object.keys(graph.nodeLayout)).toContain('Billing.Invoice');
        const aggregates = (await (await fetch(`${server.url}api/focus?contexts=Billing&level=aggregates`)).json()) as {
            id: string;
            nodeLayout: Record<string, unknown>;
        };
        expect(aggregates.id).toBe('structure-focus:Billing:aggregates');
        expect(Object.keys(aggregates.nodeLayout).sort()).toEqual(['Billing', 'Billing.Invoice', 'Sales', 'Sales.Order']);
        const hidden = (await (await fetch(`${server.url}api/focus?contexts=Billing&hide=Sales,Billing,Unknown`)).json()) as { id: string };
        expect(hidden.id).toBe('structure-focus:Billing:hide=Sales');
        expect((await fetch(`${server.url}api/focus?contexts=Common`)).status).toBe(404);
        const rebound = await fetch(`${server.url}api/focus?contexts=Billing`, { headers: { Host: 'attacker.example' } });
        expect(rebound.status).toBe(403);
    });

    test('rejects cross-origin WebSocket connections and unexpected Host headers', async () => {
        const wsUrl = server.url.replace('http', 'ws') + 'ws';
        const evil = new WebSocket(wsUrl, { headers: { Origin: 'https://evil.example' } } as never);
        const closed = await new Promise<boolean>((r) => {
            evil.onopen = () => r(false);
            evil.onerror = () => r(true);
        });
        expect(closed).toBe(true);
        const sameOrigin = await fetch(`${server.url}api/state`, { headers: { Origin: server.url.replace(/\/$/, '') } });
        expect(sameOrigin.status).toBe(200);
        const rebound = await fetch(`${server.url}api/state`, { headers: { Host: 'attacker.example' } });
        expect(rebound.status).toBe(403);
    });

    test('pushes an update after a file is saved, with added and changed elements', async () => {
        const src = await readFile(order(), 'utf8');
        await writeFile(
            order(),
            src
                .replace('    state Draft "下書き"\n', '    state Draft "下書き"\n    state Shipped { trackingNo: String }\n')
                .replace('  error EmptyOrder "明細なし"', '  error EmptyOrder "明細なし"\n  error NotShippable'),
        );
        const p = await nextUpdate((u) => u.diff.added.includes('Sales.Order#Shipped'));
        expect(p.status).toBe('ok');
        expect(p.diff.added.sort()).toEqual(['Sales.NotShippable', 'Sales.Order#Shipped']);
        expect(p.diff.changed).toEqual(['Sales.Order']);
        expect(p.states['Sales.Order'].both.nodes.map((n) => n.id)).toContain('Sales.Order#Shipped');
    });

    test('several files saved in a burst produce one consistent update', async () => {
        await writeFile(
            path.join(dir, 'shipping.dt'),
            'context Shipping { id ParcelId: UUID aggregate Parcel { id: ParcelId references order: Sales.OrderId -> Sales.Order } }',
        );
        await writeFile(path.join(dir, 'extra.dt'), 'context Shipping { value Address { line1: String } }');
        const p = await nextUpdate((u) => u.files.includes('extra.dt') && u.files.includes('shipping.dt'));
        expect(p.status).toBe('ok');
        expect(p.structure?.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['Shipping', 'Shipping.Parcel', 'Shipping.Address']));
        expect(p.structure?.edges.map((e) => e.id)).toContain('Shipping.Parcel.order');
    });

    test('a syntax error keeps the last diagram and reports the error location', async () => {
        const before = received.at(-1)!;
        const src = await readFile(order(), 'utf8');
        await writeFile(order(), src.replace('state Confirmed "確定済み" {', 'state Confirmed "確定済み" {{'));
        const p = await nextUpdate((u) => u.status === 'syntax-error');
        expect(p.stale).toBe(true);
        expect(p.structure).toEqual(before.structure);
        expect(p.model).toEqual(before.model);
        expect(p.modelVersion).toBe(before.modelVersion);
        expect(p.diagnostics[0]).toMatchObject({ file: 'sales/order.dt', code: 'SYNTAX', severity: 'error' });
        expect(p.diagnostics[0].start.line).toBeGreaterThan(1);
        // the diagram is the last valid one, but the sources are the current (broken) text
        expect(p.sources.find((x) => x.path === 'sales/order.dt')!.text).toContain('"確定済み" {{');

        await writeFile(order(), src);
        const fixed = await nextUpdate((u) => u.status === 'ok');
        expect(fixed.stale).toBe(false);
    });

    test('semantic errors still update the diagram and mark the element', async () => {
        const src = await readFile(order(), 'utf8');
        await writeFile(order(), src.replace('Draft -> Confirmed\n', 'Draft -> Archived\n'));
        const p = await nextUpdate((u) => u.status === 'invalid');
        expect(p.diagnostics.find((d) => d.code === 'M006')?.elementId).toBe('Sales.Order:confirm');
        expect(p.diff.changed).toContain('Sales.Order:confirm');
        await writeFile(order(), src);
        await nextUpdate((u) => u.status === 'ok');
    });

    test('removed elements are reported, and deleting a file updates the view', async () => {
        await rm(path.join(dir, 'extra.dt'));
        const p = await nextUpdate((u) => u.diff.removed.includes('Shipping.Address'));
        expect(p.files).not.toContain('extra.dt');
        expect(p.structure?.nodes.map((n) => n.id)).not.toContain('Shipping.Address');
    });

    test('layout state is persisted separately from the DSL', async () => {
        const file = path.join(dir, '.domaintrail', 'layout.json');
        expect((await stat(file)).isFile()).toBe(true);
        const layout = JSON.parse(await readFile(file, 'utf8'));
        expect(Object.keys(layout.graphs)).toContain('structure');
        expect(layout.graphs.structure.nodeLayout['Sales.Order']).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    });

    test('unchanged graphs reuse the previous layout (stable positions)', async () => {
        const before = received.at(-1)!;
        const src = await readFile(order(), 'utf8');
        await writeFile(order(), `// a comment does not change the model\n${src}`);
        const p = await nextUpdate((u) => u.version > before.version);
        expect(p.structure?.nodeLayout).toEqual(before.structure!.nodeLayout);
        expect(p.modelVersion).toBe(before.modelVersion);
    });
});

describe('layout persistence', () => {
    test('never writes through a symlinked layout directory or file', async () => {
        const { mkdtemp, symlink, writeFile: write, readFile: read, mkdir: mk, readlink, rm: remove } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { createViewService } = await import('../src/visualization/application/view-service.js');
        const { createFileLayoutStore } = await import('../src/visualization/infrastructure/file-layout-store.js');
        const { createGitRevisions } = await import('../src/visualization/infrastructure/git.js');
        const { createWorkspaceReader } = await import('../src/workspace/infrastructure/files.js');
        const { ElkLayoutEngine } = await import('../src/visualization/infrastructure/elk.js');
        const base = await mkdtemp(path.join(tmpdir(), 'domaintrail-link-'));
        const outside = path.join(base, 'outside');
        await mk(outside);
        await write(path.join(outside, 'victim.txt'), 'keep me');
        const engine = new ElkLayoutEngine();
        try {
            // 1. the layout directory is a symlink -> nothing is written
            const a = path.join(base, 'a');
            await mk(a);
            await write(path.join(a, 'm.dt'), 'context S { id AId: UUID aggregate A { id: AId } }');
            await symlink(outside, path.join(a, '.domaintrail'));
            await createViewService({
                root: a,
                engine,
                workspace: createWorkspaceReader(a),
                layoutStore: createFileLayoutStore(a),
                git: createGitRevisions(a),
            }).refresh();
            expect((await import('node:fs')).existsSync(path.join(outside, 'layout.json'))).toBe(false);

            // 2. layout.json is a symlink -> it is replaced, the target is untouched
            const b = path.join(base, 'b');
            await mk(path.join(b, '.domaintrail'), { recursive: true });
            await write(path.join(b, 'm.dt'), 'context S { id AId: UUID aggregate A { id: AId } }');
            await symlink(path.join(outside, 'victim.txt'), path.join(b, '.domaintrail', 'layout.json'));
            await createViewService({
                root: b,
                engine,
                workspace: createWorkspaceReader(b),
                layoutStore: createFileLayoutStore(b),
                git: createGitRevisions(b),
            }).refresh();
            expect(await read(path.join(outside, 'victim.txt'), 'utf8')).toBe('keep me');
            expect(await readlink(path.join(b, '.domaintrail', 'layout.json')).catch(() => 'replaced')).toBe('replaced');
        } finally {
            engine.dispose();
            await remove(base, { recursive: true, force: true });
        }
    });
});
