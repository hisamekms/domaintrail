import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { type Analysis, analyze } from '@domaintrail/analysis';
import { type Diagnostic, type SourceFile } from '@domaintrail/kernel';
import { createViewService, ElkLayoutEngine } from '@domaintrail/visualization';
import type { ViewPayload } from '@domaintrail/visualization/protocol';

export const EXAMPLES = path.join(import.meta.dir, '..', 'examples', 'shop');

/** Analyzes inline sources; keys are file names. */
export function check(files: Record<string, string>): Promise<Analysis> {
    return analyze(Object.entries(files).map(([p, text]) => ({ path: p, text })));
}

/** Analyzes a single context body wrapped in `context Sales { ... }`. */
export function checkSales(body: string): Promise<Analysis> {
    return check({ 'sales.dt': `context Sales {\n${body}\n}\n` });
}

export const codes = (a: Analysis): string[] => a.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);

export function only(a: Analysis, code: string): Diagnostic[] {
    return a.diagnostics.filter((d) => d.code === code);
}

export async function tempCopyOfExamples(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-'));
    await cp(EXAMPLES, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}generated`) && !src.includes(`${path.sep}.dt`) });
    return dir;
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
