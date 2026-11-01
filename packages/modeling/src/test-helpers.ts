// Helpers of Modeling's unit tests: Modeling's analysis of inline `.dt` sources and of examples/shop's.
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { analyzeDomain, type DomainAnalysis } from './core/analyze.js';
import { hasErrors, type Diagnostic } from './kernel/diagnostics.js';
import type { SourceFile } from './kernel/source.js';

export const EXAMPLES = path.join(import.meta.dir, '..', '..', '..', 'examples', 'shop');

/** Modeling's analysis, and whether it found no error. */
export type Checked = DomainAnalysis & { ok: boolean };

/** Analyzes inline sources; keys are file names. */
export async function check(files: Record<string, string>): Promise<Checked> {
    const a = await analyzeDomain(Object.entries(files).map(([p, text]) => ({ path: p, text })));
    return { ...a, ok: a.syntaxOk && !hasErrors(a.diagnostics) };
}

/** Analyzes a single context body wrapped in `context Sales { ... }`. */
export function checkSales(body: string): Promise<Checked> {
    return check({ 'sales.dt': `context Sales {\n${body}\n}\n` });
}

export const codes = (a: Checked): string[] => a.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);

export function only(a: Checked, code: string): Diagnostic[] {
    return a.diagnostics.filter((d) => d.code === code);
}

/** The `.dt` sources of examples/shop, as `dt check` finds them (sorted, without generated/). */
export async function exampleSources(): Promise<SourceFile[]> {
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!['node_modules', '.git', '.domaintrail', 'generated'].includes(entry.name)) await walk(path.join(dir, entry.name));
            } else if (entry.name.endsWith('.dt')) found.push(path.relative(EXAMPLES, path.join(dir, entry.name)));
        }
    };
    await walk(EXAMPLES);
    return Promise.all(found.sort().map(async (p) => ({ path: p, text: await readFile(path.join(EXAMPLES, p), 'utf8') })));
}
