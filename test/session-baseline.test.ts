/**
 * What the collaboration sessions (ADR 0026, M1-0) build on and the other Live View tests do not pin down yet: the
 * payload of a workspace with `.dt` only, `.dtes` only and both, a `ref` that stops resolving, a `.dtes` syntax error,
 * an event shared by timelines, and that `dt view` exposes no session surface.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { startViewServer, type ViewServer } from '@domaintrail/composition/view';
import { createViewService, type ViewService } from '@domaintrail/visualization/application/view-service';
import { ElkLayoutEngine } from '@domaintrail/visualization/infrastructure/elk';
import { createFileLayoutStore } from '@domaintrail/visualization/infrastructure/file-layout-store';
import { createGitRevisions } from '@domaintrail/visualization/infrastructure/git';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import { createWorkspaceReader } from '@domaintrail/workspace/infrastructure/files';

const DT = `context Shop {
  id OrderId: UUID

  aggregate Order {
    id: OrderId

    state Open
    state Placed

    create command start(id: OrderId) -> Open

    command place()
      Open -> Placed
      emits OrderPlaced
  }

  event OrderPlaced {
    orderId: OrderId
  }
}
`;

const DTES = `storming Ordering "注文" {
  event OrderOpened
  event OrderPlaced {
    ref Shop.OrderPlaced
  }
  event OrderShipped

  timeline Normal {
    OrderOpened
    OrderPlaced
    OrderShipped
  }
}
`;

const engine = new ElkLayoutEngine();
const dirs: string[] = [];
afterAll(async () => {
    engine.dispose();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** A new workspace with `files` (paths relative to it). */
async function workspace(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-session-'));
    dirs.push(dir);
    for (const [file, text] of Object.entries(files)) await writeFile(path.join(dir, file), text);
    return dir;
}

/** The view service of the workspace at `dir`, with the real adapters. */
const viewService = (dir: string): ViewService =>
    createViewService({ root: dir, engine, workspace: createWorkspaceReader(dir), layoutStore: createFileLayoutStore(dir), git: createGitRevisions(dir) });

