import type { SourceFile } from '@domaintrail/kernel';
import type { AnswerConfig, Practice, RunConfig, TriageConfig } from '@domaintrail/agent';
import type { ResolvedClassifierConfig, ResolvedCollabConfig, ResolvedConfig } from '../config/config.js';
import type { MessageTemplateConfig } from '@domaintrail/collaboration';
import type { LanguageServerOptions } from '../lsp/server.js';
import type { TrustStore } from './trust.js';

/**
 * What the CLI needs from outside, defined here on its side (ADR 0025): `cliDeps` (`main.ts`)
 * wires the workspace's adapters, the Live View and the language server into `runCli`, so that the CLI depends on
 * none of them.
 */
export interface CliDeps {
    /** Resolves the configuration from `start` upwards, or from the explicit `configPath`; rejects with `ConfigError`. */
    loadConfig(opts: { start: string; configPath?: string }): Promise<ResolvedConfig>;
    /** The sources below `root` (paths relative to it, sorted), as `dt check` finds them. */
    findDomainFiles(root: string, sources: readonly string[], respectGitignore: boolean): Promise<string[]>;
    /** The sources below `root` with their text. */
    loadWorkspace(root: string, sources: readonly string[], respectGitignore: boolean): Promise<SourceFile[]>;
    /**
     * The ZIP archive of the workspace's sources (`dt export sources`): the files `findDomainFiles` finds (`.dt` and
     * `.dtes` only, none git ignores) and the config file `configFile` (never its local override), below a folder named
     * after the workspace.
     */
    exportSources(options: SourcesExportOptions): Promise<SourcesExport>;
    /** What `dt generate ts` prints after `hint: ` when no lint rule against casts is found from `root` up; else undefined. */
    castLintHint(root: string): Promise<string | undefined>;
    generatedOutput: GeneratedOutput;
    /**
     * Starts the Live View alone (`dt open --host <non-loopback>`: read-only); rejects with `UnknownRevisionError` for an
     * unknown `base`, or a system error (`EADDRINUSE`).
     */
    startViewServer(options: ViewServerOptions): Promise<{ url: string }>;
    /**
     * Starts the session server (`dt open`, `dt collab`): opens the workspace's session in the mode asked for. Rejects
     * with `SessionError` when the configuration cannot start it or the mode refuses the open session, `UnknownRevisionError`
     * for an unknown `base`, or a system error (`EADDRINUSE`).
     */
    startSessionServer(options: SessionServerOptions): Promise<StartedSession>;
    /** Another facilitator link for the session server running on the workspace; rejects with `SessionError` when none runs. */
    issueFacilitatorLink(root: string): Promise<{ link: string; expiresAt: Date }>;
    /**
     * A new invite link for the `link` session running on the workspace (the previous one stops working), or with `stop`
     * the invite stopped; rejects with `SessionError` when no `link` session runs.
     */
    issueInvite(root: string, stop?: boolean): Promise<{ link: string; expiresAt: Date } | { stopped: boolean }>;
    /** A one-time agent pairing code for the session server running on the workspace; rejects with `SessionError` when none runs. */
    issueAgentLink(root: string): Promise<{ code: string; agentUrl: string; expiresAt: Date }>;
    /** Another one-time sign-in link for the `dt open` server running on the workspace; rejects with `SessionError` when none runs or it is `dt collab`'s. */
    issueOpenLink(root: string): Promise<{ link: string; expiresAt: Date }>;
    /**
     * Starts a Cloudflare quick tunnel to `127.0.0.1:<port>` (`dt collab --tunnel`): resolves with its public URL once
     * it can be used; rejects with `TunnelError` (cloudflared missing, failed, or no URL in time). It is stopped by
     * `stop`, on Ctrl+C, and when the process exits.
     */
    startTunnel(options: { port: number; log: (line: string) => void }): Promise<StartedTunnel>;
    /** Whether the agent can run here (`claude` on the PATH, answering, with the flags the adapters need), or why not. */
    checkAgent(agent: 'claude'): Promise<AgentUsability>;
    /**
     * Starts the agent (`dt agent`, or in process for `dt open` / `dt collab`) on the session server running on the
     * workspace. Rejects with `SessionError` when no server runs or its credential is refused.
     */
    startAgent(options: AgentOptions): Promise<StartedAgent>;
    /** Starts the language server over stdio; resolves once it listens. */
    startLanguageServer(options: LanguageServerOptions): Promise<void>;
    /**
     * Whether git would commit the local override `file` (`tracked`, `unignored`), or not (`ignored`; `undefined`: no
     * repository). Absent: never asked.
     */
    localConfigState?(file: string): Promise<'tracked' | 'unignored' | 'ignored' | undefined>;
    /** Where the approvals of the security-relevant settings are kept (`dt open`, `dt collab`, `dt agent`). */
    trust?: TrustStore;
    /** Asks the person a yes/no question on the terminal; absent when there is none (stdin or stderr not a TTY). */
    confirm?(question: string): Promise<boolean>;
}

