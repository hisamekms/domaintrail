// The sections `collab` and `agent` of domaintrail.jsonc (ADR 0026, ADR 0030) composed from their owners (ADR 0027,
// Project analysis and configuration): in `collab`, the app's port, host and connection guards (./server.ts) and
// Collaboration's identity mode and its Access settings, participant limit and quick reactions; in `agent`, the app's
// `port` (the agent API), the agent's roles (`run`, `answer`, `triage`) and Collaboration's `run.maxPreviousRunDiff`.
// Each section's unknown keys are checked here, with a hint for a key that was valid in the old `session` section.
import {
    AGENT_CONFIG_KEYS,
    type AgentConfigFile,
    type AnswerConfig,
    checkDtOutsideWorkspace,
    type ResolvedRunConfig,
    resolveAgentConfig,
    type TriageConfig,
    validateAgentConfig,
} from '@domaintrail/agent';
import {
    ACCESS_CHECKS,
    COLLABORATION_CONFIG_KEYS,
    type CollabConfigFile,
    type ResolvedCollaborationConfig,
    resolveCollaborationConfig,
    validateAccessNeeded,
    validateCollaborationConfig,
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
    validateCollabServerConfig,
} from './server.js';

/** The keys of `collab` and `agent` from their owners but the app (./server.ts), by where they sit in the file. */
export const COLLAB_AGENT_CONFIG_KEYS: readonly Readonly<Record<string, readonly string[]>>[] = [COLLABORATION_CONFIG_KEYS, AGENT_CONFIG_KEYS];

/** The `collab` section of the config file (`dt collab`, `dt collab link`). */
export interface CollabSectionFile extends Omit<CollabConfigFile, 'access'> {
    access?: NonNullable<CollabConfigFile['access']> & AccessGuardsConfigFile;
    /** Port of the session's page and API. Default: 4321. */
    port?: number;
    /** Address to bind. Default: 127.0.0.1; `dev` refuses anything but a loopback address. */
    host?: string;
}

/** The `agent` section of the config file: what `dt agent` (or the agent in process) and the agent API read. */
export interface AgentSectionFile extends AgentConfigFile {
    /** Port of the agent API, on 127.0.0.1 only. Default: 0 (any free port, written to `.domaintrail/session/agent.json`). */
    port?: number;
    run?: NonNullable<AgentConfigFile['run']> & { maxPreviousRunDiff?: number };
}

/** The `collab` section resolved: every default applied. */
export interface ResolvedCollabConfig {
    port: number;
    host: string;
    identity: ResolvedCollaborationConfig['identity'];
    access?: NonNullable<ResolvedCollaborationConfig['access']> & { allowedHosts: string[]; allowedOrigins: string[] };
    maxParticipants: number;
    /** In the form reactions are kept (`normalizeEmoji`). */
    quickReactions: string[];
}

/** The `agent` section resolved: every default applied. */
export interface ResolvedAgentSection {
    port: number;
    /** `dt`: the command (absolute paths) the agent's `dt` runs, when configured. */
    run: ResolvedRunConfig & { maxPreviousRunDiff: number };
    answer: AnswerConfig;
    triage: TriageConfig;
}

/** The order the keys of `collab.access` are checked in, Collaboration's and the app's together. */
const ACCESS_ORDER = ['teamDomain', 'audience', 'publicUrl', 'allowedHosts', 'acceptCookie', 'avatarHosts', 'allowedOrigins'];

