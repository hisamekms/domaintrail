// The generation's sections of domaintrail.jsonc (ADR 0027, Project analysis and configuration: `generation` owns its
// output and options): `generate.ts` and `lintHint`, their defaults and their validation. The app composes them with
// the other sections.
import * as path from 'node:path';
import { RUNNERS, type Runner } from './tests.js';
import { POLICY_MODES, type PolicyMode } from './typescript.js';

export const DEFAULT_TS_OUT = 'generated/domain';
export const DEFAULT_POLICIES: PolicyMode = 'optional';

/** The keys of the sections, by where they sit in the file (`''`: the top level; `*`: any key). */
export const GENERATION_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = {
    '': ['lintHint', 'generate'],
    generate: ['ts'],
    'generate.ts': ['out', 'policies', 'contexts', 'tests'],
    'generate.ts.contexts.*': ['out', 'policies', 'module'],
    'generate.ts.tests': ['out', 'runner'],
};

/** The sections in the config file. */
export interface GenerationConfigFile {
    /** Whether `dt generate ts` says so when no lint rule against casts to domain types is found. Default: true. */
    lintHint?: boolean;
    generate?: {
        ts?: {
            out?: string;
            /** Whether the policies of a context must be implemented (ADR 0022). Default: `optional`. */
            policies?: PolicyMode;
            /**
             * Per context: its own output directory, the module through which the package of that directory exports
             * the context's generated code (ADR 0028), and how its policies are generated (overrides `policies`).
             */
            contexts?: Record<string, { out?: string; module?: string; policies?: PolicyMode }>;
            tests?: { out?: string; runner?: Runner };
        };
    };
}

