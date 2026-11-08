// `dt agent` (ADR 0026, S6; ADR 0030), and the agent `dt open` and `dt collab` start in process over the same loopback
// HTTP: the agent of the session server running on the workspace, wired to its agent API (its credential in memory:
// handed over by the server in process, or paired for with a one-time code), in its two roles (ADR 0030, decision 6),
// both by default (`--role` names one):
//
// - the runner: Claude Code (a warm process across runs, or one per run: `agent.run`), `dt fmt`/`dt check` (this CLI,
//   or `agent.run.dt`, for the agent too) and the workspace's files;
// - the answerer: stage 3 of the triage (a light model with no tools: `agent.triage`), answers and proposals (Claude
//   Code with the reading tools only: `agent.answer`), from the answers entry point; and with it the extractor of
//   knowledge (ADR 0031: Claude Code with no tools at all, `agent.extract`), from the extraction entry point — a role of
//   its own on the agent API, read-only like the answerer, so it is taken with it. A session that keeps no knowledge
//   answers its stream 404, and it ends then without a word more.
//
// With a usable knowledge store (`knowledgeForAgents`), the answerer's answers and proposals and the runner's runs read
// knowledge through the same read-only tools as `dt mcp` (ADR 0031, Consequences): Claude Code starts `dt mcp` of the
// agent's pinned `dt` on the workspace as its one MCP server, through a launcher outside the workspace, and is allowed
// its three tools by name. `dt mcp` checks the approval of the workspace's settings by itself. The triage, the
// interviews, the commands and the extractor never get them.
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import * as path from 'node:path';
import {
    AGENT_ROLES,
    type AgentCommand,
    type AgentRole,
    type AgentRunner,
    type AnswerConfig,
    createClaudeAnswerer,
    createClaudeExtractor,
    createClaudeCodeRunner,
    createDtTools,
    createWarmClaudeRunner,
    createHttpAgentApi,
    type KnowledgeMcp,
    writeKnowledgeMcpLauncher,
    type DtCommand,
    type ExtractConfig,
    type Extractor,
    dtCommandOf,
    DT_WRITTEN_FILE_NAMES,
    pinDt,
    type PinnedDt,
    type DiagnosticsScope,
    type Practice,
    randomNonce,
    resolveAnswerConfig,
    resolveTriageConfig,
    type RunConfig,
    scanWorkspace,
    startAnswerer,
    startExtractor,
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
    helperStream,
    type HelperApi,
} from '@domaintrail/agent';
import { type AgentCredential, readServerAddress } from '@domaintrail/collaboration';
import { analyze, DEFAULT_SOURCES, sourceSelection } from '@domaintrail/analysis';
import { isStormingFile } from '@domaintrail/storming';
import { SessionError } from '../cli/ports.js';
import {
    createWorkspaceReader,
    findDomainFiles,
    GitIgnore,
    gitIgnoredEntries,
    gitNestedRepositories,
    gitReadableFiles,
    stateRoots,
} from '@domaintrail/workspace';
import { workspaceState } from './state.js';
import { configFileRules, configGuardScan } from './config-guard.js';
import { processAlive } from './process.js';
import { answererExtraViews, runnerReadScope } from './read-scope.js';
import type { ResolvedConfig } from '../config/config.js';
import type { SettingsApproval } from '../cli/trust.js';
import { dtWrittenKnowledgeDir, knowledgeForAgents } from './knowledge.js';

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
    /** The extractor of knowledge (`agent.extract`); default: the answerer's model and effort, 180 s, the triage's light model first. */
    extract?: ExtractConfig;
    /** The ways of working the prompts give (the guide's); none without it. */
    practice?: Practice;
    /** What each role may read outside the workspace, read-only (`agent.read.paths` and its own; absolute paths). */
    read?: { readonly answer: readonly string[]; readonly run: readonly string[] };
    /**
     * The workspace's config and the proof that its settings were approved: with a usable knowledge store, the
     * answerer and the runner get the knowledge tools of `dt mcp` (`knowledgeForAgents`). None: no knowledge tools.
     */
    knowledge?: { readonly config: ResolvedConfig; readonly approval: SettingsApproval | undefined };
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
        const address = await readServerAddress((await workspaceState(root, (line) => console.error(line))).state);
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
    const sources = options.sources ?? DEFAULT_SOURCES;
    const respectGitignore = options.respectGitignore ?? true;
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
    // what each role reads outside the workspace, by its real path now: one missing is skipped, and said; never dt's
    // own state and cache directories
    const roots = stateRoots();
    const readOf = (role: AgentRole): ReturnType<typeof readTargets>['targets'] => {
        const { targets, skipped } = readTargets(options.read?.[role] ?? [], root, homedir(), [roots.state, roots.cache]);
        for (const s of skipped) log(`${role === 'answer' ? 'answerer' : 'runner'}: not reading ${s}`);
        return targets;
    };
    // the knowledge tools of `dt mcp`, for the answers and the runs alike; its launcher goes when the subscriber ends
    const launcher = await knowledgeLauncher(options, root, log);
    const knowledgeMcp: KnowledgeMcp | undefined = launcher && { command: launcher.command, args: launcher.args };
    const knowledgeGone = <T>(done: Promise<T>): Promise<T> => (launcher ? done.finally(() => launcher.dispose()) : done);
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
                          ...(knowledgeMcp && { knowledge: knowledgeMcp }),
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
                      diagnostics: (scope) => workspaceDiagnostics(createWorkspaceReader(root, sourceSelection(sources, respectGitignore)), scope),
                      clock: systemClock,
                      nonce: randomNonce,
                      log,
                  },
                  {
                      timeoutMs: answerConfig.timeout * 1000,
                      ...(options.reconnect && { reconnect: options.reconnect }),
                      ...(options.practice && { practice: options.practice }),
                      ...(knowledgeMcp && { knowledge: true }),
                  },
              )
            : undefined;
    // the views go with the answerer
    void answerer?.done.then(() => Promise.all([view?.dispose(), extraViews?.dispose()]));
    const knowledgeExtractor = roles.has('answer')
        ? await startKnowledgeExtractor({
              api,
              ...((options.extract?.model ?? answerConfig.model ?? user.model) !== undefined && {
                  model: options.extract?.model ?? answerConfig.model ?? user.model,
              }),
              ...((options.extract?.effort ?? answerConfig.effort ?? user.effort) !== undefined && {
                  effort: options.extract?.effort ?? answerConfig.effort ?? user.effort,
              }),
              timeoutMs: (options.extract?.timeout ?? 180) * 1000,
              gateModel: options.extract?.gateModel ?? triageConfig.model,
              ...((options.answerCommand ?? options.agentCommand) && { command: options.answerCommand ?? options.agentCommand }),
              ...(options.reconnect && { reconnect: options.reconnect }),
              log,
          })
        : undefined;
    // the light model's small jobs (a hotspot's name, ADR 0033) with whichever role this agent takes, whatever the
    // knowledge config: a stream of their own, so that an extraction never holds them up
    const helper = await startHelper({
        api,
        gateModel: options.extract?.gateModel ?? triageConfig.model,
        ...((options.answerCommand ?? options.agentCommand) && { command: options.answerCommand ?? options.agentCommand }),
        ...(options.reconnect && { reconnect: options.reconnect }),
        log,
    });
    const extractor = bothExtractors(knowledgeExtractor, helper);
    /**
     * The read-only roles' end: the answerer stops; the extractor, when the session closed, is let finish the last
     * extraction (the server tells it when it is done), at most its timeout and a little more.
     */
    const readOnlyEnd = async (why: SubscriberEnd | 'closed'): Promise<void> => {
        const last = why === 'closed' && extractor ? withTimeout(extractor.done, (options.extract?.timeout ?? 180) * 1000 + 10_000) : undefined;
        await Promise.all([answerer?.stop(), last?.then(() => extractor?.stop())]);
        await extractor?.stop();
    };
    if (!roles.has('run')) {
        const done = knowledgeGone(
            (answerer?.done ?? Promise.resolve<SubscriberEnd>('stopped')).then(async (why) => {
                await readOnlyEnd(why);
                return why;
            }),
        );
        return {
            session: session.value.session,
            roles: taken,
            done,
            stop: async () => {
                const [why] = await Promise.all([answerer?.stop() ?? Promise.resolve<SubscriberEnd>('stopped'), extractor?.stop()]);
                return why;
            },
        };
    }

    const runTargets = readOf('run');
    // the `files` knowledge store's directory: only dt writes it (an extraction may while a run runs), never the agent
    const knowledgeDir = options.knowledge && dtWrittenKnowledgeDir(options.knowledge.config, root);
    const dtWrittenDirs = knowledgeDir ? [knowledgeDir] : [];
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
            // a -c file and its local override, never edited (the default names are denied at any depth already)
            ...(options.configPath && { configFiles: configFileRules(options.configPath, root) }),
            ...(dtWrittenDirs.length > 0 && { dtWrittenDirs }),
            ...(knowledgeMcp && { knowledge: knowledgeMcp }),
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
        await Promise.all([answerer?.stop(), extractor?.stop(), launcher?.dispose()]);
        throw new SessionError(e instanceof Error ? e.message : String(e));
    }
    const subscriber: Subscriber = subscribe(
        {
            api,
            runner,
            tools: createDtTools({ dt: dtCommandOf(dt), root, configPath: options.configPath, log }),
            workspace: {
                // the runner's scan: the workspace but the directories and files only dt writes (people's acts on the
                // journeys write the journey file at the root while a run runs), and the configuration files beside a
                // -c file outside it (any case)
                scan: async () =>
                    new Map([
                        ...(await scanWorkspace(root, { skip: dtWrittenDirs, skipFiles: DT_WRITTEN_FILE_NAMES })),
                        ...(await configGuardScan(options.configPath, root)),
                    ]),
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
            ...(knowledgeMcp && { knowledge: true }),
            // the review at a run's end (ADR 0034): on unless `agent.run.review` is false
            ...(options.run?.review === false && { review: false }),
        },
    );
    // the runner's end ends the answerer and the extractor too (the session closed — after the last extraction —, the
    // server is gone, Ctrl+C, `--once`)
    const done = knowledgeGone(
        subscriber.done.then(async (why) => {
            await readOnlyEnd(why);
            return why;
        }),
    );
    return {
        session: session.value.session,
        roles: taken,
        done,
        stop: async () => {
            const [why] = await Promise.all([subscriber.stop(), answerer?.stop(), extractor?.stop()]);
            return why;
        },
    };
}

