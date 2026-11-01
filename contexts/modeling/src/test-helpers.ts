// Helpers of Modeling's unit tests: Modeling's analysis of inline `.dt` sources and of examples/shop's.
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { analyzeDomain, type DomainAnalysis } from './application/analyze.js';
import { hasErrors, type Diagnostic } from '@domaintrail/kernel';
import type { SourceFile } from '@domaintrail/kernel';
import type { Site, SourceModel } from './domain/source-model.js';
import { DiagnosticSink } from './infrastructure/syntax/diagnostic-sink.js';
import { checkChanges, checkCommands, checkFactoryIds } from './domain/rules/commands.js';
import { checkEventIds } from './domain/rules/events.js';
import { checkFieldSets } from './domain/rules/field-sets.js';
import { checkInvariants } from './domain/rules/expressions.js';
import { checkLabels } from './domain/rules/labels.js';
import { checkNames } from './domain/rules/names.js';
import { checkPayloadNames } from './domain/rules/payloads.js';
import { checkPolicies } from './domain/rules/policies.js';
import { checkShared } from './domain/rules/shared.js';
import { checkStructure } from './domain/rules/structure.js';
import { checkUnions } from './domain/rules/unions.js';
import { checkVerified } from './domain/rules/verified.js';

export const EXAMPLES = path.join(import.meta.dir, '..', '..', '..', 'examples', 'shop');

/** Modeling's analysis, and whether it found no error. */
export type Checked = DomainAnalysis & { ok: boolean };

/**
 * Analyzes inline sources; keys are file names. Every rule test also checks that the model as written carries the site
 * of every diagnostic Modeling's rules report (T9; the rules move onto it in T10).
 */
export async function check(files: Record<string, string>): Promise<Checked> {
    const a = await analyzeDomain(Object.entries(files).map(([p, text]) => ({ path: p, text })));
    const missing = unsitedDiagnostics(a);
    if (missing.length) throw new Error(`the model as written has no site for ${JSON.stringify(missing, null, 2)}`);
    return { ...a, ok: a.syntaxOk && !hasErrors(a.diagnostics) };
}

/** The key of a site: its range and its element. */
export const siteKey = (s: Pick<Site, 'file' | 'start' | 'end' | 'elementId'>): string =>
    `${s.file}:${s.start.line}:${s.start.column}-${s.end.line}:${s.end.column} ${s.elementId ?? ''}`;

/**
 * Every site of the model as written (`at` and the `…At` properties, at any depth), by key. References are not
 * followed (their targets are declarations seen elsewhere).
 */
export function sitesOf(model: SourceModel): Set<string> {
    const out = new Set<string>();
    const seen = new Set<object>();
    const visit = (value: unknown, key: string): void => {
        if (!value || typeof value !== 'object' || seen.has(value) || key === 'target' || key === 'byName') return;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const v of value) visit(v, key);
            return;
        }
        if (key === 'at' || key.endsWith('At')) out.add(siteKey(value as Site));
        for (const [k, v] of Object.entries(value)) visit(v, k);
    };
    visit(model, '');
    return out;
}

/** What Modeling's rules report over an analysis (as `analyzeDomain` runs them, when the sources parse). */
export function ruleDiagnostics(a: DomainAnalysis): Diagnostic[] {
    if (!a.syntaxOk) return [];
    const sink = new DiagnosticSink(a.resolveFile);
    for (const rule of [
        checkNames,
        checkShared,
        checkStructure,
        checkUnions,
        checkFieldSets,
        checkVerified,
        checkCommands,
        checkFactoryIds,
        checkChanges,
        checkEventIds,
        checkPayloadNames,
        checkPolicies,
        checkInvariants,
        checkLabels,
    ])
        rule(a.index, sink);
    return sink.items;
}

/** The diagnostics of Modeling's rules whose site the model as written does not carry. */
export function unsitedDiagnostics(a: DomainAnalysis): Diagnostic[] {
    if (!a.sourceModel) return [];
    const sites = sitesOf(a.sourceModel);
    return ruleDiagnostics(a).filter((d) => !sites.has(siteKey(d)));
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
