// The `sources` section of domaintrail.jsonc (ADR 0027, Project analysis and configuration: the analysis owns it):
// which files below the root are the project's sources, its defaults and its validation. The app composes it with the
// other sections; the workspace receives what it needs (`sourceSelection`) as a value and knows none of them.
import * as path from 'node:path';
import picomatch from 'picomatch';

/** The sources without a `sources` setting: every `.dt` and `.dtes` file. */
export const DEFAULT_SOURCES = ['**/*.dt', '**/*.dtes'];

/** Directories never scanned or watched. */
export const IGNORED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', '.domaintrail']);

/** The keys of the section, by where they sit in the file (`''`: the top level). */
export const SOURCES_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = { '': ['sources', 'respectGitignore'] };

/** The section in the config file. */
export interface SourcesConfigFile {
    /** Globs of DSL files (`.dt` and `.dtes`); `!pattern` excludes. Default: `**\/*.dt`, `**\/*.dtes`. */
    sources?: string[];
    /** Whether files and directories ignored by `.gitignore` are skipped when finding sources. Default: true. */
    respectGitignore?: boolean;
}

/** The section resolved: every default applied. */
export interface ResolvedSourcesConfig {
    sources: string[];
    respectGitignore: boolean;
}

/** Checks the section's keys of the config file's top level; `fail` throws. */
export function validateSourcesConfig(config: Record<string, unknown>, fail: (msg: string) => never): void {
    const sources = config.sources;
    if (sources !== undefined && (!Array.isArray(sources) || sources.some((s) => typeof s !== 'string'))) {
        fail("'sources' must be an array of glob strings");
    }
    if (Array.isArray(sources)) {
        if (!sources.some((s) => !String(s).startsWith('!'))) fail("'sources' needs at least one include pattern");
        for (const s of sources.map(String)) {
            if (s.replace(/^!/, '').split('/').includes('..') || path.isAbsolute(s.replace(/^!/, ''))) {
                fail(`'sources' must stay inside the directory of the config file: '${s}'`);
            }
        }
    }
    if (config.respectGitignore !== undefined && typeof config.respectGitignore !== 'boolean') fail("'respectGitignore' must be true or false");
}

/** The section with its defaults (validated). */
export function resolveSourcesConfig(config: SourcesConfigFile = {}): ResolvedSourcesConfig {
    return { sources: config.sources ?? DEFAULT_SOURCES, respectGitignore: config.respectGitignore ?? true };
}

/** Matches root-relative paths against `sources` (`!` patterns exclude); nothing under `IGNORED_DIRS` matches. */
export function sourceMatcher(sources: readonly string[]): (relPath: string) => boolean {
    const glob = (s: string) => picomatch(s, { dot: true });
    const include = sources.filter((s) => !s.startsWith('!')).map(glob);
    const exclude = sources.filter((s) => s.startsWith('!')).map((s) => glob(s.slice(1)));
    return (rel) => {
        const p = rel.split(path.sep).join('/');
        if (p.split('/').some((seg) => IGNORED_DIRS.has(seg))) return false;
        return include.some((m) => m(p)) && !exclude.some((m) => m(p));
    };
}

/**
 * Which files are sources, as the workspace receives it (its `SourceSelection`): the matcher of `sources`, the
 * directories never walked, and whether `.gitignore` is honored.
 */
export function sourceSelection(
    sources: readonly string[] = DEFAULT_SOURCES,
    respectGitignore = true,
): { matches(relPath: string): boolean; ignoredDirs: ReadonlySet<string>; respectGitignore: boolean } {
    return { matches: sourceMatcher(sources), ignoredDirs: IGNORED_DIRS, respectGitignore };
}
