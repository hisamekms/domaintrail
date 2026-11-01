// Helpers of the page's unit tests: models analyzed from inline sources or from examples/shop, through Modeling's entry,
// and the payloads the view service sends for them.
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { analyze, type Analysis } from '@domaintrail/analysis';
import { type SourceFile } from '@domaintrail/kernel';
import { createViewService, ElkLayoutEngine } from '@domaintrail/visualization';
import type { ViewPayload } from '@domaintrail/visualization/protocol';

export const EXAMPLES = path.join(import.meta.dir, '..', '..', 'examples', 'shop');

/** Analyzes inline sources; keys are file names. */
export function check(files: Record<string, string>): Promise<Analysis> {
    return analyze(Object.entries(files).map(([p, text]) => ({ path: p, text })));
}

/** The `.dt` and `.dtes` sources of examples/shop, as `dt check` finds them (sorted, without generated/). */
export async function exampleSources(): Promise<SourceFile[]> {
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!['node_modules', '.git', '.domaintrail', 'generated'].includes(entry.name)) await walk(path.join(dir, entry.name));
            } else if (/\.(dt|dtes)$/.test(entry.name)) found.push(path.relative(EXAMPLES, path.join(dir, entry.name)));
        }
    };
    await walk(EXAMPLES);
    return Promise.all(found.sort().map(async (p) => ({ path: p, text: await readFile(path.join(EXAMPLES, p), 'utf8') })));
}

/**
 * The Live View's payloads for `steps` of sources, one refresh each, from the view service over in-memory ports (no
 * git, no saved layouts): what the page is sent, with the diff of each step against the one before.
 */
export async function viewPayloads(...steps: (readonly SourceFile[])[]): Promise<ViewPayload[]> {
    let sources: readonly SourceFile[] = [];
    const engine = new ElkLayoutEngine();
    const service = createViewService({
        root: '/workspace',
        engine,
        workspace: { readSources: async () => sources },
        layoutStore: { load: async () => new Map(), save: async () => {} },
        git: {
            resolveCommit: (ref) => Promise.reject(new Error(`no git: ${ref}`)),
            sourcesAt: async () => [],
            listRefs: async () => ({ branches: [], tags: [], commits: [] }),
            gitDirs: async () => undefined,
        },
    });
    const payloads: ViewPayload[] = [];
    try {
        for (const step of steps) {
            sources = step;
            payloads.push(await service.refresh());
        }
    } finally {
        engine.dispose();
    }
    return payloads;
}
