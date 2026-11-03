// `dt agent` (ADR 0026, S6; ADR 0030), and the agent `dt open` and `dt collab` start in process over the same loopback
// HTTP: the agent of the session server running on the workspace, wired to its agent API (its credential in memory:
// handed over by the server in process, or paired for with a one-time code), in its two roles (ADR 0030, decision 6),
// both by default (`--role` names one):
//
// - the runner: Claude Code (a warm process across runs, or one per run: `agent.run`), `dt fmt`/`dt check` (this CLI,
//   or `agent.run.dt`, for the agent too) and the workspace's files;
// - the answerer: stage 3 of the triage (a light model with no tools: `agent.triage`), answers and proposals (Claude
//   Code with the reading tools only: `agent.answer`), from the answers entry point.
import { hostname } from 'node:os';
import * as path from 'node:path';
import {
    AGENT_ROLES,
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
    type Practice,
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
    readTargets,
    type WorkspaceView,
} from '@domaintrail/agent';
import { type AgentCredential, readServerAddress } from '@domaintrail/collaboration';
import { DEFAULT_SOURCES, sourceSelection } from '@domaintrail/analysis';
import { SessionError } from '../cli/ports.js';
import { findDomainFiles, GitIgnore, gitIgnoredEntries, gitNestedRepositories, gitReadableFiles } from '@domaintrail/workspace';
import { processAlive } from './process.js';
import { answererExtraViews, runnerReadScope } from './read-scope.js';

export type { SubscriberEnd };

/** The agents `dt agent` can run. */
export const AGENTS = ['claude'] as const;
export type AgentName = (typeof AGENTS)[number];

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
    /** Handle one run, then end. */
    once?: boolean;
    /**
     * How `dt` is started for `dt fmt` and `dt check` after the agent, and by the agent itself (its `dt`): the CLI passes
     * `agent.run.dt` when configured, else its own runtime and entry.
     */
    dt: DtCommand;
    /** How Claude Code carries out the runs (`agent.run`); default: warm, with its default restart. */
    run?: RunConfig;
    /** The roles to take (default both): `run`, the runs; `answer`, the triage's stage 3, answers and proposals. */
    roles?: readonly AgentRole[];
    /** How Claude Code answers (`agent.answer`); default: warm, 50 answers a process, 30 idle minutes, 120 s. */
    answer?: AnswerConfig;
    /** Stage 3 of the triage (`agent.triage`); default: `haiku`, a fresh process per triage. */
    triage?: TriageConfig;
    /** The ways of working the prompts give (the guide's); none without it. */
    practice?: Practice;
    /** What each role may read outside the workspace, read-only (`agent.read.paths` and its own; absolute paths). */
    read?: { readonly answer: readonly string[]; readonly run: readonly string[] };
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
    const taken: readonly AgentRole[] = AGENT_ROLES.filter((r) => (options.roles ?? AGENT_ROLES).includes(r));
    if (taken.length === 0) throw new SessionError('No role to take on: name `--role answer` or `--role run`, or neither for both.');
    const root = path.resolve(options.root);
    const credential = 'credential' in options.connect ? options.connect.credential : await pairAgent(root, options.connect.code, options.connect.url);
    const api = createHttpAgentApi({ url: credential.url, token: credential.token });
    const session = await api.session().catch((e: unknown) => {
        throw new SessionError(`The session server's agent API does not answer (${e instanceof Error ? e.message : String(e)}).`);
    });
    if (!session.ok) throw new SessionError(`The session server refused the agent credential (${session.status} ${session.type}).`);
    if (session.value.session !== credential.session) throw new SessionError('The agent credential is not for the session the server runs.');
    if (session.value.state !== 'Open') throw new SessionError('The session is closed.');

    const roles = new Set<AgentRole>(taken);
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
    // what each role reads outside the workspace, by its real path now: one missing is skipped, and said
    const readOf = (role: AgentRole): ReturnType<typeof readTargets>['targets'] => {
        const { targets, skipped } = readTargets(options.read?.[role] ?? [], root);
        for (const s of skipped) log(`${role === 'answer' ? 'answerer' : 'runner'}: not reading ${s}`);
        return targets;
    };
    // the answerer reads a view of the workspace: the files git does not ignore, without .domaintrail/ and .git/; and
    // views of what it reads outside it
    const view = roles.has('answer') ? answererView(root) : undefined;
    const viewDir = await view?.refresh();
    const extraViews = roles.has('answer') ? await answererExtraViews(readOf('answer')) : undefined;
    const prepare = async (): Promise<void> => {
        await view?.refresh();
        await extraViews?.refresh();
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
                          ...(extraViews && { extraRead: extraViews.extra }),
                          ...((options.answerCommand ?? options.agentCommand) && { command: options.answerCommand ?? options.agentCommand }),
                          answer: {
                              warm: answerConfig.warm,
                              restartAfter: answerConfig.restartAfter,
                              idleTimeoutMs: answerConfig.idleTimeout * 60_000,
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
                  {
                      timeoutMs: answerConfig.timeout * 1000,
                      ...(options.reconnect && { reconnect: options.reconnect }),
                      ...(options.practice && { practice: options.practice }),
                  },
              )
            : undefined;
    // the views go with the answerer
    void answerer?.done.then(() => Promise.all([view?.dispose(), extraViews?.dispose()]));
    if (!roles.has('run')) {
        const done = answerer?.done ?? Promise.resolve<SubscriberEnd>('stopped');
        return { session: session.value.session, roles: taken, done, stop: async () => (await answerer?.stop()) ?? 'stopped' };
    }

    const runTargets = readOf('run');
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
            // what git ignores, kept from the runner (it works in the workspace itself; ADR 0030 as built in M4), and
            // what it reads outside the workspace, never writes
            readScope: () => runnerReadScope(() => runnerDeniedPaths(root), runTargets),
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
            ...(options.practice && { practice: options.practice }),
        },
    );
    // the runner's end ends the answerer too (the session closed, the server is gone, Ctrl+C, `--once`)
    const done = subscriber.done.then(async (why) => {
        await answerer?.stop();
        return why;
    });
    return {
        session: session.value.session,
        roles: taken,
        done,
        stop: async () => {
            const [why] = await Promise.all([subscriber.stop(), answerer?.stop()]);
            return why;
        },
    };
}