/**
 * The launcher of `dt mcp` for the agent's Claude Code when the workspace's knowledge store is usable
 * (`knowledgeForAgents`), with the agent's `dt` pinned (outside the workspace); else none, said in the log unless there
 * is simply nothing to read yet (a `files` store without `knowledge/`).
 */
async function knowledgeLauncher(
    options: SubscriberOptions,
    root: string,
    log: (line: string) => void,
): Promise<(KnowledgeMcp & { dispose(): Promise<void> }) | undefined> {
    if (!options.knowledge) return undefined;
    const usable = knowledgeForAgents(options.knowledge.config, options.knowledge.approval);
    if (!usable.usable) {
        if (!usable.quiet) log(`knowledge: the AI reads none (${usable.reason})`);
        return undefined;
    }
    try {
        const launcher = await writeKnowledgeMcpLauncher(pinDt(options.dt, root), root, options.configPath);
        log('knowledge: the answers and the runs read it through dt mcp');
        return launcher;
    } catch (e) {
        log(`knowledge: the AI reads none (dt mcp cannot be started: ${e instanceof Error ? e.message : String(e)})`);
        return undefined;
    }
}

/**
 * `dt check`'s findings on the workspace now, one line each (`file:line:column severity code: message`): on the `.dtes`
 * files only (`stormings`: what `/es:names` reads) or on all of them (`workspace`: what `/guide` reads).
 */
