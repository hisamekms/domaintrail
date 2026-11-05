// Knowledge's settings in domaintrail.jsonc (ADR 0031; ADR 0027, Project analysis and configuration: each section's
// owner defines its type, defaults and validation): the top-level `knowledge` section — which store keeps the items
// (`files`, the default, or `cloudflare`, the Worker the user deploys; section 5), the project the workspace reads and
// writes (section 6), the Worker's URL, and the timing of the extraction (section 3, "all numbers are settings"). The
// app composes it with the other sections and reports the first error (`fail` throws).
//
// The Access service token the `cloudflare` store is reached with (section 8) is never in the file: it is read from the
// environment (`knowledgeCredentials`), so that a commit can neither leak nor replace it.
import { err, Knowledge, ok, type Result } from '../generated/index.js';

/** Where the items are kept (ADR 0031, section 5). */
export const KNOWLEDGE_STORES = ['files', 'cloudflare'] as const;
export type KnowledgeStoreKind = (typeof KNOWLEDGE_STORES)[number];
export const DEFAULT_KNOWLEDGE_STORE: KnowledgeStoreKind = 'files';

/** The project named when the workspace's directory gives no usable name. */
export const FALLBACK_PROJECT = 'workspace';

/** The timing of the extraction (ADR 0031, section 3) by default. */
export const DEFAULT_EXTRACTION: ResolvedExtractionConfig = {
    quietSeconds: 30,
    minIntervalSeconds: 60,
    contextMinutes: 10,
    settleSeconds: 120,
};

/** The environment variables holding the Access service token of the `cloudflare` store (never the config file). */
export const KNOWLEDGE_CLIENT_ID_ENV = 'DOMAINTRAIL_KNOWLEDGE_CLIENT_ID';
export const KNOWLEDGE_CLIENT_SECRET_ENV = 'DOMAINTRAIL_KNOWLEDGE_CLIENT_SECRET';

/** The request headers Cloudflare Access reads a service token from. */
export const ACCESS_SERVICE_TOKEN_HEADERS = { clientId: 'CF-Access-Client-Id', clientSecret: 'CF-Access-Client-Secret' } as const;

/** Knowledge's keys, by where they sit in the file. */
export const KNOWLEDGE_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = {
    '': ['knowledge'],
    knowledge: ['store', 'project', 'url', 'extraction'],
    'knowledge.extraction': ['quietSeconds', 'minIntervalSeconds', 'contextMinutes', 'settleSeconds'],
};

/** The `knowledge` section of the config file. */
export interface KnowledgeConfigFile {
    /** `files` (one Markdown file per item in the workspace's `knowledge/`) or `cloudflare` (the Worker). Default: `files`. */
    store?: KnowledgeStoreKind;
    /**
     * The project whose knowledge this workspace reads and writes: lowercase letters, digits and `-`, 63 characters at
     * most. Required with `cloudflare`, so that every clone and worktree names the same one; with `files`, by default
     * the workspace's directory name made into one (its files are the workspace's own whatever the name).
     */
    project?: string;
    /** The Worker's base URL (https; http only on a loopback host), required with `cloudflare`, unused with `files`. */
    url?: string;
    /** When the knowledge is extracted from the talk. */
    extraction?: ExtractionConfigFile;
}

/** `knowledge.extraction`: every number optional. */
export interface ExtractionConfigFile {
    /** Seconds without a message after a person's message before an extraction. Default: 30. */
    quietSeconds?: number;
    /** The fewest seconds between two extractions of a session. Default: 60. */
    minIntervalSeconds?: number;
    /** Minutes of the talk before the new messages given to the extraction as context. Default: 10. */
    contextMinutes?: number;
    /** Seconds of quiet on a topic after which a held update or conflict applies. Default: 120. */
    settleSeconds?: number;
}

/** `knowledge.extraction` resolved. */
export interface ResolvedExtractionConfig {
    readonly quietSeconds: number;
    readonly minIntervalSeconds: number;
    readonly contextMinutes: number;
    readonly settleSeconds: number;
}

/** The `knowledge` section resolved: every default applied, by store. */
export type ResolvedKnowledgeConfig =
    | {
          readonly store: 'files';
          readonly project: Knowledge.ProjectName;
          /** Whether the project was named in the file, or taken from the workspace's directory name. */
          readonly projectFrom: 'config' | 'workspace';
          readonly extraction: ResolvedExtractionConfig;
      }
    | {
          readonly store: 'cloudflare';
          readonly project: Knowledge.ProjectName;
          readonly projectFrom: 'config';
          /** The Worker's base URL, without a trailing `/`. */
          readonly url: string;
          readonly extraction: ResolvedExtractionConfig;
      };

/** The Access service token of the `cloudflare` store, from the environment. */
export interface KnowledgeCredentials {
    readonly clientId: string;
    readonly clientSecret: string;
}

/** The environment variables of the service token that are missing or empty. */
export interface MissingKnowledgeCredentials {
    readonly type: 'MissingKnowledgeCredentials';
    readonly missing: readonly string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** Whether `url` can be the Worker's base URL: https (http on a loopback host only), no credentials, query or fragment. */
export function isStoreUrl(url: string): boolean {
    if (!URL.canParse(url)) return false;
    const u = new URL(url);
    const scheme = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.includes(u.hostname));
    return scheme && !u.username && !u.password && !u.search && !u.hash;
}

