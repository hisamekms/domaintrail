// domaintrail.jsonc as the app composes it (ADR 0027, Project analysis and configuration): each owner defines the type,
// defaults and validation of its section — the analysis `sources`, the generation `generate` and `lintHint`, the app
// the ports and hosts (./server.ts), the session's owners the `session` section (./session.ts) — and this module puts
// them together: the file's keys, its validation in a fixed order (the first error wins, as it always did), and the
// resolved configuration. The workspace reads the file (`loadConfig`, given `CONFIG_FILE_FORMAT` by the composition)
// and knows none of the sections. Here until presentation and composition merge into apps/dt (T8): the CLI and the
// language server read the resolved configuration and its errors, and an app imports no other app.
import * as path from 'node:path';
import {
    type GenerationConfigFile,
    GENERATION_CONFIG_KEYS,
    type ResolvedGenerationConfig,
    type ResolvedSourcesConfig,
    resolveGenerationConfig,
    resolveSourcesConfig,
    type SourcesConfigFile,
    SOURCES_CONFIG_KEYS,
    unknownTsContexts,
    validateGenerationConfig,
    validateSourcesConfig,
} from '@domaintrail/modeling';
import { resolveViewConfig, SERVER_CONFIG_KEYS, validateViewConfig, type ViewConfigFile } from './server.js';
import { checkSession, type ResolvedSessionConfig, resolveSession, SESSION_CONFIG_KEYS, type SessionConfigFile, validateSession } from './session.js';

/** Config file names, in order of preference within one directory. */
export const CONFIG_FILES = ['domaintrail.jsonc', 'domaintrail.json'] as const;

/** The keys of domaintrail.jsonc, by where they sit (`''`: the top level; `*`: any key), from every section's owner. */
export const CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = mergeKeys([
    { '': ['$schema'] },
    SOURCES_CONFIG_KEYS,
    GENERATION_CONFIG_KEYS,
    SERVER_CONFIG_KEYS,
    ...SESSION_CONFIG_KEYS,
]);

function mergeKeys(parts: readonly Readonly<Record<string, readonly string[]>>[]): Record<string, readonly string[]> {
    const out: Record<string, string[]> = {};
    for (const part of parts) for (const [where, keys] of Object.entries(part)) (out[where] ??= []).push(...keys);
    return out;
}

/** Contents of domaintrail.jsonc / domaintrail.json. Paths are relative to the config file. */
export interface DomainTrailConfigFile extends SourcesConfigFile, GenerationConfigFile, ViewConfigFile {
    $schema?: string;
    /** Collaboration sessions (`dt session start`, ADR 0026). */
    session?: SessionConfigFile;
}

export type { ResolvedSessionConfig };

export interface ResolvedConfig extends ResolvedSourcesConfig, ResolvedGenerationConfig {
    /** Directory all paths are relative to: the config file's directory, or the given root. */
    root: string;
    /** Absolute path of the config file, if one was found. */
    file?: string;
    view: { port: number; host: string };
    session: ResolvedSessionConfig;
}

export class ConfigError extends Error {}

/** The configuration without a config file: the defaults, rooted at `root`. */
export function defaultConfig(root: string): ResolvedConfig {
    return { root: path.resolve(root), ...resolved({}) };
}

/**
 * Resolves the contents of the config file `file` (an absolute path): its directory is the root. Throws a ConfigError
 * when they are not valid. Reading the file is the workspace's (`loadConfig`).
 */
export function resolveConfig(text: string, file: string): ResolvedConfig {
    const fail = (msg: string): never => {
        throw new ConfigError(`${file}: ${msg}`);
    };
    const config = validate(parseJsonc(text, file), fail);
    // the only check that reads the disk (the agent's adapter: symbolic links), after the pure validation
    checkSession(config.session, path.dirname(file), fail);
    return { root: path.dirname(file), file, ...resolved(config, path.dirname(file)) };
}

/** Every section with its defaults, in the order the resolved configuration always had. */
function resolved(config: DomainTrailConfigFile, dir?: string): Omit<ResolvedConfig, 'root' | 'file'> {
    return {
        ...resolveSourcesConfig(config),
        ...resolveGenerationConfig(config),
        view: resolveViewConfig(config),
        session: resolveSession(config.session, dir),
    };
}

/** The file to read and how: what the composition gives the workspace's `loadConfig`. */
export const CONFIG_FILE_FORMAT = {
    files: CONFIG_FILES,
    resolve: resolveConfig,
    defaults: defaultConfig,
    notFound: (configPath: string): Error => new ConfigError(`Config file not found: ${configPath}`),
};

/**
 * Throws a ConfigError when `generate.ts.contexts` names a context the model does not have.
 * Only known once the model is analyzed, so `dt generate` calls it after checking.
 */
export function checkTsContexts(config: ResolvedConfig, contexts: readonly string[]): void {
    const wrong = unknownTsContexts(config, contexts);
    if (wrong !== undefined) throw new ConfigError(`${config.file ?? 'config'}: ${wrong}`);
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

/** The sections' checks in the order of the file's documentation: the first error is the one reported. */
function validate(raw: unknown, fail: (msg: string) => never): DomainTrailConfigFile {
    if (!isObject(raw)) return fail('expected an object');
    for (const key of Object.keys(raw)) if (!CONFIG_KEYS[''].includes(key)) fail(`unknown key '${key}'`);
    validateSourcesConfig(raw, fail);
    validateGenerationConfig(raw, fail);
    validateViewConfig(raw, fail);
    if (raw.session !== undefined) validateSession(raw.session, CONFIG_KEYS, fail);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every key was checked above
    return raw as DomainTrailConfigFile;
}
