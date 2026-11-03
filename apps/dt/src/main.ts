import { GENERATED_MARKER } from '@domaintrail/generation';
import { sourceSelection } from '@domaintrail/analysis';
import { type CliDeps } from './cli/ports.js';
import { type CliIO, consoleIO, runCli } from './cli/main.js';
import { CONFIG_FILE_FORMAT, type ResolvedConfig } from './config/config.js';
import { type LanguageServerFiles } from './lsp/server.js';
import { startLanguageServer } from './lsp/start.js';
import {
    createGeneratedOutput,
    findDomainFiles as findSources,
    hasCastLintRule,
    LINT_HINT,
    loadConfig as readConfig,
    loadWorkspace as readWorkspace,
    SourceScope,
} from '@domaintrail/workspace';

/** domaintrail.jsonc, read by the workspace and resolved by the sections' owners as the app composes them. */
const loadConfig = (opts: { start: string; configPath?: string }): Promise<ResolvedConfig> => readConfig(opts, CONFIG_FILE_FORMAT);

/** The sources the configuration names (the analysis's `sources`), found and read by the workspace. */
const findDomainFiles = (root: string, sources: readonly string[], respectGitignore: boolean): Promise<string[]> =>
    findSources(root, sourceSelection(sources, respectGitignore));
const loadWorkspace = (root: string, sources: readonly string[], respectGitignore: boolean): ReturnType<typeof readWorkspace> =>
    readWorkspace(root, sourceSelection(sources, respectGitignore));

/** The language server's view of the workspace: the config and the sources, as `dt check` finds them. */
const languageServerFiles: LanguageServerFiles = {
    loadConfig,
    sourceScope: (root, sources, respectGitignore) => new SourceScope(root, sourceSelection(sources, respectGitignore)),
    findDomainFiles,
};

/** What Ctrl+C stops, in the order registered; stopped in reverse (the agent in process before its server). */
const interruptible: (() => Promise<unknown>)[] = [];

/** Stops `stop` on Ctrl+C (or SIGTERM), after whatever was registered later, then exits with 130. */
function onInterrupt(stop: () => Promise<unknown>): void {
    interruptible.push(stop);
    if (interruptible.length > 1) return;
    const interrupted = (): void => {
        void (async () => {
            for (const s of [...interruptible].reverse()) await s().catch(() => undefined);
        })().finally(() => process.exit(130));
    };
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
}

/**
 * The adapters of `dt`: the workspace on disk, the Live View, the session server, the agent and the language server.
 * The servers are loaded only by the commands that start them.
 */
export function cliDeps(): CliDeps {
    return {
        loadConfig,
        findDomainFiles,
        loadWorkspace,
        castLintHint: async (root) => ((await hasCastLintRule(root)) ? undefined : LINT_HINT),
        generatedOutput: createGeneratedOutput(GENERATED_MARKER),
        startViewServer: async (options) => (await import('./wiring/view.js')).startViewServer(options),
        startSessionServer: async (options) => {
            const server = await (await import('./wiring/session.js')).startSessionServer(options);
            // Ctrl+C stops the server cleanly: the agent's credential file is removed and the database closed
            onInterrupt(() => server.stop());
            return server;
        },
        issueFacilitatorLink: async (root) => (await import('./wiring/session.js')).issueFacilitatorLink(root),
        issueAgentLink: async (root) => (await import('./wiring/session.js')).issueAgentLink(root),
        checkAgent: async () => (await import('@domaintrail/agent')).checkClaudeCode(),
        startAgent: async (options) => {
            // the agent's `dt` and `dt fmt` / `dt check` after it: `agent.run.dt`, else this very CLI, with the runtime
            // and the entry running it now
            const [command, ...args] = options.dt ?? [];
            const dt = command ? { command, args } : { command: process.execPath, args: process.argv[1] ? [process.argv[1]] : [] };
            const agent = await (await import('./wiring/subscriber.js')).startSubscriber({ ...options, dt });
            // Ctrl+C: the run in hand is released or failed as interrupted, and its agent stopped, before exiting
            onInterrupt(() => agent.stop());
            return agent;
        },
        // loads the language server only when `dt lsp` starts it
        startLanguageServer: (options) => startLanguageServer(options, languageServerFiles),
    };
}

/** Runs `dt` with `argv` and returns the process exit code. */
export function runDt(argv: readonly string[], io: CliIO = consoleIO): Promise<number> {
    return runCli(argv, io, cliDeps());
}
