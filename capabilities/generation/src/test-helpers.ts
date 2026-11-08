// Helpers of the generator's unit tests: models of inline `.dt` sources and of examples/shop's, analyzed by Modeling with
// the generator's own check (M011) added, as the project analysis does.
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { analyzeDomain, type DomainAnalysis } from '@domaintrail/modeling';
import { compareDiagnostics, dedupeDiagnostics, hasErrors, type Diagnostic } from '@domaintrail/kernel';
import type { SourceFile } from '@domaintrail/kernel';
import { checkGeneratedNames } from './core/tsnames.js';
import type { DomainModel, ElementModel } from '@domaintrail/modeling';

const ROOT = path.join(import.meta.dir, '..', '..', '..');
export const EXAMPLES = path.join(ROOT, 'examples', 'shop');

/**
 * Gives a temporary project `dir` a node_modules as if it had domaintrail as a dev dependency: the entries of this
 * repository's node_modules (fast-check, the types of Bun), and a `domaintrail` whose `domaintrail/testing` (the
 * support of the generated contract tests) is its source, testing/index.ts, so that no build is needed.
 */
export async function linkNodeModules(dir: string): Promise<void> {
    const modules = path.join(dir, 'node_modules');
    await mkdir(modules);
    for (const entry of await readdir(path.join(ROOT, 'node_modules'))) await symlink(path.join(ROOT, 'node_modules', entry), path.join(modules, entry));
    const pkg = path.join(modules, 'domaintrail');
    await mkdir(pkg);
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'domaintrail', type: 'module', exports: { './testing': './testing/index.ts' } }));
    await symlink(path.join(ROOT, 'testing'), path.join(pkg, 'testing'));
}

/** Modeling's analysis with the generator's check, and whether it found no error. */
export type Checked = DomainAnalysis & { ok: boolean };

/** Analyzes `.dt` sources with Modeling's rules and the TypeScript name check (M011). */
export async function analyzeForGeneration(sources: readonly SourceFile[]): Promise<Checked> {
    const a = await analyzeDomain(sources);
    if (!a.syntaxOk) return { ...a, ok: false };
    const diagnostics = dedupeDiagnostics([...a.diagnostics, ...checkGeneratedNames(a)].sort(compareDiagnostics));
    return { ...a, diagnostics, ok: !hasErrors(diagnostics) };
}

/** Analyzes inline sources; keys are file names. */
export function check(files: Record<string, string>): Promise<Checked> {
    return analyzeForGeneration(Object.entries(files).map(([p, text]) => ({ path: p, text })));
}

/** Analyzes a single context body wrapped in `context Sales { ... }`. */
export function checkSales(body: string): Promise<Checked> {
    return check({ 'sales.dt': `context Sales {\n${body}\n}\n` });
}

export const codes = (a: Checked): string[] => a.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);

export function only(a: DomainAnalysis, code: string): Diagnostic[] {
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

type Keys<U> = U extends unknown ? keyof U : never;
type Part<U, K extends PropertyKey> = U extends { readonly [P in K]?: infer V } ? V : never;
/** A value of the Typed Model with its names and IDs as plain strings, to compare with literals. */
export type Plain<T> = T extends string ? string : T extends readonly (infer E)[] ? Plain<E>[] : T extends object ? { [K in keyof T]: Plain<T[K]> } : T;
/** A value of the Typed Model, typed with plain strings for its names and IDs. */
export const plain = <T>(value: T): Plain<T> => value as Plain<T>;

/** An element of any kind, with every part any kind has (absent at run time where its kind has none): for assertions. */
export type AnyElement = Plain<{ readonly [K in Keys<ElementModel>]: Part<ElementModel, K> }>;

/** The element of a model by stable ID, read as `AnyElement` (it must exist). */
export function element(model: DomainModel | undefined, id: string): AnyElement {
    const el = model?.elements.find((e) => e.id === id);
    if (!el) throw new Error(`no element ${id}`);
    return el as unknown as AnyElement;
}
