import type { SourceFile } from '@domaintrail/modeling/core/analyze';
import type { ResolvedConfig } from '@domaintrail/modeling/core/config';
import type { LanguageServerOptions } from '../lsp/server.js';

/**
 * What the CLI needs from outside, defined here on its side (ADR 0025): `src/composition/cli.ts` wires the workspace's
 * adapters, the Live View and the language server into `runCli`, so that presentation depends on none of them.
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
