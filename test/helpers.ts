import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { analyze, type Analysis } from '@domaintrail/modeling/core/analyze';
import type { Diagnostic } from '@domaintrail/modeling/core/diagnostics';

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
