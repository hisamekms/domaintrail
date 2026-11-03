// `dt agent` (ADR 0026, S6; ADR 0030), and the agent `dt open` and `dt collab` start in process over the same loopback
// HTTP: the subscriber of the session server running on the workspace, wired to its agent API (its credential in memory:
// handed over by the server in process, or paired for with a one-time code), Claude Code (a warm process across runs, or
// one per run: `agent.run`), `dt fmt`/`dt check` (this CLI, or `agent.run.dt`, for the agent too) and the
// workspace's files.
import { hostname } from 'node:os';
import * as path from 'node:path';
import {
    type AgentCommand,
    type AgentRunner,
    createClaudeCodeRunner,
    createDtTools,
    createWarmClaudeRunner,
    createHttpAgentApi,
    type DtCommand,
    dtCommandOf,
    pinDt,
    type PinnedDt,
    randomNonce,
    type RunConfig,
    scanWorkspace,
    startSubscriber as subscribe,
    type Subscriber,
    type SubscriberEnd,
    systemClock,
} from '@domaintrail/agent';
import { type AgentCredential, readServerAddress } from '@domaintrail/collaboration';
import { DEFAULT_SOURCES, sourceSelection } from '@domaintrail/analysis';
import { SessionError } from '../cli/ports.js';
import { findDomainFiles } from '@domaintrail/workspace';
import { processAlive } from './process.js';

export type { SubscriberEnd };

/** The agents `dt agent` can run. */
export const AGENTS = ['claude'] as const;
export type AgentName = (typeof AGENTS)[number];

/**
 * The roles of an agent (ADR 0030, decision 21): the read-only answerer (the triage's stage 3, answers, proposals) and
 * the runner (the runs). `dt agent` holds both unless `--role` names one.
 */
export const AGENT_ROLES = ['answer', 'run'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface SubscriberOptions {
    root: string;
    sources?: readonly string[];
    respectGitignore?: boolean;
    /** The config file given with `-c`, passed on to `dt fmt` and `dt check`. */
    configPath?: string;
    agent: AgentName;
    /**
     * How to reach the agent API: its credential (the agent in process, handed over in memory), or a one-time pairing
     * code (`dt collab agent-link`) to exchange for it at `url` (default: the running server's, from `server.json`).
     */
    connect: { readonly credential: AgentCredential } | { readonly code: string; readonly url?: string };
    /** The roles to take on. Default: both. */
    roles?: readonly AgentRole[];
    /** Handle one run, then end. */
    once?: boolean;
    /**
     * How `dt` is started for `dt fmt` and `dt check` after the agent, and by the agent itself (its `dt`): the CLI passes
     * `agent.run.dt` when configured, else its own runtime and entry.
     */
    dt: DtCommand;
    /** How Claude Code carries out the runs (`agent.run`); default: warm, with its default restart. */
    run?: RunConfig;
    log?: (line: string) => void;
    /** The agent's program instead of `claude` on the PATH: for the tests only, not a CLI option. */
    agentCommand?: AgentCommand;
    heartbeatMs?: number;
    reconnect?: { minMs: number; maxMs: number; giveUpMs: number };
}

export interface RunningSubscriber {
    session: string;
    /** The roles it took on. */
    roles: readonly AgentRole[];
    /** Resolves when the subscriber ends. */
    done: Promise<SubscriberEnd>;
    /** Releases or fails (`Interrupted`) the run in hand and ends. */
    stop(): Promise<SubscriberEnd>;
}

const isLoopbackUrl = (url: string): boolean => {
    if (!URL.canParse(url)) return false;
    const u = new URL(url);
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
};

/**
 * Exchanges a one-time pairing code for the agent API's credential (kept in memory by the caller), at `url` or the
 * agent API of the server running on the workspace. Refused (`SessionError`) when no server runs, the URL is not a
 * loopback one, or the code is unknown, used or expired.
 */
export async function pairAgent(root: string, code: string, url?: string): Promise<AgentCredential> {
    let at = url;
    if (at === undefined) {
        const address = await readServerAddress(root);
        if (!address || !processAlive(address.pid))
            throw new SessionError('No session server is running for this workspace (start one with `dt open` or `dt collab`).');
        if (!address.agentUrl) throw new SessionError('The running session server is of an older version: restart it, or pass --url.');
        at = address.agentUrl;
    }
    const base = at.endsWith('/') ? at : `${at}/`;
    if (!isLoopbackUrl(base)) throw new SessionError(`The agent API is on this machine only (http://127.0.0.1:…): not ${at}.`);
    const res = await fetch(`${base}agent/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }).catch(
        (e: unknown) => {
            throw new SessionError(`The session server's agent API does not answer (${e instanceof Error ? e.message : String(e)}).`);
        },
    );
    const body: unknown = await res.json().catch(() => undefined);
    const ok = typeof body === 'object' && body !== null && 'token' in body && 'session' in body;
    if (res.status !== 200 || !ok || typeof body.token !== 'string' || typeof body.session !== 'string')
        throw new SessionError('The pairing code is unknown, used or expired: print another with `dt collab agent-link` (or `dt open agent-link`).');
    return { url: base, token: body.token, session: body.session };
}

