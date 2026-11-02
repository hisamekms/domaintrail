// The `session` section of domaintrail.jsonc (ADR 0026) composed from its owners (ADR 0027, Project analysis and
// configuration): the app's ports, host and connection guards (./server.ts), Collaboration's identity mode and its
// Access settings, participant limit, quick
// reactions, classifier and `agent.maxPreviousRunDiff`, the agent's `agent.allowedTools`, `agent.dt` and `agent.run`. The checks run
// in the order they always had, so that the first error of a file is the one it always was.
import { AGENT_CONFIG_KEYS, type AgentConfigFile, checkDtOutsideWorkspace, resolveAgentConfig, type RunConfig, validateAgentConfig } from '@domaintrail/agent';
import {
    ACCESS_CHECKS,
    COLLABORATION_CONFIG_KEYS,
    type CollaborationConfigFile,
    type ResolvedCollaborationConfig,
    resolveCollaborationConfig,
    validateCollaborationConfig,
    validateAccessNeeded,
    validateIdentityConfig,
    validatePreviousRunsConfig,
} from '@domaintrail/collaboration';
import {
    ACCESS_GUARD_CHECKS,
    type AccessGuardsConfigFile,
    DEFAULT_HOST,
    DEFAULT_PORT,
    resolveAccessGuards,
    validateAgentApiConfig,
    validateSessionServerConfig,
} from './server.js';

/** The section's keys from its owners but the app (./server.ts), by where they sit in the file. */
export const SESSION_CONFIG_KEYS: readonly Readonly<Record<string, readonly string[]>>[] = [COLLABORATION_CONFIG_KEYS, AGENT_CONFIG_KEYS];

/** The `session` section of the config file. */
export interface SessionConfigFile extends Omit<CollaborationConfigFile, 'agent' | 'access'> {
    access?: NonNullable<CollaborationConfigFile['access']> & AccessGuardsConfigFile;
    /** Port of the session's page and API. Default: 4321. */
    port?: number;
    /** Address to bind. Default: 127.0.0.1; `dev` refuses anything but a loopback address. */
    host?: string;
    agent?: AgentConfigFile &
        NonNullable<CollaborationConfigFile['agent']> & {
            /** Port of the agent API, on 127.0.0.1 only. Default: 0 (any free port, written to `.domaintrail/session/agent.json`). */
            port?: number;
        };
}

/** The `session` section resolved: every default applied. */
export interface ResolvedSessionConfig {
    port: number;
    host: string;
    identity: ResolvedCollaborationConfig['identity'];
    access?: NonNullable<ResolvedCollaborationConfig['access']> & { allowedHosts: string[]; allowedOrigins: string[] };
    /** `dt`: the command (absolute paths) the agent's `dt` runs, when configured. */
    agent: { port: number; allowedTools: string[]; dt?: string[]; run: RunConfig; maxPreviousRunDiff: number };
    maxParticipants: number;
    /** In the form reactions are kept (`normalizeEmoji`). */
    quickReactions: string[];
    classifier: ResolvedCollaborationConfig['classifier'];
}

/** The order the keys of `session.access` are checked in, Collaboration's and the app's together. */
const ACCESS_ORDER = ['teamDomain', 'audience', 'publicUrl', 'allowedHosts', 'acceptCookie', 'avatarHosts', 'allowedOrigins'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks the section (`keys`: the file's keys, composed); `fail` throws. */
export function validateSession(session: unknown, keys: Readonly<Record<string, readonly string[]>>, fail: (msg: string) => never): void {
    if (!isObject(session)) return fail("'session' must be an object");
    for (const key of Object.keys(session)) if (!keys.session.includes(key)) fail(`unknown key 'session.${key}'`);
    validateSessionServerConfig(session, fail);
    validateIdentityConfig(session, fail);
    const access = session.access;
    if (access !== undefined) {
        if (!isObject(access)) return fail("'session.access' must be an object");
        for (const key of Object.keys(access)) if (!keys['session.access'].includes(key)) fail(`unknown key 'session.access.${key}'`);
        for (const key of ACCESS_ORDER) (ACCESS_CHECKS[key] ?? ACCESS_GUARD_CHECKS[key])(access, fail);
    }
    validateAccessNeeded(session, fail);
    const agent = session.agent;
    if (agent !== undefined) {
        if (!isObject(agent)) return fail("'session.agent' must be an object");
        for (const key of Object.keys(agent)) if (!keys['session.agent'].includes(key)) fail(`unknown key 'session.agent.${key}'`);
        validateAgentApiConfig(agent, fail);
        validateAgentConfig(agent, fail);
        validatePreviousRunsConfig(agent, fail);
    }
    validateCollaborationConfig(session, fail);
}

/** The check of the section that reads the disk, after the pure validation: the agent's `dt` lies outside `dir`. */
export function checkSession(session: SessionConfigFile | undefined, dir: string, fail: (msg: string) => never): void {
    checkDtOutsideWorkspace(session?.agent?.dt, dir, fail);
}

/** The section with its defaults (validated), in the order of keys it always had; `dir` resolves the agent's `dt`. */
export function resolveSession(session: SessionConfigFile = {}, dir?: string): ResolvedSessionConfig {
    const collaboration = resolveCollaborationConfig(session);
    const { access } = collaboration;
    return {
        port: session.port ?? DEFAULT_PORT,
        host: session.host ?? DEFAULT_HOST,
        identity: collaboration.identity,
        ...(access &&
            session.access && {
                access: {
                    teamDomain: access.teamDomain,
                    audience: access.audience,
                    ...(access.publicUrl !== undefined && { publicUrl: access.publicUrl }),
                    ...resolveAccessGuards(session.access),
                    acceptCookie: access.acceptCookie,
                    avatarHosts: access.avatarHosts,
                },
            }),
        agent: {
            port: session.agent?.port ?? 0,
            ...resolveAgentConfig(session.agent, dir),
            maxPreviousRunDiff: collaboration.maxPreviousRunDiff,
        },
        maxParticipants: collaboration.maxParticipants,
        quickReactions: collaboration.quickReactions,
        classifier: collaboration.classifier,
    };
}
