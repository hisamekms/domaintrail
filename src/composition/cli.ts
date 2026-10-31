import { consoleIO, runCli, type CliIO } from '../presentation/cli/main.js';
import type { CliDeps } from '../presentation/cli/ports.js';
import type { LanguageServerFiles } from '../presentation/lsp/server.js';
import { loadConfig } from '../workspace/infrastructure/config.js';
import { SourceScope, findDomainFiles, loadWorkspace } from '../workspace/infrastructure/files.js';
import { createGeneratedOutput } from '../workspace/infrastructure/generated-output.js';
import { LINT_HINT, hasCastLintRule } from '../workspace/infrastructure/lint-hint.js';

/** The language server's view of the workspace: the config and the sources, as `dt check` finds them. */
const languageServerFiles: LanguageServerFiles = {
    loadConfig,
    sourceScope: (root, sources, respectGitignore) => new SourceScope(root, sources, respectGitignore),
    findDomainFiles,
};

/**
 * The adapters of `dt`: the workspace on disk, the Live View and the language server. The Live View and the language
 * server are loaded only by the commands that start them.
 */
export function cliDeps(): CliDeps {
    return {
        loadConfig,
        findDomainFiles,
        loadWorkspace,
        castLintHint: async (root) => ((await hasCastLintRule(root)) ? undefined : LINT_HINT),
        generatedOutput: createGeneratedOutput(),
        startViewServer: async (options) => (await import('./view.js')).startViewServer(options),
        startLanguageServer: async (options) => {
            (await import('../presentation/lsp/server.js')).startLanguageServer(options, languageServerFiles);
        },
    };
}

/** Runs `dt` with `argv` and returns the process exit code. */
export function runDt(argv: readonly string[], io: CliIO = consoleIO): Promise<number> {
    return runCli(argv, io, cliDeps());
}
