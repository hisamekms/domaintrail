import type { LanguageServerFiles, LanguageServerOptions } from './server.js';

/** Starts `dt lsp`. The language server (Langium's LSP services, vscode-languageserver) is loaded only by this command. */
export async function startLanguageServer(options: LanguageServerOptions, files: LanguageServerFiles): Promise<void> {
    (await import('./server.js')).startLanguageServer(options, files);
}
