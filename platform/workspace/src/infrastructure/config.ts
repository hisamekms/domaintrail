import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

/** A config file's contents and its absolute path. */
export interface ConfigText {
    readonly text: string;
    readonly file: string;
}

/**
 * How the configuration file is found and read, given by the app that composes its sections (ADR 0027, Project
 * analysis and configuration): the workspace reads the file and knows none of the sections.
 */
export interface ConfigFileFormat<T> {
    /** The file names, in order of preference within one directory. */
    readonly files: readonly string[];
    /** The configuration from the contents of the file found (an absolute path); throws when they are not valid. */
    resolve(text: string, file: string): T;
    /**
     * The names of the local override of the config file `file` (absolute; it may not exist), in order of preference,
     * beside it: read after it and merged into it by `resolveWithLocal`. Absent: no local override.
     */
    localFiles?(file: string): readonly string[];
    /** The configuration from the config file (none: the local override alone) and its local override. */
    resolveWithLocal?(project: ConfigText | undefined, local: ConfigText): T;
    /** The configuration without a file, rooted at `root`. */
    defaults(root: string): T;
    /** What is thrown when an explicit file does not exist. */
    notFound(configPath: string): Error;
}

/**
 * Whether the file `file` exists under exactly its name: on a case-insensitive file system `DomainTrail.Local.JSONC`
 * opens as `domaintrail.local.jsonc`, but is never taken for it (an agent could write such a variant past its rules).
 */
export function existsExactly(file: string): boolean {
    if (!existsSync(file)) return false;
    try {
        return readdirSync(path.dirname(file)).includes(path.basename(file));
    } catch {
        return false;
    }
}

/** Finds a config file named exactly one of `files` in `start` or its parents (like tsconfig.json). */
export function findConfigFile(start: string, files: readonly string[]): string | undefined {
    let dir = path.resolve(start);
    for (;;) {
        for (const name of files) {
            const candidate = path.join(dir, name);
            if (existsExactly(candidate)) return candidate;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

/** The first of `candidates` that exists under exactly its name. */
const firstExisting = (candidates: readonly string[]): string | undefined => candidates.find(existsExactly);

/**
 * The config file and its local override: an explicit `--config` file and the local override beside it, else the
 * nearest directory from `start` upwards holding a config file or a local override (either alone, or both).
 */
export function findConfigFiles<T>(
    opts: { start: string; configPath?: string },
    format: Pick<ConfigFileFormat<T>, 'files' | 'localFiles' | 'notFound'>,
): { readonly file?: string; readonly local?: string } {
    const localOf = (file: string): string | undefined => firstExisting(format.localFiles?.(file) ?? []);
    if (opts.configPath) {
        const file = path.resolve(opts.configPath);
        if (!existsSync(file)) throw format.notFound(opts.configPath);
        const local = localOf(file);
        return { file, ...(local && { local }) };
    }
    let dir = path.resolve(opts.start);
    for (;;) {
        const file = firstExisting(format.files.map((name) => path.join(dir, name)));
        // the local override's names beside the first name, when no config file is there
        const local = localOf(file ?? path.join(dir, format.files[0]));
        if (file || local) return { ...(file && { file }), ...(local && { local }) };
        const parent = path.dirname(dir);
        if (parent === dir) return {};
        dir = parent;
    }
}

/**
 * Resolves the configuration: an explicit `--config` file, else a config file found from `start` upwards, else
 * defaults rooted at `start`; with the local override beside the file when there is one (or alone, as the
 * configuration).
 */
export async function loadConfig<T>(opts: { start: string; configPath?: string }, format: ConfigFileFormat<T>): Promise<T> {
    const { file, local } = findConfigFiles(opts, format);
    const project = file === undefined ? undefined : { text: await readFile(file, 'utf8'), file };
    if (local !== undefined && format.resolveWithLocal) return format.resolveWithLocal(project, { text: await readFile(local, 'utf8'), file: local });
    if (!project) return format.defaults(opts.start);
    return format.resolve(project.text, project.file);
}
