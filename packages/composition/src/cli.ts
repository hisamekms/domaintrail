import { consoleIO, runCli, type CliIO } from '@domaintrail/presentation/cli/main';
import type { CliDeps } from '@domaintrail/presentation/cli/ports';
import type { LanguageServerFiles } from '@domaintrail/presentation/lsp/server';
import { loadConfig } from '@domaintrail/workspace/infrastructure/config';
import { SourceScope, findDomainFiles, loadWorkspace } from '@domaintrail/workspace/infrastructure/files';
import { createGeneratedOutput } from '@domaintrail/workspace/infrastructure/generated-output';
import { LINT_HINT, hasCastLintRule } from '@domaintrail/workspace/infrastructure/lint-hint';

/** The language server's view of the workspace: the config and the sources, as `dt check` finds them. */
const languageServerFiles: LanguageServerFiles = {
    loadConfig,
    sourceScope: (root, sources, respectGitignore) => new SourceScope(root, sources, respectGitignore),
    findDomainFiles,
};

/**
 * The adapters of `dt`: the workspace on disk, the Live View, the session server and the language server. The servers
 * are loaded only by the commands that start them.
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
        startLanguageServer: async (options) => {
            (await import('@domaintrail/presentation/lsp/server')).startLanguageServer(options, languageServerFiles);
        },
    };
}

/** Runs `dt` with `argv` and returns the process exit code. */
export function runDt(argv: readonly string[], io: CliIO = consoleIO): Promise<number> {
    return runCli(argv, io, cliDeps());
}