/** Subscribes to the session server running on the workspace at `options.root` and runs its agent runs. */
export async function startSubscriber(options: SubscriberOptions): Promise<RunningSubscriber> {
    const log = options.log ?? (() => {});
    // the answerer role (its entry point `/agent/answers/events` and its warm processes) is connected here once the
    // agent exposes it (plan modes, M4); until then the runner is the only role taken on
    const roles: readonly AgentRole[] = (options.roles ?? AGENT_ROLES).filter((r) => r === 'run');
    if (roles.length === 0) throw new SessionError('The answerer role is not available yet: run `dt agent` or `dt agent --role run`.');
    const root = path.resolve(options.root);
    const credential = 'credential' in options.connect ? options.connect.credential : await pairAgent(root, options.connect.code, options.connect.url);
    const api = createHttpAgentApi({ url: credential.url, token: credential.token });
    const session = await api.session().catch((e: unknown) => {
        throw new SessionError(`The session server's agent API does not answer (${e instanceof Error ? e.message : String(e)}).`);
    });
    if (!session.ok) throw new SessionError(`The session server refused the agent credential (${session.status} ${session.type}).`);
    if (session.value.session !== credential.session) throw new SessionError('The agent credential is not for the session the server runs.');
    if (session.value.state !== 'Open') throw new SessionError('The session is closed.');

    // the agent's dt, taken once now (never read again from the config file, which is in the workspace)
    let dt: PinnedDt;
    let runner: AgentRunner;
    try {
        dt = pinDt(options.dt, root);
        const run = options.run;
        const claude = {
            root,
            command: options.agentCommand,
            dt,
            ...(run?.model !== undefined && { model: run.model }),
            ...(run?.effort !== undefined && { effort: run.effort }),
        };
        runner =
            (run?.warm ?? true)
                ? await createWarmClaudeRunner({
                      ...claude,
                      restartAfter: run?.restartAfter,
                      ...(run?.idleTimeout !== undefined && { idleTimeoutMs: run.idleTimeout * 60_000 }),
                      log,
                  })
                : await createClaudeCodeRunner(claude);
    } catch (e) {
        throw new SessionError(e instanceof Error ? e.message : String(e));
    }
    const sources = options.sources ?? DEFAULT_SOURCES;
    const respectGitignore = options.respectGitignore ?? true;
    const subscriber: Subscriber = subscribe(
        {
            api,
            runner,
            tools: createDtTools({ dt: dtCommandOf(dt), root, configPath: options.configPath, log }),
            workspace: {
                scan: () => scanWorkspace(root),
                sources: async () => new Set(await findDomainFiles(root, sourceSelection(sources, respectGitignore))),
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
    return { session: session.value.session, roles, done: subscriber.done, stop: () => subscriber.stop() };
}