const errors = (p: ViewPayload): string[] => p.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.file} ${d.code}`);

describe('the Live View payload by the kinds of sources', () => {
    test('.dt only: the model and its graphs, no storming', async () => {
        const p = await viewService(await workspace({ 'shop.dt': DT })).refresh();
        expect(p).toMatchObject({ type: 'update', status: 'ok', stale: false, files: ['shop.dt'], stormings: [] });
        expect(p.sources).toEqual([{ path: 'shop.dt', text: DT }]);
        expect(Object.keys(p.model!.elements)).toEqual(expect.arrayContaining(['Shop.Order', 'Shop.OrderPlaced']));
        expect(p.structure?.nodes.map((n) => n.id)).toContain('Shop.Order');
        expect(p.diagnostics).toEqual([]);
    });

    test('.dtes only: the stormings, over an empty model (not `empty`, which is for no source at all)', async () => {
        const dtes = DTES.replace('  event OrderPlaced {\n    ref Shop.OrderPlaced\n  }', '  event OrderPlaced');
        const p = await viewService(await workspace({ 'ordering.dtes': dtes })).refresh();
        expect(p).toMatchObject({ status: 'ok', stale: false, files: ['ordering.dtes'] });
        expect(p.sources).toEqual([{ path: 'ordering.dtes', text: dtes }]);
        expect(p.model).not.toBeNull();
        expect(p.model!.elements).toEqual({});
        expect(p.structure?.nodes).toEqual([]);
        expect(p.stormings.map((s) => [s.id, s.file, s.stale])).toEqual([['Ordering', 'ordering.dtes', false]]);
        expect(p.diagnostics).toEqual([]);

        const none = await viewService(await workspace({})).refresh();
        expect(none).toMatchObject({ status: 'empty', files: [], sources: [], model: null, stormings: [] });
    });

    test('.dt and .dtes: both sources, the model and the stormings, the refs resolved', async () => {
        const p = await viewService(await workspace({ 'shop.dt': DT, 'ordering.dtes': DTES })).refresh();
        expect(p).toMatchObject({ status: 'ok', stale: false, files: ['ordering.dtes', 'shop.dt'] });
        expect(p.sources.map((s) => s.path)).toEqual(p.files);
        expect(p.model!.elements['Shop.OrderPlaced']).toBeDefined();
        expect(p.stormings.map((s) => s.id)).toEqual(['Ordering']);
        expect(p.diagnostics).toEqual([]);
    });
});

describe('a .dtes ref that stops resolving after a .dt edit', () => {
    test('is a link diagnostic on the .dtes; both sources and the storming stay in the payload', async () => {
        const dir = await workspace({ 'shop.dt': DT, 'ordering.dtes': DTES });
        const view = viewService(dir);
        await view.refresh();
        const renamed = DT.replaceAll('OrderPlaced', 'OrderSubmitted');
        await writeFile(path.join(dir, 'shop.dt'), renamed);
        const p = await view.refresh();
        expect(p.status).toBe('invalid');
        expect(p.stale).toBe(false);
        expect(errors(p)).toEqual(['ordering.dtes S010']);
        expect(p.diagnostics[0].message).toContain('Shop.OrderPlaced');
        expect(p.model!.elements['Shop.OrderSubmitted']).toBeDefined();
        expect(p.sources).toEqual([
            { path: 'ordering.dtes', text: DTES },
            { path: 'shop.dt', text: renamed },
        ]);
        expect(p.stormings.map((s) => [s.id, s.stale])).toEqual([['Ordering', false]]);

        await writeFile(path.join(dir, 'shop.dt'), DT);
        const fixed = await view.refresh();
        expect(fixed.status).toBe('ok');
        expect(fixed.diagnostics).toEqual([]);
    });
});

describe('a .dtes syntax error', () => {
    test('keeps the storming as last parsed, as stale, with the broken text in the sources; fixing it recovers', async () => {
        const dir = await workspace({ 'shop.dt': DT, 'ordering.dtes': DTES });
        const file = path.join(dir, 'ordering.dtes');
        const view = viewService(dir);
        const before = await view.refresh();

        const broken = DTES.replace('timeline Normal {', 'timeline Normal {{');
        await writeFile(file, broken);
        const p = await view.refresh();
        // the .dt model still draws: the payload is not stale, only the storming is
        expect(p.status).toBe('invalid');
        expect(p.stale).toBe(false);
        expect(p.model).toEqual(before.model);
        expect(p.diagnostics.find((d) => d.code === 'SYNTAX')).toMatchObject({ file: 'ordering.dtes', severity: 'error' });
        expect(p.sources.find((s) => s.path === 'ordering.dtes')!.text).toBe(broken);
        expect(p.stormings).toHaveLength(1);
        expect(p.stormings[0].stale).toBe(true);
        expect(p.stormings[0].storming).toEqual(before.stormings[0].storming);
        expect(p.stormings[0].views).toEqual(before.stormings[0].views);

        const edited = DTES.replace('  event OrderShipped', '  event OrderShipped\n  event OrderDelivered');
        await writeFile(file, edited);
        const fixed = await view.refresh();
        expect(fixed.status).toBe('ok');
        expect(fixed.stormings[0].stale).toBe(false);
        expect(fixed.stormings[0].storming.elements.map((e) => e.id)).toContain('OrderDelivered');
        expect(fixed.sources.find((s) => s.path === 'ordering.dtes')!.text).toBe(edited);
    });
});

describe('an event shared by timelines', () => {
    // B is shared by T1 and T3 on a common prefix (A B), and by T2 after another first step (X B): no suffix is shared
    const SHARED = `storming S {
  event A
  event B
  event C
  event D
  event X

  timeline T1 { A B C }
  timeline T2 { X B D }
  timeline T3 { A B D }
}
`;

    test('is one e:<eventId> note on the integrated canvas, and occurrence nodes with their timelines in each timeline view', async () => {
        const [storming] = (await viewService(await workspace({ 'shared.dtes': SHARED })).refresh()).stormings;
        expect(storming.timelines.map((t) => t.id)).toEqual(['T1', 'T2', 'T3']);
        for (const level of ['big-picture', 'design-level']) {
            const integrated = storming.views[`${level}|`];
            const notes = integrated.graph.nodes.filter((n) => n.kind === 'esEvent');
            expect(notes.filter((n) => n.elementId === 'es/S/B').map((n) => n.id)).toEqual(['e:B']);
            expect(notes.map((n) => n.id).sort()).toEqual(['e:A', 'e:B', 'e:C', 'e:D', 'e:X']);
            // the render graph of the integrated canvas keeps the occurrence nodes (`t:`) the note stands for
            const bNodes = integrated.render.nodes.flatMap((n) => (n.type === 'event' && n.eventId === 'B' ? [n] : []));
            expect(bNodes.map((n) => [n.id, n.occurrences.map((o) => `${o.timelineId}@${o.stepPath.join('.')}`)])).toEqual([
                ['t:e:A>e:B', ['T1@1', 'T3@1']],
                ['t:e:X>e:B', ['T2@1']],
            ]);

            for (const [timelineId, nodeId] of [
                ['T1', 't:e:A>e:B'],
                ['T2', 't:e:X>e:B'],
                ['T3', 't:e:A>e:B'],
            ]) {
                const view = storming.views[`${level}|${timelineId}`];
                const ids = view.graph.nodes.map((n) => n.id);
                expect(ids).not.toContain('e:B');
                expect(ids.every((id) => id.startsWith('t:') || id.startsWith('n:'))).toBe(true);
                const b = view.render.nodes.filter((n) => n.type === 'event' && n.eventId === 'B');
                expect(b).toEqual([{ type: 'event', id: nodeId, eventId: 'B', occurrences: [{ timelineId, eventId: 'B', stepPath: [1] }] }]);
                expect(view.graph.nodes.find((n) => n.id === nodeId)?.elementId).toBe('es/S/B');
            }
        }
    });
});

describe('dt view exposes no session surface', () => {
    let dir: string;
    let server: ViewServer;
    beforeAll(async () => {
        dir = await workspace({ 'shop.dt': DT, 'ordering.dtes': DTES });
        server = await startViewServer({ root: dir, port: 0, debounceMs: 30, engine });
        await server.ready;
    });
    afterAll(() => server?.stop());

    test('answers /api/session and anything below it with 404', async () => {
        for (const [method, p] of [
            ['GET', 'api/session'],
            ['GET', 'api/session/'],
            ['GET', 'api/session/state'],
            ['GET', 'api/session/events'],
            ['POST', 'api/session/requests'],
            ['POST', 'api/session/runs'],
            ['GET', 'api/session/revisions'],
        ]) {
            const res = await fetch(server.url + p, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
            expect([method, p, res.status]).toEqual([method, p, 404]);
        }
    });

    test('sends only type "update" over the WebSocket and ignores messages from the page', async () => {
        const received: { type: string }[] = [];
        const ws = new WebSocket(server.url.replace('http', 'ws') + 'ws');
        try {
            ws.onmessage = (ev) => received.push(JSON.parse(ev.data as string));
            await new Promise((r) => (ws.onopen = r));
            while (received.length === 0) await Bun.sleep(10);
            ws.send(JSON.stringify({ type: 'presence.update', location: { kind: 'dt', viewKey: 'structure' } }));
            ws.send('not json');
            await writeFile(path.join(dir, 'ordering.dtes'), DTES.replace('  event OrderShipped', '  event OrderShipped\n  event OrderPaid'));
            const deadline = Date.now() + 8000;
            const has = () => received.some((m) => (m as ViewPayload).stormings?.[0]?.storming.elements.some((e) => e.id === 'OrderPaid'));
            while (!has() && Date.now() < deadline) await Bun.sleep(20);
            expect(has()).toBe(true);
            expect(ws.readyState).toBe(WebSocket.OPEN);
            expect(new Set(received.map((m) => m.type))).toEqual(new Set(['update']));
        } finally {
            ws.close();
        }
    });
});
