import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import picomatch from 'picomatch';
import { RUNNERS, type Runner } from '../generator/tests.js';
import { POLICY_MODES, type PolicyMode } from '../generator/typescript.js';

/** Config file names, in order of preference within one directory. */
export const CONFIG_FILES = ['domaintrail.jsonc', 'domaintrail.json'] as const;

export const DEFAULT_SOURCES = ['**/*.dt'];
export const DEFAULT_TS_OUT = 'generated/domain';
export const DEFAULT_PORT = 4321;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_POLICIES: PolicyMode = 'optional';

/** Contents of domaintrail.jsonc / domaintrail.json. Paths are relative to the config file. */
export interface DomainTrailConfigFile {
    $schema?: string;
    /** Globs of DSL files; `!pattern` excludes. Default: `**\/*.dt`. */
    sources?: string[];
    /** Whether files and directories ignored by `.gitignore` are skipped when finding sources. Default: true. */
    respectGitignore?: boolean;
    /** Whether `dt generate ts` says so when no lint rule against casts to domain types is found. Default: true. */
    lintHint?: boolean;
    generate?: {
        ts?: {
            out?: string;
            /** Whether the policies of a context must be implemented (ADR 0022). Default: `optional`. */
            policies?: PolicyMode;
            /** Per context: its own output directory, and how its policies are generated (overrides `policies`). */
            contexts?: Record<string, { out?: string; policies?: PolicyMode }>;
            tests?: { out?: string; runner?: Runner };
        };
    };
    view?: { port?: number; host?: string };
}

export interface ResolvedConfig {
    /** Directory all paths are relative to: the config file's directory, or the given root. */
    root: string;
    /** Absolute path of the config file, if one was found. */
    file?: string;
    sources: string[];
    respectGitignore: boolean;
    lintHint: boolean;
    tsOut: string;
    /** Output directories of contexts written elsewhere than `tsOut`, by context name. */
    tsContexts: Record<string, string>;
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
    view: { port: number; host: string };
}

export class ConfigError extends Error {}

