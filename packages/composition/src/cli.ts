import { consoleIO, runCli, type CliIO } from '@domaintrail/presentation/cli/main';
import type { CliDeps } from '@domaintrail/presentation/cli/ports';
import type { LanguageServerFiles } from '@domaintrail/presentation/lsp/server';
import { createGeneratedOutput, findDomainFiles, hasCastLintRule, LINT_HINT, loadConfig, loadWorkspace, SourceScope } from '@domaintrail/workspace';

/** The language server's view of the workspace: the config and the sources, as `dt check` finds them. */
const languageServerFiles: LanguageServerFiles = {
    loadConfig,
    sourceScope: (root, sources, respectGitignore) => new SourceScope(root, sources, respectGitignore),
    findDomainFiles,
};

/**
 * The adapters of `dt`: the workspace on disk, the Live View, the session server, the subscriber and the language
 * server. The servers are loaded only by the commands that start them.
 */
export function cliDeps(): CliDeps {
    return {
        loadConfig,
        findDomainFiles,
        loadWorkspace,
        castLintHint: async (root) => ((await hasCastLintRule(root)) ? undefined : LINT_HINT),
        generatedOutput: createGeneratedOutput(),
        startViewServer: async (options) => (await import('./view.js')).startViewServer(options),
        startSessionServer: async (options) => {
            const server = await (await import('./session.js')).startSessionServer(options);
            // Ctrl+C stops the server cleanly: the agent's credential file is removed and the database closed
            const interrupted = (): void => {
                void server.stop().finally(() => process.exit(130));
            };
            process.once('SIGINT', interrupted);
            process.once('SIGTERM', interrupted);
            return server;
        },
        issueFacilitatorLink: async (root) => (await import('./session.js')).issueFacilitatorLink(root),
        startSubscriber: async (options) => {
            // the agent's `dt` and `dt fmt` / `dt check` after it: `session.agent.dt`, else this very CLI, with the runtime
            // and the entry running it now
            const [command, ...args] = options.dt ?? [];
            const dt = command ? { command, args } : { command: process.execPath, args: process.argv[1] ? [process.argv[1]] : [] };
            const subscriber = await (await import('./subscriber.js')).startSubscriber({ ...options, dt });
            // Ctrl+C: the run in hand is released or failed as interrupted, and its agent stopped, before exiting
            const interrupted = (): void => {
                void subscriber.stop().finally(() => process.exit(130));
            };
            process.once('SIGINT', interrupted);
            process.once('SIGTERM', interrupted);
            return subscriber;
        },
        startLanguageServer: async (options) => {
            (await import('@domaintrail/presentation/lsp/server')).startLanguageServer(options, languageServerFiles);
        },
    };
}

/** Runs `dt` with `argv` and returns the process exit code. */
export function runDt(argv: readonly string[], io: CliIO = consoleIO): Promise<number> {
    return runCli(argv, io, cliDeps());
}