/** The sections resolved: every default applied. */
export interface ResolvedGenerationConfig {
    lintHint: boolean;
    tsOut: string;
    /** Output directories of contexts written elsewhere than `tsOut`, by context name. */
    tsContexts: Record<string, string>;
    /**
     * The modules of contexts written into another package (`generate.ts.contexts.<Ctx>.module`, with its `out`), by
     * context name: generated code in another directory imports the context from there, and its tests from
     * `<module>/tests`.
     */
    tsModules: Record<string, string>;
    /**
     * Whether policies are `optional` (a handler type per policy) or `required` (also `<Context>PolicyHandlers`, which
     * the contract tests require): the project's setting (`generate.ts.policies`, default `optional`) and the contexts
     * that override it (`generate.ts.contexts.<Ctx>.policies`). See `policyModes`.
     */
    tsPolicies: { project: PolicyMode; contexts: Record<string, PolicyMode> };
    /**
     * The contract tests (`generate.ts.tests`), generated only when configured: their directory (absent: `tests` in the
     * output directory of `generate.ts.out` / `--out`) and the runner to write an adapter for.
     */
    tsTests?: { out?: string; runner?: Runner };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks the sections' keys of the config file's top level (`lintHint`, `generate`); `fail` throws. */
export function validateGenerationConfig(config: Record<string, unknown>, fail: (msg: string) => never): void {
    if (config.lintHint !== undefined && typeof config.lintHint !== 'boolean') fail("'lintHint' must be true or false");
    const gen = config.generate;
    if (gen === undefined) return;
    if (!isObject(gen)) return fail("'generate' must be an object");
    for (const key of Object.keys(gen)) if (key !== 'ts') fail(`unknown generator 'generate.${key}' (supported: ts)`);
    const ts = gen.ts;
    if (ts !== undefined && !isObject(ts)) fail("'generate.ts' must be an object");
    const tsKeys = isObject(ts) ? ts : {};
    for (const key of Object.keys(tsKeys)) if (!GENERATION_CONFIG_KEYS['generate.ts'].includes(key)) fail(`unknown key 'generate.ts.${key}'`);
    checkOut(tsKeys.out, 'generate.ts.out', fail);
    checkPolicies(tsKeys.policies, 'generate.ts.policies', fail);
    const tests = tsKeys.tests;
    if (tests !== undefined) {
        if (!isObject(tests)) return fail("'generate.ts.tests' must be an object");
        for (const k of Object.keys(tests)) if (!GENERATION_CONFIG_KEYS['generate.ts.tests'].includes(k)) fail(`unknown key 'generate.ts.tests.${k}'`);
        checkOut(tests.out, 'generate.ts.tests.out', fail);
        if (tests.runner !== undefined && !(RUNNERS as readonly unknown[]).includes(tests.runner)) {
            fail(`'generate.ts.tests.runner' must be one of ${RUNNERS.map((r) => `'${r}'`).join(', ')}`);
        }
    }
    const contexts = tsKeys.contexts;
    if (contexts !== undefined) {
        if (!isObject(contexts)) return fail("'generate.ts.contexts' must be an object keyed by context name");
        for (const [ctx, c] of Object.entries(contexts)) {
            const key = `generate.ts.contexts.${ctx}`;
            if (!isObject(c)) return fail(`'${key}' must be an object`);
            for (const k of Object.keys(c)) if (!GENERATION_CONFIG_KEYS['generate.ts.contexts.*'].includes(k)) fail(`unknown key '${key}.${k}'`);
            if (c.module !== undefined) {
                if (typeof c.module !== 'string' || c.module.trim() === '') fail(`'${key}.module' must be a module specifier (a non-empty string)`);
                if (c.out === undefined) fail(`'${key}.module' needs '${key}.out': the module is that of the package the context is written into`);
            }
            if (c.out === undefined && c.policies === undefined) fail(`'${key}' needs 'out' or 'policies'`);
            checkOut(c.out, `${key}.out`, fail);
            checkPolicies(c.policies, `${key}.policies`, fail);
        }
    }
}

/** The sections with their defaults (validated). */
export function resolveGenerationConfig(config: GenerationConfigFile = {}): ResolvedGenerationConfig {
    const contexts = Object.entries(config.generate?.ts?.contexts ?? {});
    return {
        lintHint: config.lintHint ?? true,
        tsOut: config.generate?.ts?.out ?? DEFAULT_TS_OUT,
        tsContexts: Object.fromEntries(contexts.flatMap(([ctx, c]) => (c.out !== undefined ? [[ctx, c.out]] : []))),
        tsModules: Object.fromEntries(contexts.flatMap(([ctx, c]) => (c.module !== undefined ? [[ctx, c.module]] : []))),
        tsPolicies: {
            project: config.generate?.ts?.policies ?? DEFAULT_POLICIES,
            contexts: Object.fromEntries(contexts.flatMap(([ctx, c]) => (c.policies ? [[ctx, c.policies]] : []))),
        },
        ...(config.generate?.ts?.tests && { tsTests: config.generate.ts.tests }),
    };
}

/** An output directory: a string inside the directory of the config file. */
function checkOut(out: unknown, key: string, fail: (msg: string) => never): void {
    if (out === undefined) return;
    if (typeof out !== 'string') return fail(`'${key}' must be a string`);
    if (!staysInside(out)) fail(`'${key}' must stay inside the directory of the config file: '${out}'`);
}

/** `optional` or `required` (ADR 0022). */
function checkPolicies(mode: unknown, key: string, fail: (msg: string) => never): void {
    if (mode !== undefined && !(POLICY_MODES as readonly unknown[]).includes(mode))
        fail(`'${key}' must be one of ${POLICY_MODES.map((m) => `'${m}'`).join(', ')}`);
}

/**
 * Whether a path relative to the root stays inside it: not absolute and without a `..` segment. Used for output
 * directories from the config and `--out`.
 */
export function staysInside(rel: string): boolean {
    return !path.isAbsolute(rel) && !path.win32.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..');
}

/** How the policies of each context are generated: the context's own setting, else the project's, else `optional`. */
export function policyModes(config: Pick<ResolvedGenerationConfig, 'tsPolicies'>, contexts: readonly string[]): Record<string, PolicyMode> {
    return Object.fromEntries(contexts.map((c) => [c, config.tsPolicies.contexts[c] ?? config.tsPolicies.project]));
}

/**
 * Why `generate.ts.contexts` is wrong once the model's contexts are known (`dt generate` asks after checking): it names a
 * context the model does not have. `undefined` when it names none.
 */
export function unknownTsContexts(config: Pick<ResolvedGenerationConfig, 'tsContexts' | 'tsPolicies'>, contexts: readonly string[]): string | undefined {
    const unknown = [...new Set([...Object.keys(config.tsContexts), ...Object.keys(config.tsPolicies.contexts)])].filter((c) => !contexts.includes(c));
    if (unknown.length === 0) return undefined;
    return `'generate.ts.contexts' names ${unknown.map((c) => `'${c}'`).join(', ')}, which ${unknown.length > 1 ? 'are not contexts' : 'is not a context'} of the model (contexts: ${contexts.join(', ') || 'none'}).`;
}
