// Helpers of Modeling's unit tests: analyses of inline sources and of examples/shop.
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { analyze, type Analysis, type SourceFile } from './core/analyze.js';
import type { Diagnostic } from './core/diagnostics.js';

export const EXAMPLES = path.join(import.meta.dir, '..', '..', '..', 'examples', 'shop');

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
