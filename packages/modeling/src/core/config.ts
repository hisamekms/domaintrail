import * as path from 'node:path';
import picomatch from 'picomatch';
import { RUNNERS, type Runner } from '../generator/tests.js';
import { POLICY_MODES, type PolicyMode } from '../generator/typescript.js';

/** Config file names, in order of preference within one directory. */
export const CONFIG_FILES = ['domaintrail.jsonc', 'domaintrail.json'] as const;

export const DEFAULT_SOURCES = ['**/*.dt', '**/*.dtes'];
export const DEFAULT_TS_OUT = 'generated/domain';
export const DEFAULT_PORT = 4321;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_POLICIES: PolicyMode = 'optional';

/** How the participants of a session prove who they are (ADR 0026): explicit, never inferred from headers. */
export const SESSION_IDENTITIES = ['dev', 'access'] as const;
export type SessionIdentity = (typeof SESSION_IDENTITIES)[number];
/**
 * The tools the agent of a session may use unless the facilitator chooses others (ADR 0026), as Claude Code permission
 * rules: reading, editing and writing files, finding them, and `dt fmt` and `dt check`.
 */
export const DEFAULT_AGENT_TOOLS: readonly string[] = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(dt fmt:*)', 'Bash(dt check:*)'];
export const DEFAULT_MAX_PARTICIPANTS = 50;

/** Contents of domaintrail.jsonc / domaintrail.json. Paths are relative to the config file. */
export interface DomainTrailConfigFile {
    $schema?: string;
    /** Globs of DSL files (`.dt` and `.dtes`); `!pattern` excludes. Default: `**\/*.dt`, `**\/*.dtes`. */
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
    /** Collaboration sessions (`dt session start`, ADR 0026). */
    session?: SessionConfigFile;
}

/** The `session` section of the config file. */
export interface SessionConfigFile {
    /** Port of the session's page and API. Default: 4321. */
    port?: number;
    /** Address to bind. Default: 127.0.0.1; `dev` refuses anything but a loopback address. */
    host?: string;
    /** `dev` (loopback only, a name picked on the first visit) or `access` (Cloudflare Access). Default: `dev`. */
    identity?: SessionIdentity;
    /** Cloudflare Access, required with `identity: "access"`. */
    access?: {
        /** `<team>.cloudflareaccess.com`: the issuer of the tokens. */
        teamDomain: string;
        /** The Access application's audience tag (AUD). */
        audience: string;
        /** The public URL of the session (the tunnel's). Not used to allow anything: its host and origin must also be in `allowedHosts` and `allowedOrigins`. */
        publicUrl?: string;
        /** Host names the server answers to besides loopback. Default: none. */
        allowedHosts?: string[];
        /** Origins (`https://host[:port]`) whose pages may call the server besides loopback. Default: none. */
        allowedOrigins?: string[];
        /** Whether the `CF_Authorization` cookie is accepted when the `Cf-Access-Jwt-Assertion` header is absent. Default: false. */
        acceptCookie?: boolean;
        /** Hosts an avatar (the identity's `https` picture) may come from. Default: none, the page shows initials. */
        avatarHosts?: string[];
    };
    agent?: {
        /** Port of the agent API, on 127.0.0.1 only. Default: 0 (any free port, written to `.domaintrail/session/agent.json`). */
        port?: number;
        /** The tools the agent may use, as Claude Code permission rules. Default: `DEFAULT_AGENT_TOOLS`. */
        allowedTools?: string[];
    };
    /** Most participants a session admits. Default: 50. */
    maxParticipants?: number;
}

/** The `session` section resolved: every default applied. */
export interface ResolvedSessionConfig {
    port: number;
    host: string;
    identity: SessionIdentity;
    access?: {
        teamDomain: string;
        audience: string;
        publicUrl?: string;
        allowedHosts: string[];
        allowedOrigins: string[];
        acceptCookie: boolean;
        avatarHosts: string[];
    };
    agent: { port: number; allowedTools: string[] };
    maxParticipants: number;
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
    session: ResolvedSessionConfig;
}

export class ConfigError extends Error {}

/** The configuration without a config file: the defaults, rooted at `root`. */
export function defaultConfig(root: string): ResolvedConfig {
    return { root: path.resolve(root), ...defaults() };
}

/**
 * Resolves the contents of the config file `file` (an absolute path): its directory is the root. Throws a ConfigError
 * when they are not valid. Reading the file is the workspace's (`loadConfig`).
 */
export function resolveConfig(text: string, file: string): ResolvedConfig {
    const raw = parseJsonc(text, file);
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
        session: resolveSession(config.session),
    };
}

