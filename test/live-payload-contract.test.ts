/**
 * Baseline of ADR 0027 (plan T0): the Live View payload of examples/shop, with its stormings, without them, and after a
 * change to a `.dt` file (the model diff, the baseline's graphs and the changed lines). Moving the model diff, the
 * dependency analysis and the storming's semantic graph out of visualization (T7) and the packages (T8) keep every
 * payload as it is. `test/live-contract.test.ts` pins the payload's keys and the storming views over the server.
 *
 * The snapshot holds what can be read (status, files, diagnostics, the diff, the size of every graph) and a SHA-256 of
 * each part of the payload, its varying fields (`version`, `updatedAt`, `root`) replaced. When a hash differs, write the
 * payloads with `DT_CONTRACT_DUMP=<dir> bun test test/live-payload-contract.test.ts` here and on the integration
 * branch, and diff the two directories. A deliberate change updates the snapshot with `bun test -u` and says why in its
 * commit.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createFileLayoutStore, createGitRevisions, createViewService, ElkLayoutEngine, type LaidOutGraph, type ViewService } from '@domaintrail/visualization';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import { DEFAULT_SOURCES, sourceSelection } from '@domaintrail/analysis';
import { createWorkspaceReader } from '@domaintrail/workspace';
import { tempCopyOfExamples } from './helpers.js';

const dirs: string[] = [];
afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** A view service over a copy of examples/shop (without its stormings if asked), as `dt view` wires it. */
async function shop(stormings: boolean): Promise<{ dir: string; view: ViewService }> {
    const dir = await tempCopyOfExamples();
    dirs.push(dir);
    if (!stormings) await rm(path.join(dir, 'stormings'), { recursive: true });
    const view = createViewService({
        root: dir,
        engine: new ElkLayoutEngine(),
        workspace: createWorkspaceReader(dir, sourceSelection()),
        layoutStore: createFileLayoutStore(dir),
        git: createGitRevisions(dir),
        sources: DEFAULT_SOURCES,
    });
    await view.refresh();
    return { dir, view };
}

/** The payload as JSON with its varying fields replaced. */
function normalized(payload: ViewPayload, dir: string): unknown {
    return JSON.parse(JSON.stringify({ ...payload, version: '<version>', updatedAt: '<updatedAt>' }).replaceAll(dir, '<root>'));
}

const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

const graph = (g: LaidOutGraph | null): unknown => g && { id: g.id, nodes: g.nodes.length, edges: g.edges.length, sha: sha(g) };

/** What the snapshot holds of a payload: the readable parts, the graphs' sizes, and a hash of every part. */
function summary(p: ViewPayload): unknown {
    return {
        status: p.status,
        stale: p.stale,
        files: p.files,
        focusContexts: p.focusContexts,
        diagnostics: p.diagnostics,
        modelVersion: p.modelVersion,
        diff: p.diff,
        baseline: p.baseline,
        layoutEngine: p.layoutEngine,
        model: sha(p.model),
        sources: sha(p.sources),
        structure: graph(p.structure),
        overview: graph(p.overview),
        aggregates: graph(p.aggregates),
        contextMap: graph(p.contextMap),
        contextMapAll: graph(p.contextMapAll),
        states: Object.fromEntries(
            Object.entries(p.states).map(([aggregate, byLabels]) => [
                aggregate,
                Object.fromEntries(Object.entries(byLabels).map(([labels, g]) => [labels, graph(g)])),
            ]),
        ),
        stormings: p.stormings.map((s) => ({
            id: s.id,
            file: s.file,
            stale: s.stale,
            timelines: s.timelines,
            storming: sha(s.storming),
            views: Object.fromEntries(
                Object.entries(s.views).map(([key, v]) => [
                    key,
                    { render: { nodes: v.render.nodes.length, edges: v.render.edges.length, sha: sha(v.render) }, graph: graph(v.graph) },
                ]),
            ),
        })),
        base: p.base && {
            model: sha(p.base.model),
            structure: graph(p.base.structure),
            overview: graph(p.base.overview),
            aggregates: graph(p.base.aggregates),
            contextMap: graph(p.base.contextMap),
            contextMapAll: graph(p.base.contextMapAll),
            states: sha(p.base.states),
        },
        all: sha(p),
    };
}

async function pin(name: string, payload: ViewPayload, dir: string): Promise<void> {
    const p = normalized(payload, dir) as ViewPayload;
    const dump = process.env.DT_CONTRACT_DUMP;
    if (dump) {
        await mkdir(dump, { recursive: true });
        await writeFile(path.join(dump, `${name}.json`), JSON.stringify(p, null, 2));
    }
    expect(summary(p)).toMatchSnapshot();
}

describe('the Live View payload of examples/shop', () => {
    test('with its stormings', async () => {
        const { dir, view } = await shop(true);
        await pin('with-stormings', view.state, dir);
    });

    test('without stormings', async () => {
        const { dir, view } = await shop(false);
        await pin('without-stormings', view.state, dir);
    });

    test('after a change to a .dt file: the diff, the baseline and the changed lines', async () => {
        const { dir, view } = await shop(true);
        const file = path.join(dir, 'sales', 'order.dt');
        const text = await readFile(file, 'utf8');
        expect(text).toContain('    note: String?\n');
        await writeFile(file, text.replace('    note: String?\n', '    note: String?\n    giftMessage: String?\n'));
        await pin('after-change', await view.refresh(), dir);
    });
});
