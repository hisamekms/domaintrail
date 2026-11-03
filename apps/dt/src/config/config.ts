// domaintrail.jsonc as the app composes it (ADR 0027, Project analysis and configuration; ADR 0030, the sections): each
// owner defines the type, defaults and validation of its section — the analysis `sources`, the generation `generate`
// and `lintHint`, the app the ports and hosts (./server.ts: `open`), the owners of `collab` and `agent` (./collab.ts),
// Collaboration the `classifier` — and this module puts them together: the file's keys, its validation in a fixed
// order (the first error wins), the old sections `session` and `view` refused with where their keys went, and the
// resolved configuration. The workspace reads the file (`loadConfig`, given `CONFIG_FILE_FORMAT` by the composition)
// and knows none of the sections. The CLI and the language server read the resolved configuration and its errors.
import * as path from 'node:path';
import {
    type GenerationConfigFile,
    GENERATION_CONFIG_KEYS,
    type ResolvedGenerationConfig,
    resolveGenerationConfig,
    unknownTestsTypes,
    unknownTsContexts,
    validateGenerationConfig,
} from '@domaintrail/generation';
import { type ResolvedSourcesConfig, resolveSourcesConfig, type SourcesConfigFile, SOURCES_CONFIG_KEYS, validateSourcesConfig } from '@domaintrail/analysis';
import { type ClassifierConfigFile, resolveCollaborationConfig, type ResolvedCollaborationConfig, validateClassifierConfig } from '@domaintrail/collaboration';
import { type OpenConfigFile, resolveOpenConfig, SERVER_CONFIG_KEYS, validateOpenConfig } from './server.js';
import {
    type AgentSectionFile,
    checkAgent,
    COLLAB_AGENT_CONFIG_KEYS,
    type CollabSectionFile,
    type ResolvedAgentSection,
    type ResolvedCollabConfig,
    resolveAgent,
    resolveCollab,
    validateAgent,
    validateCollab,
} from './collab.js';

/** Config file names, in order of preference within one directory. */
export const CONFIG_FILES = ['domaintrail.jsonc', 'domaintrail.json'] as const;

/** The keys of domaintrail.jsonc, by where they sit (`''`: the top level; `*`: any key), from every section's owner. */
export const CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = mergeKeys([
    { '': ['$schema'] },
    SOURCES_CONFIG_KEYS,
    GENERATION_CONFIG_KEYS,
    SERVER_CONFIG_KEYS,
    ...COLLAB_AGENT_CONFIG_KEYS,
]);

function mergeKeys(parts: readonly Readonly<Record<string, readonly string[]>>[]): Record<string, readonly string[]> {
    const out: Record<string, string[]> = {};
    for (const part of parts) for (const [where, keys] of Object.entries(part)) (out[where] ??= []).push(...keys);
    return out;
}

/** Contents of domaintrail.jsonc / domaintrail.json. Paths are relative to the config file. */
export interface DomainTrailConfigFile extends SourcesConfigFile, GenerationConfigFile, OpenConfigFile {
    $schema?: string;
    /** Collaboration sessions (`dt collab`, ADR 0026, ADR 0030). */
    collab?: CollabSectionFile;
    /** The agent (`dt agent`, or in process): its API's port and its roles. */
    agent?: AgentSectionFile;
    /** The classifier of the addressed messages (Clef), called by the server in both modes. */
    classifier?: ClassifierConfigFile;
}

export type { ResolvedAgentSection, ResolvedCollabConfig };
export type ResolvedClassifierConfig = ResolvedCollaborationConfig['classifier'];

export interface ResolvedConfig extends ResolvedSourcesConfig, ResolvedGenerationConfig {
    /** Directory all paths are relative to: the config file's directory, or the given root. */
    root: string;
    /** Absolute path of the config file, if one was found. */
    file?: string;
    open: { port: number; host: string };
    collab: ResolvedCollabConfig;
    agent: ResolvedAgentSection;
    classifier: ResolvedClassifierConfig;
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
    checkAgent(config.agent, path.dirname(file), fail);
    return { root: path.dirname(file), file, ...resolved(config, path.dirname(file)) };
}

/** Every section with its defaults, in the order the resolved configuration always had. */
function resolved(config: DomainTrailConfigFile, dir?: string): Omit<ResolvedConfig, 'root' | 'file'> {
    return {
        ...resolveSourcesConfig(config),
        ...resolveGenerationConfig(config),
        open: resolveOpenConfig(config),
        collab: resolveCollab(config.collab),
        agent: resolveAgent(config.agent, dir),
        classifier: resolveCollaborationConfig({ classifier: config.classifier }).classifier,
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

/** Throws a ConfigError when `generate.ts.tests.types` names a type the model does not have (known after checking). */
export function checkTestsTypes(config: ResolvedConfig, types: readonly string[]): void {
    const wrong = unknownTestsTypes(config, types);
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
    for (const key of Object.keys(raw)) {
        if (key === 'session') fail(sessionRenamed(raw.session));
        if (key === 'view') fail(viewRenamed(raw.view));
        if (!CONFIG_KEYS[''].includes(key)) fail(`unknown key '${key}'`);
    }
    validateSourcesConfig(raw, fail);
    validateGenerationConfig(raw, fail);
    validateOpenConfig(raw, fail);
    if (raw.collab !== undefined) validateCollab(raw.collab, CONFIG_KEYS, fail);
    if (raw.agent !== undefined) validateAgent(raw.agent, CONFIG_KEYS, fail);
    validateClassifierConfig(raw.classifier, fail);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every key was checked above
    return raw as DomainTrailConfigFile;
}

/**
 * The error of the old `session` section (ADR 0030: no compatibility): where each of its keys went —
 * `session.agent.port` to `agent.port`, the other `session.agent.*` to `agent.run`, `session.classifier` to the
 * top-level `classifier`, the rest to `collab`.
 */
export function sessionRenamed(session: unknown): string {
    const moves: string[] = [];
    if (isObject(session)) {
        const rest = Object.keys(session).filter((k) => k !== 'agent' && k !== 'classifier');
        if (rest.length) moves.push(`${rest.map((k) => `session.${k}`).join(', ')} to collab`);
        const agent = session.agent;
        if (isObject(agent)) {
            for (const key of Object.keys(agent)) {
                if (key === 'port') moves.push('session.agent.port to agent.port');
                else if (key === 'run') moves.push('session.agent.run.* to agent.run');
                else moves.push(`session.agent.${key} to agent.run.${key}`);
            }
        } else if (agent !== undefined) moves.push('session.agent to agent (its port) and agent.run (the rest)');
        if (session.classifier !== undefined) moves.push('session.classifier to classifier');
    }
    return moves.length
        ? `'session' was renamed: move ${moves.join('; ')}`
        : "'session' was renamed: move session.agent.port to agent.port, the other session.agent.* to agent.run, session.classifier to classifier, the rest to collab";
}

/** The error of the old `view` section: it is `open` (as `dt view` is `dt open`). */
export function viewRenamed(view: unknown): string {
    const keys = isObject(view) ? Object.keys(view) : [];
    return keys.length ? `'view' was renamed to 'open': move ${keys.map((k) => `view.${k} to open.${k}`).join(', ')}` : "'view' was renamed to 'open'";
}
