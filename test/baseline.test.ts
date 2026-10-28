import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { buildStructureGraph } from '../src/graph/build.js';
import { markLineChanges } from '../src/graph/diff.js';
import { listRefs, sourcesAt } from '../src/server/git.js';
import type { Baseline, ViewPayload } from '../src/server/protocol.js';
import { startViewServer, type ViewServer } from '../src/server/server.js';
import { check, tempCopyOfExamples } from './helpers.js';

let dir: string;
let server: ViewServer;

const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
};
const order = () => path.join(dir, 'sales', 'order.dt');
const state = async (): Promise<ViewPayload> => (await fetch(`${server.url}api/state`)).json() as Promise<ViewPayload>;
const setBaseline = (body: unknown) => fetch(`${server.url}api/baseline`, { method: 'POST', body: JSON.stringify(body) });

beforeAll(async () => {
    dir = await tempCopyOfExamples();
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-qm', 'first');
    // the working tree: a field added to Order, a field removed from it and a new value object
    const text = (await readFile(order(), 'utf8')).replace('    note: String?\n', '    memo: String?\n');
    await writeFile(order(), text.replace('  /// 顧客からの購入依頼。', '  value Coupon { code: String }\n\n  /// 顧客からの購入依頼。'));
    server = await startViewServer({ root: dir, port: 0, debounceMs: 30, base: 'main' });
    await server.ready;
});

afterAll(async () => {
    await server?.stop();
    await rm(dir, { recursive: true, force: true });
});

describe('comparing with a git revision', () => {
    test('reads the sources of a commit below the root', async () => {
        const files = await sourcesAt(dir, 'HEAD', ['**/*.dt']);
        expect(files.map((f) => f.path)).toContain('sales/order.dt');
        expect(files.find((f) => f.path === 'sales/order.dt')!.text).toContain('note: String?');
        const refs = await listRefs(dir);
        expect(refs.branches).toEqual(['main']);
        expect(refs.commits.map((c) => c.subject)).toEqual(['first']);
    });

    test('marks what changed since the revision, and sends its model and graphs', async () => {
        const s = await state();
        const baseline = s.baseline as Extract<Baseline, { kind: 'git' }>;
        expect(baseline).toMatchObject({ kind: 'git', ref: 'main', commit: { subject: 'first' } });
        expect(baseline.error).toBeUndefined();
        expect(s.diff.added).toEqual(['Sales.Coupon']);
        expect(s.diff.changed).toContain('Sales.Order');
        expect(s.base?.model?.elements['Sales.Order'].fields.map((f) => f.name)).toContain('note');
        expect(s.base?.structure?.nodes.some((n) => n.id === 'Sales.Order')).toBe(true);
        // the Structure View's rows: the new field added, the removed one kept as a ghost where it was
        const rows = s.structure!.nodes.find((n) => n.id === 'Sales.Order')!.lines.map((l) => [l.key.en.name, l.change]);
        expect(rows).toContainEqual(['memo', 'added']);
        expect(rows).toContainEqual(['note', 'removed']);
        expect(rows).toContainEqual(['◆ items', undefined]);
    });

    test('rejects an unknown revision and keeps the baseline', async () => {
        const r = await setBaseline({ kind: 'git', ref: '--output=/tmp/x' });
        expect(r.status).toBe(400);
        expect((await state()).baseline).toMatchObject({ kind: 'git', ref: 'main' });
        expect((await setBaseline({ kind: 'nope' })).status).toBe(400);
    });

    test('follows the branch when it is committed to', async () => {
        git('commit', '-qam', 'second');
        const deadline = Date.now() + 8000;
        let s = await state();
        while (Date.now() < deadline && (s.baseline.kind !== 'git' || s.baseline.commit?.subject !== 'second')) {
            await Bun.sleep(50);
            s = await state();
        }
        expect(s.baseline).toMatchObject({ commit: { subject: 'second' } });
        // everything is committed now
        expect(s.diff).toEqual({ added: [], changed: [], removed: [] });
        expect(s.structure!.nodes.flatMap((n) => n.lines).some((l) => l.change)).toBe(false);
    });

    test('switches back to the previous save', async () => {
        const r = await setBaseline({ kind: 'previous' });
        expect(r.status).toBe(200);
        const s = await state();
        expect(s.baseline).toEqual({ kind: 'previous' });
        expect(s.base).toBeNull();
    });
});

describe('markLineChanges', () => {
    test('leaves graphs without a baseline and unchanged nodes as they are', async () => {
        const a = (await check({ 'a.dt': 'context A {\n  value V { x: Int y: String }\n}\n' })).model!;
        const b = (await check({ 'a.dt': 'context A {\n  value V { x: Int z: Bool }\n}\n' })).model!;
        const g = buildStructureGraph(b);
        expect(markLineChanges(g, undefined)).toBe(g);
        expect(markLineChanges(g, buildStructureGraph(b)).nodes).toEqual(g.nodes);
        const v = markLineChanges(g, buildStructureGraph(a)).nodes.find((n) => n.id === 'A.V')!;
        expect(v.lines.map((l) => [l.key.en.name, l.change])).toEqual([
            ['x', undefined],
            ['y', 'removed'],
            ['z', 'added'],
        ]);
        expect(v.height).toBe(g.nodes.find((n) => n.id === 'A.V')!.height + 21);
    });
});