/** Checks the top-level `knowledge` (any value: absent is fine); the first error wins. */
export function validateKnowledgeConfig(knowledge: unknown, fail: (msg: string) => never): void {
    if (knowledge === undefined) return;
    if (!isObject(knowledge)) return fail("'knowledge' must be an object");
    for (const key of Object.keys(knowledge)) if (!KNOWLEDGE_CONFIG_KEYS.knowledge.includes(key)) fail(`unknown key 'knowledge.${key}'`);
    if (knowledge.store !== undefined && !(KNOWLEDGE_STORES as readonly unknown[]).includes(knowledge.store))
        fail(`'knowledge.store' must be one of ${KNOWLEDGE_STORES.map((s) => `'${s}'`).join(', ')}`);
    if (knowledge.project !== undefined && (typeof knowledge.project !== 'string' || Knowledge.checkProjectName(knowledge.project).length > 0))
        fail("'knowledge.project' must be a project name: lowercase letters, digits and '-', starting with a letter or digit, 63 characters at most");
    if (knowledge.url !== undefined && (typeof knowledge.url !== 'string' || !isStoreUrl(knowledge.url)))
        fail("'knowledge.url' must be the Worker's https URL, like 'https://knowledge.example.com' (http only on localhost)");
    const extraction = knowledge.extraction;
    if (extraction !== undefined) {
        if (!isObject(extraction)) return fail("'knowledge.extraction' must be an object");
        for (const key of Object.keys(extraction))
            if (!KNOWLEDGE_CONFIG_KEYS['knowledge.extraction'].includes(key)) fail(`unknown key 'knowledge.extraction.${key}'`);
        const units: Record<keyof ExtractionConfigFile, string> = {
            quietSeconds: 'seconds',
            minIntervalSeconds: 'seconds',
            contextMinutes: 'minutes',
            settleSeconds: 'seconds',
        };
        for (const [key, unit] of Object.entries(units)) {
            const value = extraction[key];
            if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value) && value >= 0))
                fail(`'knowledge.extraction.${key}' must be a non-negative number (${unit})`);
        }
    }
    if (knowledge.store === 'cloudflare') {
        if (knowledge.project === undefined)
            fail("'knowledge.store' \"cloudflare\" needs 'knowledge.project': the project every clone and worktree of this workspace shares");
        if (knowledge.url === undefined) fail("'knowledge.store' \"cloudflare\" needs 'knowledge.url': the Worker's URL");
    }
}

/**
 * The project named after a workspace's directory name (`dir`: its base name): lowercased, every run of other
 * characters than letters and digits made one `-`, without a leading or trailing `-`, 63 characters at most;
 * `FALLBACK_PROJECT` when nothing is left (`.`, `日本語`).
 */
export function projectFromDirName(dir: string): Knowledge.ProjectName {
    const slug = dir
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+/, '')
        .slice(0, 63)
        .replace(/-+$/, '');
    const made = Knowledge.makeProjectName(slug || FALLBACK_PROJECT);
    // FALLBACK_PROJECT is a project name, and so is any non-empty slug of this alphabet and length
    return made.ok ? made.value : projectFromDirName(FALLBACK_PROJECT);
}

/**
 * `knowledge` with its defaults (validated). `workspaceDir` is the base name of the workspace's directory: the project
 * of `files` when the file names none.
 */
export function resolveKnowledgeConfig(knowledge: KnowledgeConfigFile = {}, workspaceDir: string): ResolvedKnowledgeConfig {
    const extraction: ResolvedExtractionConfig = { ...DEFAULT_EXTRACTION, ...knowledge.extraction };
    const named = knowledge.project === undefined ? undefined : Knowledge.makeProjectName(knowledge.project);
    if (named !== undefined && !named.ok) throw new Error(`knowledge.project not validated: '${knowledge.project}'`);
    if ((knowledge.store ?? DEFAULT_KNOWLEDGE_STORE) === 'cloudflare') {
        if (named === undefined || knowledge.url === undefined) throw new Error("knowledge not validated: 'cloudflare' needs a project and a url");
        return { store: 'cloudflare', project: named.value, projectFrom: 'config', url: knowledge.url.replace(/\/+$/, ''), extraction };
    }
    return named
        ? { store: 'files', project: named.value, projectFrom: 'config', extraction }
        : { store: 'files', project: projectFromDirName(workspaceDir), projectFrom: 'workspace', extraction };
}

/**
 * The `cloudflare` store's Access service token from the environment (`env`: `process.env`, given by the caller):
 * `KNOWLEDGE_CLIENT_ID_ENV` and `KNOWLEDGE_CLIENT_SECRET_ENV`, both set and non-empty, else the ones missing. Sent as
 * the headers of `ACCESS_SERVICE_TOKEN_HEADERS`. The session's dt holds the token that writes, `dt mcp` the one that
 * reads (ADR 0031, section 8): which one is the environment's choice.
 */
export function knowledgeCredentials(env: Readonly<Record<string, string | undefined>>): Result<KnowledgeCredentials, MissingKnowledgeCredentials> {
    const clientId = env[KNOWLEDGE_CLIENT_ID_ENV]?.trim();
    const clientSecret = env[KNOWLEDGE_CLIENT_SECRET_ENV]?.trim();
    if (clientId && clientSecret) return ok({ clientId, clientSecret });
    const missing = [...(clientId ? [] : [KNOWLEDGE_CLIENT_ID_ENV]), ...(clientSecret ? [] : [KNOWLEDGE_CLIENT_SECRET_ENV])];
    return err({ type: 'MissingKnowledgeCredentials', missing });
}

/** The message of missing credentials, one line: what to set. */
export function missingCredentialsMessage(missing: MissingKnowledgeCredentials): string {
    return `the knowledge store 'cloudflare' needs an Access service token: set ${missing.missing.join(' and ')}`;
}