/** What `dt export sources` (and the Live View's download) archives: the workspace's sources and its config file. */
export interface SourcesExportOptions {
    root: string;
    sources: readonly string[];
    respectGitignore: boolean;
    /** The project's config file (absolute), if there is one. */
    configFile?: string;
}

/** The ZIP archive of the sources. */
export interface SourcesExport {
    /** The archive's top folder, the workspace's name: the file is `<name>-sources.zip`. */
    readonly name: string;
    /** The files in it, relative to the root, `/`-separated. */
    readonly files: readonly string[];
    /** How many of them are sources (`.dt` and `.dtes` files). */
    readonly sources: number;
    readonly zip: Uint8Array;
}

/** What `dt open --host <non-loopback>` asks of the Live View. */
export interface ViewServerOptions {
    root: string;
    sources: readonly string[];
    respectGitignore: boolean;
    /** The project's config file (absolute), if there is one: in the download of the sources. */
    configFile?: string;
    port: number;
    host: string;
    base?: string;
    log: (line: string) => void;
}

/** What `dt open` and `dt collab` ask of the session server. */
export interface SessionServerOptions {
    root: string;
    sources: readonly string[];
    respectGitignore: boolean;
    /** The project's config file (absolute), if there is one: in the download of the sources. */
    configFile?: string;
    base?: string;
    /** `Solo` (`dt open`) or `Collab` (`dt collab`). */
    mode: 'Solo' | 'Collab';
    /** What the session server is given of the configuration, with `--port` and `--host` applied. */
    session: SessionSettings;
    /**
     * `dt collab --tunnel`: the server is reached through the quick tunnel this process started, so the visitor's
     * address in `CF-Connecting-IP` is that cloudflared's word (the join requests' rate limit). Default: false.
     */
    quickTunnel?: boolean;
    /** `link`: the public URL, asked once the server listens, with the port bound (`--tunnel` starts its tunnel then). */
    publicUrlAfterListen?: (port: number) => Promise<string>;
    log: (line: string) => void;
}

/**
 * What the session server reads of the configuration: `collab` (its port and host, the identity mode, Access, the
 * participants, the quick reactions), the agent API's port with the runner's tools and previous-run diff (`agent`),
 * and the `classifier`.
 */
export interface SessionSettings extends ResolvedCollabConfig {
    agent: { port: number; allowedTools: string[]; maxPreviousRunDiff: number };
    classifier: ResolvedClassifierConfig;
    /** The team's message templates (the top-level `templates`), sent to the pages with the state. Default: none. */
    templates?: readonly MessageTemplateConfig[];
}

/** A running session server, as the CLI reports it. */
export interface StartedSession {
    url: string;
    agentUrl: string;
    /** The agent API's bearer token, in memory only: for the agent in process. */
    agentToken: string;
    session: string;
    /** `started`, `resumed`, or `collaborated` (a `dt open` session continued by `dt collab`). */
    opened: 'started' | 'resumed' | 'collaborated';
    /** The one-time facilitator link; in `Solo`, the one-time link that signs the launching user's browser in as its person. */
    facilitatorLink?: string;
    /** The public origin of a `link` session (the links are made with it). */
    publicUrl?: string;
    /** `link`: a new invite link (the previous one stops working). */
    issueInvite?(): Promise<{ link: string; expiresAt: string }>;
    /** Resolves when the facilitator closes the session. */
    closed: Promise<void>;
    stop(): Promise<void>;
}