export async function workspaceDiagnostics(
    reader: { readSources(): Promise<readonly { path: string; text: string }[]> },
    scope: DiagnosticsScope,
): Promise<readonly string[]> {
    const a = await analyze(await reader.readSources());
    return a.diagnostics
        .filter((d) => scope === 'workspace' || isStormingFile(d.file))
        .map((d) => `${d.file}:${d.start.line}:${d.start.column} ${d.severity} ${d.code}: ${d.message}`);
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

/** Resolves with `promise`, or after `ms` (undefined). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), ms);
        timer.unref();
        void promise.then((v) => {
            clearTimeout(timer);
            resolve(v);
        });
    });
}

/** The knowledge's extractor and the helper as one: ends as the first (else the helper) does; stopping stops both. */
function bothExtractors(knowledge: Extractor | undefined, helper: Extractor): Extractor {
    return {
        done: knowledge?.done ?? helper.done,
        async stop() {
            const [why] = await Promise.all([knowledge?.stop() ?? helper.stop(), helper.stop()]);
            return why;
        },
    };
}

/**
 * The light model's helper (ADR 0033): the tool-less light model of the extraction's gate (`agent.extract.gateModel`),
 * a fresh process per job in an empty directory of its own, following the agent API's helper stream (a hotspot's name).
 * A server without that stream answers 404: the helper then ends (`off`), and the server names hotspots itself.
 */
async function startHelper(options: {
    api: HelperApi;
    gateModel: string;
    command?: AgentCommand;
    reconnect?: { minMs: number; maxMs: number; giveUpMs: number };
    log: (line: string) => void;
}): Promise<Extractor> {
    const dir = await mkdtemp(path.join(tmpdir(), 'dt-helper-'));
    const helper = startExtractor(
        {
            api: helperStream(options.api),
            agent: createClaudeExtractor({ root: dir, gateModel: options.gateModel, ...(options.command && { command: options.command }) }),
            clock: systemClock,
            nonce: randomNonce,
            // a server without helper jobs is said once, as "no knowledge" would be: the helper's own words
            log: (line) => options.log(line.replace('extractor: the session keeps no knowledge; not extracting', 'helper: the server has no helper jobs')),
        },
        { ...(options.reconnect && { reconnect: options.reconnect }) },
    );
    void helper.done.then(() => rm(dir, { recursive: true, force: true })).catch(() => undefined);
    return helper;
}

/**
 * The extractor of knowledge (ADR 0031): Claude Code with no tools at all, a fresh process per extraction, in an empty
 * directory of its own (removed when it ends), so that no file of the workspace — nor its `CLAUDE.md` — is read.
 */
async function startKnowledgeExtractor(options: {
    api: Parameters<typeof startExtractor>[0]['api'];
    model?: string;
    effort?: string;
    /** The light model that decides first whether to extract (`agent.extract.gateModel`). */
    gateModel: string;
    timeoutMs: number;
    command?: AgentCommand;
    reconnect?: { minMs: number; maxMs: number; giveUpMs: number };
    log: (line: string) => void;
}): Promise<Extractor> {
    const dir = await mkdtemp(path.join(tmpdir(), 'dt-extractor-'));
    const extractor = startExtractor(
        {
            api: options.api,
            agent: createClaudeExtractor({
                root: dir,
                ...(options.model !== undefined && { model: options.model }),
                ...(options.effort !== undefined && { effort: options.effort }),
                gateModel: options.gateModel,
                ...(options.command && { command: options.command }),
            }),
            clock: systemClock,
            nonce: randomNonce,
            log: options.log,
        },
        { timeoutMs: options.timeoutMs, ...(options.reconnect && { reconnect: options.reconnect }) },
    );
    void extractor.done.then(() => rm(dir, { recursive: true, force: true })).catch(() => undefined);
    return extractor;
}
