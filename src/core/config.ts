import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import picomatch from 'picomatch';

/** Config file names, in order of preference within one directory. */
export const CONFIG_FILES = ['domaintrail.jsonc', 'domaintrail.json'] as const;

export const DEFAULT_SOURCES = ['**/*.dt'];
export const DEFAULT_TS_OUT = 'generated/domain';
export const DEFAULT_PORT = 4321;
export const DEFAULT_HOST = '127.0.0.1';

/** Contents of domaintrail.jsonc / domaintrail.json. Paths are relative to the config file. */
export interface DomainTrailConfigFile {
    $schema?: string;
    /** Globs of DSL files; `!pattern` excludes. Default: `**\/*.dt`. */
    sources?: string[];
    generate?: { ts?: { out?: string; contexts?: Record<string, { out: string }> } };
    view?: { port?: number; host?: string };
}

export interface ResolvedConfig {
    /** Directory all paths are relative to: the config file's directory, or the given root. */
    root: string;
    /** Absolute path of the config file, if one was found. */
    file?: string;
    sources: string[];
    tsOut: string;
    /** Output directories of contexts written elsewhere than `tsOut`, by context name. */
    tsContexts: Record<string, string>;
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
        tsOut: config.generate?.ts?.out ?? DEFAULT_TS_OUT,
        tsContexts: Object.fromEntries(Object.entries(config.generate?.ts?.contexts ?? {}).map(([ctx, c]) => [ctx, c.out])),
        view: { port: config.view?.port ?? DEFAULT_PORT, host: config.view?.host ?? DEFAULT_HOST },
    };
}

function defaults(): Omit<ResolvedConfig, 'root' | 'file'> {
    return { sources: DEFAULT_SOURCES, tsOut: DEFAULT_TS_OUT, tsContexts: {}, view: { port: DEFAULT_PORT, host: DEFAULT_HOST } };
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
        throw new ConfigError(`${file}: invalid JSON: ${(e as Error).message}`);
    }
}

function validate(raw: unknown, file: string): DomainTrailConfigFile {
    const fail = (msg: string): never => {
        throw new ConfigError(`${file}: ${msg}`);
    };
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('expected an object');
    const c = raw as Record<string, unknown>;
    for (const key of Object.keys(c)) {
        if (!['$schema', 'sources', 'generate', 'view'].includes(key)) fail(`unknown key '${key}'`);
    }
    if (c.sources !== undefined && (!Array.isArray(c.sources) || c.sources.some((s) => typeof s !== 'string'))) {
        fail("'sources' must be an array of glob strings");
    }
    if (Array.isArray(c.sources) && !c.sources.some((s) => !String(s).startsWith('!'))) fail("'sources' needs at least one include pattern");
    for (const s of (c.sources as string[] | undefined) ?? []) {
        if (s.replace(/^!/, '').split('/').includes('..') || path.isAbsolute(s.replace(/^!/, ''))) {
            fail(`'sources' must stay inside the directory of the config file: '${s}'`);
        }
    }
    const gen = c.generate as Record<string, unknown> | undefined;
    if (gen !== undefined) {
        if (typeof gen !== 'object' || gen === null) fail("'generate' must be an object");
        for (const key of Object.keys(gen!)) if (key !== 'ts') fail(`unknown generator 'generate.${key}' (supported: ts)`);
        const ts = gen!.ts as Record<string, unknown> | undefined;
        if (ts !== undefined && (typeof ts !== 'object' || ts === null || Array.isArray(ts))) fail("'generate.ts' must be an object");
        for (const key of Object.keys(ts ?? {})) if (!['out', 'contexts'].includes(key)) fail(`unknown key 'generate.ts.${key}'`);
        checkOut(ts?.out, 'generate.ts.out', fail);
        const contexts = ts?.contexts;
        if (contexts !== undefined) {
            if (typeof contexts !== 'object' || contexts === null || Array.isArray(contexts)) fail("'generate.ts.contexts' must be an object keyed by context name");
            for (const [ctx, c] of Object.entries(contexts as Record<string, unknown>)) {
                const key = `generate.ts.contexts.${ctx}`;
                if (typeof c !== 'object' || c === null || Array.isArray(c)) fail(`'${key}' must be an object`);
                for (const k of Object.keys(c as object)) if (k !== 'out') fail(`unknown key '${key}.${k}'`);
                if ((c as Record<string, unknown>).out === undefined) fail(`'${key}.out' is required`);
                checkOut((c as Record<string, unknown>).out, `${key}.out`, fail);
            }
        }
    }
    const view = c.view as Record<string, unknown> | undefined;
    if (view !== undefined) {
        if (typeof view !== 'object' || view === null) fail("'view' must be an object");
        if (view!.port !== undefined && (!Number.isInteger(view!.port) || (view!.port as number) < 0)) fail("'view.port' must be a port number");
        if (view!.host !== undefined && typeof view!.host !== 'string') fail("'view.host' must be a string");
    }
    return c as DomainTrailConfigFile;
}

/** An output directory: a string inside the directory of the config file. */
function checkOut(out: unknown, key: string, fail: (msg: string) => never): void {
    if (out === undefined) return;
    if (typeof out !== 'string') fail(`'${key}' must be a string`);
    if (path.isAbsolute(out as string) || (out as string).split(/[\\/]/).includes('..')) {
        fail(`'${key}' must stay inside the directory of the config file: '${out}'`);
    }
}

/**
 * Throws a ConfigError when `generate.ts.contexts` names a context the model does not have.
 * Only known once the model is analyzed, so `dt generate` calls it after checking.
 */
export function checkTsContexts(config: ResolvedConfig, contexts: readonly string[]): void {
    const unknown = Object.keys(config.tsContexts).filter((c) => !contexts.includes(c));
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