/**
 * The answerer's view of the workspace (ADR 0030, as built in M4b): the files git does not ignore — git's own list
 * (`git ls-files -co --exclude-standard`: `core.excludesFile` and `.git/info/exclude` apply) where git speaks for the
 * root, else (no repository, or a root its repository ignores) a walk with `GitIgnore` and the user's excludes file —
 * without `.domaintrail` and `.git` at any depth.
 */
export function answererView(root: string, env?: NodeJS.ProcessEnv): WorkspaceView {
    let gitignore: GitIgnore | undefined;
    return createWorkspaceView({
        root,
        list: async () => {
            gitignore = undefined;
            return gitReadableFiles(root, { env });
        },
        ignores: (p, directory) => (gitignore ??= new GitIgnore(root, { userExcludes: true, env })).ignores(p, directory),
    });
}

/**
 * What git ignores, kept from the runner (it works in the workspace itself) as deny rules, asked at each run's start:
 * the nested repositories and submodules as a whole, then git's ignored entries (`git ls-files -o -i --exclude-standard
 * --directory`) where it speaks for the root, else a walk with `GitIgnore` and the user's excludes file (a directory
 * holding a `.git` denied as a whole). More than `MAX_IGNORED_ENTRIES` refuses the run (`TooManyDeniedEntries`), never
 * a list cut short.
 */
export function runnerDeniedPaths(root: string, env?: NodeJS.ProcessEnv): Promise<string[]> {
    let gitignore: GitIgnore | undefined;
    return ignoredEntries(root, {
        list: async () => {
            const [nested, ignored] = await Promise.all([gitNestedRepositories(root, { env }), gitIgnoredEntries(root, { env })]);
            return nested && ignored && [...nested, ...ignored];
        },
        ignores: (p, d) => (gitignore ??= new GitIgnore(root, { userExcludes: true, env })).ignores(p, d),
    });
}