/** Where a key of the old `session.agent` (or a run key put directly under `agent`) now goes. */
const RUN_KEYS = ['allowedTools', 'dt', 'maxPreviousRunDiff', 'warm', 'restartAfter', 'idleTimeout', 'model', 'effort'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why `at.key` is unknown, with where it goes when it was valid in the old `session` section. */
function unknownKey(at: string, key: string): string {
    const unknown = `unknown key '${at}.${key}'`;
    if (at === 'collab' && key === 'agent') return `${unknown}: the agent's settings are in the top-level 'agent' (agent.port, agent.run)`;
    if (at === 'collab' && key === 'classifier') return `${unknown}: the classifier is the top-level 'classifier'`;
    if (at === 'agent' && RUN_KEYS.includes(key)) return `${unknown}: it is a setting of the runner, 'agent.run.${key}'`;
    return unknown;
}

/** Checks the keys of `section` (an object) at `at` against the file's keys (composed). */
function checkKeys(section: Record<string, unknown>, at: string, keys: Readonly<Record<string, readonly string[]>>, fail: (msg: string) => never): void {
    for (const key of Object.keys(section)) if (!(keys[at] ?? []).includes(key)) fail(unknownKey(at, key));
}

/** Checks `collab` (`keys`: the file's keys, composed); `fail` throws. */
export function validateCollab(collab: unknown, keys: Readonly<Record<string, readonly string[]>>, fail: (msg: string) => never): void {
    if (!isObject(collab)) return fail("'collab' must be an object");
    checkKeys(collab, 'collab', keys, fail);
    validateCollabServerConfig(collab, fail);
    validateIdentityConfig(collab, fail);
    const access = collab.access;
    if (access !== undefined) {
        if (!isObject(access)) return fail("'collab.access' must be an object");
        checkKeys(access, 'collab.access', keys, fail);
        for (const key of ACCESS_ORDER) (ACCESS_CHECKS[key] ?? ACCESS_GUARD_CHECKS[key])(access, fail);
    }
    validateAccessNeeded(collab, fail);
    validateCollaborationConfig(collab, fail);
}

/** Checks `agent` (`keys`: the file's keys, composed); `fail` throws. */
export function validateAgent(agent: unknown, keys: Readonly<Record<string, readonly string[]>>, fail: (msg: string) => never): void {
    if (!isObject(agent)) return fail("'agent' must be an object");
    checkKeys(agent, 'agent', keys, fail);
    validateAgentApiConfig(agent, fail);
    for (const role of ['run', 'answer', 'triage']) {
        const part = agent[role];
        if (isObject(part)) checkKeys(part, `agent.${role}`, keys, fail);
    }
    validateAgentConfig(agent, fail);
    if (isObject(agent.run)) validatePreviousRunsConfig(agent.run, fail);
}

/** The check of `agent` that reads the disk, after the pure validation: the runner's `dt` lies outside `dir`. */
export function checkAgent(agent: AgentSectionFile | undefined, dir: string, fail: (msg: string) => never): void {
    checkDtOutsideWorkspace(agent?.run?.dt, dir, fail);
}

/** `collab` with its defaults (validated). */
export function resolveCollab(collab: CollabSectionFile = {}): ResolvedCollabConfig {
    const collaboration = resolveCollaborationConfig({ collab });
    const { access } = collaboration;
    return {
        port: collab.port ?? DEFAULT_PORT,
        host: collab.host ?? DEFAULT_HOST,
        identity: collaboration.identity,
        ...(access &&
            collab.access && {
                access: {
                    teamDomain: access.teamDomain,
                    audience: access.audience,
                    ...(access.publicUrl !== undefined && { publicUrl: access.publicUrl }),
                    ...resolveAccessGuards(collab.access),
                    acceptCookie: access.acceptCookie,
                    avatarHosts: access.avatarHosts,
                },
            }),
        maxParticipants: collaboration.maxParticipants,
        quickReactions: collaboration.quickReactions,
    };
}

/** `agent` with its defaults (validated); `dir` resolves the runner's `dt`. */
export function resolveAgent(agent: AgentSectionFile = {}, dir?: string): ResolvedAgentSection {
    const roles = resolveAgentConfig(agent, dir);
    return {
        port: agent.port ?? 0,
        run: { ...roles.run, maxPreviousRunDiff: resolveCollaborationConfig({ agent }).maxPreviousRunDiff },
        answer: roles.answer,
        triage: roles.triage,
    };
}
