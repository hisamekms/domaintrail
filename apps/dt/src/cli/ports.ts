import type { SourceFile } from '@domaintrail/kernel';
import type { RunConfig } from '@domaintrail/agent';
import type { ResolvedClassifierConfig, ResolvedCollabConfig, ResolvedConfig } from '../config/config.js';
import type { LanguageServerOptions } from '../lsp/server.js';

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
    /** What `dt generate ts` prints after `hint: ` when no lint rule against casts is found from `root` up; else undefined. */
    castLintHint(root: string): Promise<string | undefined>;
    generatedOutput: GeneratedOutput;
    /** Starts the Live View; rejects with `UnknownRevisionError` for an unknown `base`, or a system error (`EADDRINUSE`). */
    startViewServer(options: ViewServerOptions): Promise<{ url: string }>;
    /**
     * Starts the session server (`dt session start`): resumes the workspace's open session or starts one. Rejects with
     * `SessionError` when the configuration cannot start it, `UnknownRevisionError` for an unknown `base`, or a
     * system error (`EADDRINUSE`).
     */
    startSessionServer(options: SessionServerOptions): Promise<StartedSession>;
    /** Another facilitator link for the session server running on the workspace; rejects with `SessionError` when none runs. */
    issueFacilitatorLink(root: string): Promise<{ link: string; expiresAt: Date }>;
    /**
     * Subscribes to the session server running on the workspace (`dt session subscribe`) and runs its agent runs, one
     * at a time. Rejects with `SessionError` when no server runs or its credential is refused.
     */
    startSubscriber(options: SubscribeOptions): Promise<StartedSubscriber>;
    /** Starts the language server over stdio; resolves once it listens. */
    startLanguageServer(options: LanguageServerOptions): Promise<void>;
}

/** What `dt view` asks of the Live View. */
export interface ViewServerOptions {
    root: string;
    sources: readonly string[];
    respectGitignore: boolean;
    port: number;
    host: string;
    base?: string;
    log: (line: string) => void;
}

/** What `dt session start` asks of the session server. */
export interface SessionServerOptions {
    root: string;
    sources: readonly string[];
    respectGitignore: boolean;
    base?: string;
    /** What the session server is given of the configuration, with `--port` and `--host` applied. */
    session: SessionSettings;
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
}

/** A running session server, as the CLI reports it. */
export interface StartedSession {
    url: string;
    agentUrl: string;
    session: string;
    resumed: boolean;
    facilitatorLink: string;
    /** Resolves when the facilitator closes the session. */
    closed: Promise<void>;
    stop(): Promise<void>;
}

/** What `dt session subscribe` asks of the subscriber. */
export interface SubscribeOptions {
    root: string;
    sources: readonly string[];
    respectGitignore: boolean;
    /** The config file given with `-c` (for `dt fmt` and `dt check` after the agent). */
    configPath?: string;
    agent: 'claude';
    /** `agent.run.dt`: the command `dt` runs for the agent and after it; absent, the running CLI itself. */
    dt?: readonly string[];
    /** Handle one run (waiting for one if none is queued), then end. */
    once: boolean;
    /** `agent.run`: how Claude Code carries out the runs (warm or one process per run, model, effort). */
    run?: RunConfig;
    log: (line: string) => void;
}

/** A running subscriber, as the CLI reports it. */
export interface StartedSubscriber {
    session: string;
    /** Resolves when it ends: `once` after its run, `closed` with the session, `stopped`, or `lost` (the server is gone). */
    done: Promise<'once' | 'closed' | 'stopped' | 'lost'>;
    stop(): Promise<unknown>;
}

/** A session cannot be started, or no session server runs (`dt session …`): printed as one line. */
export class SessionError extends Error {}

/** A file of `dt generate ts`: `path` relative to the root (`/`-separated), `file` absolute. */
export interface GeneratedFile {
    path: string;
    file: string;
    content: string;
}

/** The output of `dt generate ts` on disk. */
export interface GeneratedOutput {
    /** The manifest of the generated files, relative to the root. */
    readonly manifestFile: string;
    /** The first existing path component between `root` (exclusive) and `target` that is a symlink; `target` when outside `root`. */
    symlinkOnPath(root: string, target: string): Promise<string | undefined>;
    /** Existing entries at `files` that the generator may not replace: anything but a regular file it wrote. */
    foreignFiles(files: readonly string[]): Promise<string[]>;
    /**
     * Replaces the output of the previous run with `files` (stale files removed, the output directories cleaned, the
     * manifest written); `recorded` is false when the manifest could not be written.
     */
    replace(root: string, files: readonly GeneratedFile[]): Promise<{ recorded: boolean }>;
}