/** Finds a config file in `start` or its parents (like tsconfig.json). */
export function findConfigFile(start: string): string | undefined {
    let dir = path.resolve(start);
    for (;;) {
        for (const name of CONFIG_FILES) {
            const candidate = path.join(dir, name);
            if (existsSync(candidate)) return candidate;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

/**
 * Resolves the configuration: an explicit `--config` file, else a config file found from `start` upwards,
 * else defaults rooted at `start`.
 */
export async function loadConfig(opts: { start: string; configPath?: string }): Promise<ResolvedConfig> {
    const file = opts.configPath ? path.resolve(opts.configPath) : findConfigFile(opts.start);
    if (opts.configPath && !existsSync(file!)) throw new ConfigError(`Config file not found: ${opts.configPath}`);
    if (!file) return { root: path.resolve(opts.start), ...defaults() };

    const raw = parseJsonc(await readFile(file, 'utf8'), file);
    const config = validate(raw, file);
    return {
        root: path.dirname(file),
        file,
        sources: config.sources ?? DEFAULT_SOURCES,
        respectGitignore: config.respectGitignore ?? true,
        lintHint: config.lintHint ?? true,
        tsOut: config.generate?.ts?.out ?? DEFAULT_TS_OUT,
        tsContexts: Object.fromEntries(Object.entries(config.generate?.ts?.contexts ?? {}).flatMap(([ctx, c]) => (c.out !== undefined ? [[ctx, c.out]] : []))),
        tsPolicies: {
            project: config.generate?.ts?.policies ?? DEFAULT_POLICIES,
            contexts: Object.fromEntries(Object.entries(config.generate?.ts?.contexts ?? {}).flatMap(([ctx, c]) => (c.policies ? [[ctx, c.policies]] : []))),
        },
        ...(config.generate?.ts?.tests && { tsTests: config.generate.ts.tests }),
        view: { port: config.view?.port ?? DEFAULT_PORT, host: config.view?.host ?? DEFAULT_HOST },
    };
}

function defaults(): Omit<ResolvedConfig, 'root' | 'file'> {
    return {
        sources: DEFAULT_SOURCES,
        respectGitignore: true,
        lintHint: true,
        tsOut: DEFAULT_TS_OUT,
        tsContexts: {},
        tsPolicies: { project: DEFAULT_POLICIES, contexts: {} },
        view: { port: DEFAULT_PORT, host: DEFAULT_HOST },
    };
}

/** How the policies of each context are generated: the context's own setting, else the project's, else `optional`. */
export function policyModes(config: ResolvedConfig, contexts: readonly string[]): Record<string, PolicyMode> {
    return Object.fromEntries(contexts.map((c) => [c, config.tsPolicies.contexts[c] ?? config.tsPolicies.project]));
}

/** JSON with comments and trailing commas (JSONC). */
export function parseJsonc(text: string, file = 'config'): unknown {
    let out = '';
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
            const start = i++;
            while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
            out += text.slice(start, ++i);
        } else if (ch === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
        } else if (ch === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? text.length : end + 2;
        } else {
            out += ch;
            i++;
        }
    }
    try {
        return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
    } catch (e) {
        throw new ConfigError(`${file}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function validate(raw: unknown, file: string): DomainTrailConfigFile {
    const fail = (msg: string): never => {
        throw new ConfigError(`${file}: ${msg}`);
    };
    if (!isObject(raw)) return fail('expected an object');
    const c = raw;
    for (const key of Object.keys(c)) {
        if (!['$schema', 'sources', 'respectGitignore', 'lintHint', 'generate', 'view'].includes(key)) fail(`unknown key '${key}'`);
    }
    const sources = c.sources;
    if (sources !== undefined && (!Array.isArray(sources) || sources.some((s) => typeof s !== 'string'))) {
        fail("'sources' must be an array of glob strings");
    }
    if (Array.isArray(sources)) {
        if (!sources.some((s) => !String(s).startsWith('!'))) fail("'sources' needs at least one include pattern");
        for (const s of sources.map(String)) {
            if (s.replace(/^!/, '').split('/').includes('..') || path.isAbsolute(s.replace(/^!/, ''))) {
                fail(`'sources' must stay inside the directory of the config file: '${s}'`);
            }
        }
    }
    if (c.respectGitignore !== undefined && typeof c.respectGitignore !== 'boolean') fail("'respectGitignore' must be true or false");
    if (c.lintHint !== undefined && typeof c.lintHint !== 'boolean') fail("'lintHint' must be true or false");
    const gen = c.generate;
    if (gen !== undefined) {
        if (!isObject(gen)) return fail("'generate' must be an object");
        for (const key of Object.keys(gen)) if (key !== 'ts') fail(`unknown generator 'generate.${key}' (supported: ts)`);
        const ts = gen.ts;
        if (ts !== undefined && !isObject(ts)) fail("'generate.ts' must be an object");
        const tsKeys = isObject(ts) ? ts : {};
        for (const key of Object.keys(tsKeys)) if (!['out', 'policies', 'contexts', 'tests'].includes(key)) fail(`unknown key 'generate.ts.${key}'`);
        checkOut(tsKeys.out, 'generate.ts.out', fail);
        checkPolicies(tsKeys.policies, 'generate.ts.policies', fail);
        const tests = tsKeys.tests;
        if (tests !== undefined) {
            if (!isObject(tests)) return fail("'generate.ts.tests' must be an object");
            for (const k of Object.keys(tests)) if (!['out', 'runner'].includes(k)) fail(`unknown key 'generate.ts.tests.${k}'`);
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
                for (const k of Object.keys(c)) if (k !== 'out' && k !== 'policies') fail(`unknown key '${key}.${k}'`);
                if (c.out === undefined && c.policies === undefined) fail(`'${key}' needs 'out' or 'policies'`);
                checkOut(c.out, `${key}.out`, fail);
                checkPolicies(c.policies, `${key}.policies`, fail);
            }
        }
    }
    const view = c.view;
    if (view !== undefined) {
        if (!isObject(view)) return fail("'view' must be an object");
        if (view.port !== undefined && (typeof view.port !== 'number' || !Number.isInteger(view.port) || view.port < 0))
            fail("'view.port' must be a port number");
        if (view.host !== undefined && typeof view.host !== 'string') fail("'view.host' must be a string");
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every key was checked above
    return c as DomainTrailConfigFile;
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
 * directories from the config and `--out`, and for the entries of `.domaintrail/generated.json`.
 */
export function staysInside(rel: string): boolean {
    return !path.isAbsolute(rel) && !path.win32.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..');
}

/**
 * Throws a ConfigError when `generate.ts.contexts` names a context the model does not have.
 * Only known once the model is analyzed, so `dt generate` calls it after checking.
 */
export function checkTsContexts(config: ResolvedConfig, contexts: readonly string[]): void {
    const unknown = [...new Set([...Object.keys(config.tsContexts), ...Object.keys(config.tsPolicies.contexts)])].filter((c) => !contexts.includes(c));
    if (unknown.length === 0) return;
    const where = config.file ?? 'config';
    throw new ConfigError(
        `${where}: 'generate.ts.contexts' names ${unknown.map((c) => `'${c}'`).join(', ')}, which ${unknown.length > 1 ? 'are not contexts' : 'is not a context'} of the model (contexts: ${contexts.join(', ') || 'none'}).`,
    );
}

/** Directories never scanned or watched. */
export const IGNORED_DIRS = new Set(['node_modules', '.git', '.domaintrail']);

/** Matches root-relative paths against `sources` (`!` patterns exclude). */
export function sourceMatcher(sources: readonly string[]): (relPath: string) => boolean {
    const glob = (s: string) => picomatch(s, { dot: true });
    const include = sources.filter((s) => !s.startsWith('!')).map(glob);
    const exclude = sources.filter((s) => s.startsWith('!')).map((s) => glob(s.slice(1)));
    return (rel) => {
        const p = rel.split(path.sep).join('/');
        if (p.split('/').some((seg) => IGNORED_DIRS.has(seg))) return false;
        return include.some((m) => m(p)) && !exclude.some((m) => m(p));
    };
}