function resolveSession(session: SessionConfigFile | undefined): ResolvedSessionConfig {
    const access = session?.access;
    return {
        port: session?.port ?? DEFAULT_PORT,
        host: session?.host ?? DEFAULT_HOST,
        identity: session?.identity ?? 'dev',
        ...(access && {
            access: {
                teamDomain: access.teamDomain,
                audience: access.audience,
                ...(access.publicUrl !== undefined && { publicUrl: access.publicUrl }),
                allowedHosts: access.allowedHosts ?? [],
                allowedOrigins: access.allowedOrigins ?? [],
                acceptCookie: access.acceptCookie ?? false,
                avatarHosts: access.avatarHosts ?? [],
            },
        }),
        agent: { port: session?.agent?.port ?? 0, allowedTools: session?.agent?.allowedTools ?? [...DEFAULT_AGENT_TOOLS] },
        maxParticipants: session?.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,
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
        session: resolveSession(undefined),
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
        if (!['$schema', 'sources', 'respectGitignore', 'lintHint', 'generate', 'view', 'session'].includes(key)) fail(`unknown key '${key}'`);
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
    if (c.session !== undefined) validateSession(c.session, fail);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every key was checked above
    return c as DomainTrailConfigFile;
}

const isPort = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535;
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');

function validateSession(session: unknown, fail: (msg: string) => never): void {
    if (!isObject(session)) return fail("'session' must be an object");
    for (const key of Object.keys(session)) {
        if (!['port', 'host', 'identity', 'access', 'agent', 'maxParticipants'].includes(key)) fail(`unknown key 'session.${key}'`);
    }
    if (session.port !== undefined && !isPort(session.port)) fail("'session.port' must be a port number");
    if (session.host !== undefined && (typeof session.host !== 'string' || !session.host)) fail("'session.host' must be a string");
    if (session.identity !== undefined && !(SESSION_IDENTITIES as readonly unknown[]).includes(session.identity))
        fail(`'session.identity' must be one of ${SESSION_IDENTITIES.map((m) => `'${m}'`).join(', ')}`);
    const access = session.access;
    if (access !== undefined) {
        if (!isObject(access)) return fail("'session.access' must be an object");
        for (const key of Object.keys(access)) {
            if (!['teamDomain', 'audience', 'publicUrl', 'allowedHosts', 'allowedOrigins', 'acceptCookie', 'avatarHosts'].includes(key))
                fail(`unknown key 'session.access.${key}'`);
        }
        if (typeof access.teamDomain !== 'string' || !access.teamDomain.trim()) fail("'session.access.teamDomain' must be a non-empty string");
        if (!/^(https:\/\/)?[a-z0-9.-]+\/?$/i.test(access.teamDomain))
            fail(`'session.access.teamDomain' must be a host name like '<team>.cloudflareaccess.com': '${access.teamDomain}'`);
        if (typeof access.audience !== 'string' || !access.audience.trim()) fail("'session.access.audience' must be a non-empty string");
        if (access.publicUrl !== undefined && (typeof access.publicUrl !== 'string' || !URL.canParse(access.publicUrl)))
            fail("'session.access.publicUrl' must be a URL");
        if (access.allowedHosts !== undefined) {
            if (!isStringList(access.allowedHosts)) return fail("'session.access.allowedHosts' must be an array of host names");
            for (const h of access.allowedHosts) if (!/^[a-z0-9.-]+$/i.test(h)) fail(`'session.access.allowedHosts' must hold host names only: '${h}'`);
        }
        if (access.acceptCookie !== undefined && typeof access.acceptCookie !== 'boolean') fail("'session.access.acceptCookie' must be a boolean");
        if (access.avatarHosts !== undefined) {
            if (!isStringList(access.avatarHosts)) return fail("'session.access.avatarHosts' must be an array of host names");
            for (const h of access.avatarHosts) if (!/^[a-z0-9.-]+$/i.test(h)) fail(`'session.access.avatarHosts' must hold host names only: '${h}'`);
        }
        if (access.allowedOrigins !== undefined) {
            if (!isStringList(access.allowedOrigins)) return fail("'session.access.allowedOrigins' must be an array of origins");
            for (const o of access.allowedOrigins) {
                const origin = URL.canParse(o) ? new URL(o) : undefined;
                if (!origin || !['http:', 'https:'].includes(origin.protocol) || origin.origin !== o)
                    fail(`'session.access.allowedOrigins' must hold origins like 'https://example.com': '${o}'`);
            }
        }
    }
    if (session.identity === 'access' && access === undefined) fail("'session.identity' \"access\" needs 'session.access' with 'teamDomain' and 'audience'");
    const agent = session.agent;
    if (agent !== undefined) {
        if (!isObject(agent)) return fail("'session.agent' must be an object");
        for (const key of Object.keys(agent)) if (!['port', 'allowedTools'].includes(key)) fail(`unknown key 'session.agent.${key}'`);
        if (agent.port !== undefined && !isPort(agent.port)) fail("'session.agent.port' must be a port number");
        if (agent.allowedTools !== undefined && !isStringList(agent.allowedTools)) fail("'session.agent.allowedTools' must be an array of tool rules");
    }
    if (
        session.maxParticipants !== undefined &&
        !(typeof session.maxParticipants === 'number' && Number.isInteger(session.maxParticipants) && session.maxParticipants >= 1)
    )
        fail("'session.maxParticipants' must be a positive integer");
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