/** A running quick tunnel, as the CLI uses it. */
export interface StartedTunnel {
    /** `https://<words>.trycloudflare.com`. */
    readonly url: string;
    /** Resolves when cloudflared exits. */
    readonly exited: Promise<void>;
    stop(): Promise<void>;
}

/** The tunnel could not start: printed as one line. */
export class TunnelError extends Error {}

/** The roles of an agent (ADR 0030): the read-only answerer and the runner. */
export const AGENT_ROLES = ['answer', 'run'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** Whether the agent can run here, with its version, or why not in a few words. */
export type AgentUsability = { readonly ok: true; readonly version: string } | { readonly ok: false; readonly reason: string };

/** What `dt agent` (and the agent in process) asks of the subscriber. */
export interface AgentOptions {
    root: string;
    sources: readonly string[];
    respectGitignore: boolean;
    /** The config file given with `-c` (for `dt fmt` and `dt check` after the agent). */
    configPath?: string;
    agent: 'claude';
    /**
     * How to reach the agent API: the credential in memory (the agent in process), or a one-time pairing code to
     * exchange for it at `url` (default: the running server's).
     */
    connect: { readonly credential: { url: string; token: string; session: string } } | { readonly code: string; readonly url?: string };
    /** The roles to take on. */
    roles: readonly AgentRole[];
    /** `agent.run.dt`: the command `dt` runs for the agent and after it; absent, the running CLI itself. */
    dt?: readonly string[];
    /** Handle one run (waiting for one if none is queued), then end. */
    once: boolean;
    /** `agent.run`: how Claude Code carries out the runs (warm or one process per run, model, effort). */
    run?: RunConfig;
    /** `agent.answer`: how Claude Code answers (warm, model, effort, timeout). */
    answer?: AnswerConfig;
    /** `agent.triage`: the light model of the triage's stage 3. */
    triage?: TriageConfig;
    /** The ways of working the agent's prompts give: the guide's `storming-practice` and `modeling-practice`. */
    practice?: Practice;
    /** What each role may read outside the workspace, read-only (`agent.read.paths` and its own; absolute paths). */
    read?: { readonly answer: readonly string[]; readonly run: readonly string[] };
    log: (line: string) => void;
}

/** A running agent, as the CLI reports it. */
export interface StartedAgent {
    session: string;
    /** The roles it took on (the answerer is connected once the agent has it). */
    roles: readonly AgentRole[];
    /** Resolves when it ends: `once` after its run, `closed` with the session, `stopped`, or `lost` (the server is gone). */
    done: Promise<'once' | 'closed' | 'stopped' | 'lost'>;
    stop(): Promise<unknown>;
}

/** A session cannot be started, or no session server runs (`dt open`, `dt collab`, `dt agent`): printed as one line. */
export class SessionError extends Error {}

/** The workspace's state directory (outside it) cannot be used, or its `.domaintrail/` moved: printed as one line. */
export class StateError extends Error {}

/** A file of `dt generate ts`: `path` relative to the root (`/`-separated), `file` absolute. */
export interface GeneratedFile {
    path: string;
    file: string;
    content: string;
}

/** The output of `dt generate ts` on disk. */
export interface GeneratedOutput {
    /** The first existing path component between `root` (exclusive) and `target` that is a symlink; `target` when outside `root`. */
    symlinkOnPath(root: string, target: string): Promise<string | undefined>;
    /** Existing entries at `files` that the generator may not replace: anything but a regular file it wrote. */
    foreignFiles(files: readonly string[]): Promise<string[]>;
    /**
     * Replaces the output of the previous run with `files` (stale files removed, the output directories cleaned, the
     * manifest written in the workspace's state directory, outside it); `recorded` is false when the manifest, the file
     * `manifest`, could not be written. Rejects with `StateError` when the state directory cannot be used.
     */
    replace(root: string, files: readonly GeneratedFile[]): Promise<{ recorded: boolean; manifest: string }>;
}
