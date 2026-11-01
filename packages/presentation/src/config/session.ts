// The `session` section of domaintrail.jsonc (ADR 0026) composed from its owners (ADR 0027, Project analysis and
// configuration): the app's ports and host (./server.ts), Collaboration's identity mode, participant limit, quick
// reactions, classifier and `agent.maxPreviousRunDiff`, the agent's `agent.allowedTools` and `agent.dt`. The checks run
// in the order they always had, so that the first error of a file is the one it always was.
import { AGENT_CONFIG_KEYS, type AgentConfigFile, checkDtOutsideWorkspace, resolveAgentConfig, validateAgentConfig } from '@domaintrail/agent';
import {
    COLLABORATION_CONFIG_KEYS,
    type CollaborationConfigFile,
    type ResolvedCollaborationConfig,
    resolveCollaborationConfig,
    validateCollaborationConfig,
    validateIdentityConfig,
    validatePreviousRunsConfig,
} from '@domaintrail/collaboration';
import { DEFAULT_HOST, DEFAULT_PORT, validateAgentApiConfig, validateSessionServerConfig } from './server.js';

/** The section's keys from its owners but the app (./server.ts), by where they sit in the file. */
export const SESSION_CONFIG_KEYS: readonly Readonly<Record<string, readonly string[]>>[] = [COLLABORATION_CONFIG_KEYS, AGENT_CONFIG_KEYS];

/** The `session` section of the config file. */
export interface SessionConfigFile extends Omit<CollaborationConfigFile, 'agent'> {
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
    access?: NonNullable<ResolvedCollaborationConfig['access']>;
    /** `dt`: the command (absolute paths) the agent's `dt` runs, when configured. */
    agent: { port: number; allowedTools: string[]; dt?: string[]; maxPreviousRunDiff: number };
    maxParticipants: number;
    /** In the form reactions are kept (`normalizeEmoji`). */
    quickReactions: string[];
    classifier: ResolvedCollaborationConfig['classifier'];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks the section (`keys`: the file's keys, composed); `fail` throws. */
export function validateSession(session: unknown, keys: Readonly<Record<string, readonly string[]>>, fail: (msg: string) => never): void {
    if (!isObject(session)) return fail("'session' must be an object");
    for (const key of Object.keys(session)) if (!keys.session.includes(key)) fail(`unknown key 'session.${key}'`);
    validateSessionServerConfig(session, fail);
    validateIdentityConfig(session, fail);
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
    return {
        port: session.port ?? DEFAULT_PORT,
        host: session.host ?? DEFAULT_HOST,
        identity: collaboration.identity,
        ...(collaboration.access && { access: collaboration.access }),
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
