// `dt session subscribe --agent claude` (ADR 0026, S6): the agent of the session server running on the workspace, wired
// to its agent API (`.domaintrail/session/agent.json`), in its two roles (ADR 0030, decision 6), both by default:
//
// - the runner: Claude Code (a warm process across runs, or one per run: `session.agent.run`), `dt fmt`/`dt check` (this
//   CLI, or `session.agent.dt`, for the agent too) and the workspace's files;
// - the answerer: stage 3 of the triage (a light model with no tools), answers and proposals (Claude Code with the
//   reading tools only), from the answers entry point; its settings are their defaults until the config has
//   `agent.answer.*` and `agent.triage.*` (plan task M5, which also gives `dt agent --role answer|run`).
import { lstat } from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';
import {
    type AgentCommand,
    type AgentRole,
    type AgentRunner,
    type AnswerConfig,
    createClaudeAnswerer,
    createClaudeCodeRunner,
    createDtTools,
    createWarmClaudeRunner,
    createHttpAgentApi,
    type DtCommand,
    dtCommandOf,
    pinDt,
    type PinnedDt,
    randomNonce,
    resolveAnswerConfig,
    resolveTriageConfig,
    type RunConfig,
    scanWorkspace,
    startAnswerer,
    startSubscriber as subscribe,
    type Subscriber,
    type SubscriberEnd,
    systemClock,
    type TriageConfig,
    userClaudeDefaults,
    createWorkspaceView,
    ignoredEntries,
} from '@domaintrail/agent';
import { AGENT_FILE, type AgentCredential, readAgentCredential, SESSION_DIR } from '@domaintrail/collaboration';
import { DEFAULT_SOURCES, sourceSelection } from '@domaintrail/analysis';
import { SessionError } from '../cli/ports.js';
import { findDomainFiles, GitIgnore } from '@domaintrail/workspace';
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
    /**
     * How `dt` is started for `dt fmt` and `dt check` after the agent, and by the agent itself (its `dt`): the CLI passes
     * `session.agent.dt` when configured, else its own runtime and entry.
     */
    dt: DtCommand;
    /** How Claude Code carries out the runs (`session.agent.run`); default: warm, with its default restart. */
    run?: RunConfig;
    /** The roles to take (default both): `run`, the runs; `answer`, the triage's stage 3, answers and proposals. */
    roles?: readonly AgentRole[];
    /** How Claude Code answers (`agent.answer`, M5); default: warm, 50 answers a process, 120 s. */
    answer?: AnswerConfig;
    /** Stage 3 of the triage (`agent.triage`, M5); default: `haiku`, a fresh process per triage. */
    triage?: TriageConfig;
    /** The answerer's program instead of `agentCommand`: for the tests only. */
    answerCommand?: AgentCommand;
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

    const roles = new Set<AgentRole>(options.roles ?? ['run', 'answer']);
    const scan = (): Promise<ReadonlyMap<string, string>> => scanWorkspace(root);
    const owner = `${options.agent}@${
        hostname()
            .replace(/[^\x21-\x7e]/g, '-')
            .slice(0, 100) || 'localhost'
    }`;

    // `claude` loads no settings file (it could allow reading anywhere): a role without its own model or effort gets the user's
    const user = userClaudeDefaults();
    const answerConfig = options.answer ?? resolveAnswerConfig();
    const triageConfig = options.triage ?? resolveTriageConfig();
    // the answerer reads a view of the workspace: the files git does not ignore, without .domaintrail/ and .git/
    let gitignore = new GitIgnore(root);
    const view = roles.has('answer') ? createWorkspaceView({ root, ignores: (p, directory) => gitignore.ignores(p, directory) }) : undefined;
    const viewDir = await view?.refresh();
    const prepare = async (): Promise<void> => {
        gitignore = new GitIgnore(root);
        await view?.refresh();
    };
    // the answerer: read-only, no lease, beside the runs (it never waits for them, nor they for it)
    const answerer =
        view && viewDir
            ? startAnswerer(
                  {
                      api,
                      agent: createClaudeAnswerer({
                          root: viewDir,
                          prepare,
                          ...((options.answerCommand ?? options.agentCommand) && { command: options.answerCommand ?? options.agentCommand }),
                          answer: {
                              warm: answerConfig.warm,
                              restartAfter: answerConfig.restartAfter,
                              ...((answerConfig.model ?? user.model) !== undefined && { model: answerConfig.model ?? user.model }),
                              ...((answerConfig.effort ?? user.effort) !== undefined && { effort: answerConfig.effort ?? user.effort }),
                          },
                          triage: { model: triageConfig.model, warm: triageConfig.warm },
                          log,
                      }),
                      workspace: { scan },
                      clock: systemClock,
                      nonce: randomNonce,
                      log,
                  },
                  { timeoutMs: answerConfig.timeout * 1000, ...(options.reconnect && { reconnect: options.reconnect }) },
              )
            : undefined;
    // the view goes with the answerer
    void answerer?.done.then(() => view?.dispose());
    if (!roles.has('run')) {
        const done = answerer?.done ?? Promise.resolve<SubscriberEnd>('stopped');
        return { session: session.value.session, done, stop: async () => (await answerer?.stop()) ?? 'stopped' };
    }

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
            // what git ignores, kept from the runner (it works in the workspace itself; ADR 0030 as built in M4)
            deniedPaths: () => {
                const now = new GitIgnore(root);
                return ignoredEntries(root, (p, d) => now.ignores(p, d));
            },
            ...((run?.model ?? user.model) !== undefined && { model: run?.model ?? user.model }),
            ...((run?.effort ?? user.effort) !== undefined && { effort: run?.effort ?? user.effort }),
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
        await answerer?.stop();
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
                scan,
                sources: async () => new Set(await findDomainFiles(root, sourceSelection(sources, respectGitignore))),
            },
            clock: systemClock,
            owner,
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
    // the runner's end ends the answerer too (the session closed, the server is gone, Ctrl+C, `--once`)
    const done = subscriber.done.then(async (why) => {
        await answerer?.stop();
        return why;
    });
    return {
        session: session.value.session,
        done,
        stop: async () => {
            const [why] = await Promise.all([subscriber.stop(), answerer?.stop()]);
            return why;
        },
    };
}
