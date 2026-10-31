// `dt session subscribe --agent claude` (ADR 0026, S6): the subscriber of the session server running on the
// workspace, wired to its agent API (`.domaintrail/session/agent.json`), Claude Code, this CLI's `dt fmt`/`dt check`
// and the workspace's files.
import { lstat } from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { startSubscriber as subscribe, type Subscriber, type SubscriberEnd } from '@domaintrail/agent/application/subscriber';
import { createClaudeCodeRunner, type AgentCommand } from '@domaintrail/agent/infrastructure/claude-code';
import { createDtTools, type DtCommand } from '@domaintrail/agent/infrastructure/dt-tools';
import { createHttpAgentApi } from '@domaintrail/agent/infrastructure/http-agent-api';
import { scanWorkspace } from '@domaintrail/agent/infrastructure/workspace-scan';
import { randomNonce, systemClock } from '@domaintrail/agent/infrastructure/system';
import { AGENT_FILE, readAgentCredential, type AgentCredential } from '@domaintrail/collaboration/infrastructure/session-files';
import { SESSION_DIR } from '@domaintrail/collaboration/infrastructure/session-dir';
import { DEFAULT_SOURCES } from '@domaintrail/modeling/core/config';
import { SessionError } from '@domaintrail/presentation/cli/ports';
import { findDomainFiles } from '@domaintrail/workspace/infrastructure/files';
import { processAlive } from './process.js';

export type { SubscriberEnd };

/** The agents `dt session subscribe` can run. */
export const AGENTS = ['claude'] as const;
export type AgentName = (typeof AGENTS)[number];

export interface SubscriberOptions {
    root: string;
    sources?: readonly string[];
    respectGitignore?: boolean;
    /** The config file given with `-c`, passed on to `dt fmt` and `dt check`. */
    configPath?: string;
    agent: AgentName;
    /** Handle one run, then end. */
    once?: boolean;
    /** How `dt` is started for `dt fmt` and `dt check` (the CLI passes its own runtime and entry). */
    dt: DtCommand;
    log?: (line: string) => void;
    /** The agent's program instead of `claude` on the PATH: for the tests only, not a CLI option. */
    agentCommand?: AgentCommand;
    heartbeatMs?: number;
    reconnect?: { minMs: number; maxMs: number; giveUpMs: number };
}

export interface RunningSubscriber {
    session: string;
    /** Resolves when the subscriber ends. */
    done: Promise<SubscriberEnd>;
    /** Releases or fails (`Interrupted`) the run in hand and ends. */
    stop(): Promise<SubscriberEnd>;
}

/**
 * The credential of the session server running on the workspace. Refused (`SessionError`) when `agent.json` is
 * missing, a symbolic link, readable by others (not 0600), or written by a process that is gone.
 */
export async function readCredential(root: string): Promise<AgentCredential> {
    const file = path.join(path.resolve(root), SESSION_DIR, AGENT_FILE);
    const stat = await lstat(file).catch((e: unknown) => {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return undefined;
        throw e;
    });
    if (!stat) throw new SessionError('No session server is running for this workspace (start one with `dt session start`).');
    if (stat.isSymbolicLink() || !stat.isFile()) throw new SessionError(`${file} is not a plain file: refusing to read the agent credential through it.`);
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)
        throw new SessionError(`${file} must be private to you (mode 600), not ${(stat.mode & 0o777).toString(8)}: refusing the agent credential.`);
    const credential = await readAgentCredential(root);
    if (!credential) throw new SessionError(`${file} is not an agent credential.`);
    if (!processAlive(credential.pid))
        throw new SessionError('The session server that wrote the agent credential is no longer running (start one with `dt session start`).');
    return credential;
}

/** Subscribes to the session server running on the workspace at `options.root` and runs its agent runs. */
export async function startSubscriber(options: SubscriberOptions): Promise<RunningSubscriber> {
    const log = options.log ?? (() => {});
    const root = path.resolve(options.root);
    const credential = await readCredential(root);
    const api = createHttpAgentApi({ url: credential.url, token: credential.token });
    const session = await api.session().catch((e: unknown) => {
        throw new SessionError(`The session server's agent API does not answer (${e instanceof Error ? e.message : String(e)}).`);
    });
    if (!session.ok) throw new SessionError(`The session server refused the agent credential (${session.status} ${session.type}).`);
    if (session.value.session !== credential.session) throw new SessionError('The agent credential is not for the session the server runs.');
    if (session.value.state !== 'Open') throw new SessionError('The session is closed.');

    const sources = options.sources ?? DEFAULT_SOURCES;
    const respectGitignore = options.respectGitignore ?? true;
    const subscriber: Subscriber = subscribe(
        {
            api,
            runner: createClaudeCodeRunner({ root, command: options.agentCommand }),
            tools: createDtTools({ dt: options.dt, root, configPath: options.configPath, log }),
            workspace: {
                scan: () => scanWorkspace(root),
                sources: async () => new Set(await findDomainFiles(root, sources, respectGitignore)),
            },
            clock: systemClock,
            owner: `${options.agent}@${
                hostname()
                    .replace(/[^\x21-\x7e]/g, '-')
                    .slice(0, 100) || 'localhost'
            }`,
            nonce: randomNonce,
            log,
        },
        {
            allowedTools: session.value.allowedTools,
            leaseMs: session.value.leaseMs,
            once: options.once,
            heartbeatMs: options.heartbeatMs,
            reconnect: options.reconnect,
        },
    );
    return { session: session.value.session, done: subscriber.done, stop: () => subscriber.stop() };
}
