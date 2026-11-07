import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { startViewServer, type ViewServer } from '@domaintrail/dt';
import { createFileLayoutStore, createGitRevisions, createViewService, ElkLayoutEngine, stormingViewKey, type ViewService } from '@domaintrail/visualization';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import { createWorkspaceReader } from '@domaintrail/workspace';
import { sourceSelection } from '@domaintrail/analysis';

const SAMPLE = await readFile(path.join(import.meta.dir, 'fixtures', 'dtes', 'delivery-cancellation.dtes'), 'utf8');

/** The view service of the workspace at `dir`, with the real adapters. */
const viewService = (dir: string): ViewService =>
    createViewService({
        root: dir,
        engine,
        workspace: createWorkspaceReader(dir, sourceSelection()),
        layoutStore: createFileLayoutStore(dir),
        git: createGitRevisions(dir),
    });

const engine = new ElkLayoutEngine();
afterAll(() => engine.dispose());

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
        const session = viewService(dir);
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
            // one graph per storming, level and timeline, as the page receives it
            expect(graph.id).toBe(`storming:${view.id}:${render.options.level}:${render.options.timelineId ?? '*'}`);
            expect(Object.keys(graph.nodeLayout).sort()).toEqual(graph.nodes.map((n) => n.id).sort());
        }
        await session.refresh();
        const after = await stat(file());
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(await readFile(file(), 'utf8')).toBe(SAMPLE);
    });

    test('shows external systems at the Design Level only, and every event at both levels (R14, R17)', async () => {
        const [view] = (await viewService(dir).refresh()).stormings;
        const ids = (key: string) => view.views[key].graph.nodes.map((n) => n.id);
        // beside the command it issues (one note per use)
        expect(ids('design-level|')).toContain('n:PaymentGateway@ReceivePaymentNotice');
        expect(ids('big-picture|').filter((id) => id.startsWith('n:PaymentGateway'))).toEqual([]);
        const events = (key: string) => view.views[key].graph.nodes.filter((n) => n.kind === 'esEvent').map((n) => n.id);
        expect(events('big-picture|')).toEqual(events('design-level|'));
        expect(ids('big-picture|Failure')).toEqual(['n:Compensation', 't:e:ShipmentCancelled', 't:e:ShipmentCancelled>e:ReleaseFailed']);
    });

    test('keeps a storming whose file stops parsing, as stale, and lays out an edit incrementally', async () => {
        const session = viewService(dir);
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

describe('the Live View of a storming with stages', () => {
    let dir: string;
    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-dtes-stages-'));
        await writeFile(
            path.join(dir, 'issuance.dtes'),
            await readFile(path.join(import.meta.dir, 'fixtures', 'stages', 'convenience-store-stages.dtes'), 'utf8'),
        );
    });
    afterAll(() => rm(dir, { recursive: true, force: true }));

    test('pushes its stages in time order, a view of each, and places the views of stages on their grid, the same on every refresh', async () => {
        const [view] = (await viewService(dir).refresh()).stormings;
        expect(view.stages).toEqual([
            { id: 'Preparation', label: '依頼・準備' },
            { id: 'Issuance', label: 'コンビニでの発行' },
            { id: 'Submission', label: '提出' },
        ]);
        expect(view.timelines.find((t) => t.id === 'PinLockedBranch')).toEqual({
            id: 'PinLockedBranch',
            label: '暗証番号のロック',
            stageId: 'Issuance',
            exception: true,
        });
        const keys = Object.keys(view.views);
        for (const key of [
            'big-picture|',
            'big-picture|@Issuance',
            'design-level|@Submission',
            'big-picture|PinLockedBranch',
            'big-picture|-exceptions',
            'design-level|@Issuance-exceptions',
        ])
            expect(keys).toContain(key);
        // a timeline's view is never without its exceptions
        expect(keys).not.toContain('big-picture|PinLockedBranch-exceptions');
        for (const [key, { render, graph }] of Object.entries(view.views)) {
            expect(stormingViewKey(render.options)).toBe(key);
            expect(Object.keys(graph.nodeLayout).sort()).toEqual(graph.nodes.map((n) => n.id).sort());
            // the integrated canvas and the stages on a grid; a timeline laid out as ever
            expect(!!graph.grid).toBe(render.options.timelineId === undefined);
        }
        const again = (await viewService(dir).refresh()).stormings[0]!;
        expect(again.views['big-picture|'].graph.nodeLayout).toEqual(view.views['big-picture|'].graph.nodeLayout);
        expect(again.views['big-picture|@Issuance'].graph.edgeLayout).toEqual(view.views['big-picture|@Issuance'].graph.edgeLayout);
    });
});
