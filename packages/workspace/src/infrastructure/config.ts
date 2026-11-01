import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * How the configuration file is found and read, given by the app that composes its sections (ADR 0027, Project
 * analysis and configuration): the workspace reads the file and knows none of the sections.
 */
export interface ConfigFileFormat<T> {
    /** The file names, in order of preference within one directory. */
    readonly files: readonly string[];
    /** The configuration from the contents of the file found (an absolute path); throws when they are not valid. */
    resolve(text: string, file: string): T;
    /** The configuration without a file, rooted at `root`. */
    defaults(root: string): T;
    /** What is thrown when an explicit file does not exist. */
    notFound(configPath: string): Error;
}

/** Finds a config file named one of `files` in `start` or its parents (like tsconfig.json). */
export function findConfigFile(start: string, files: readonly string[]): string | undefined {
    let dir = path.resolve(start);
    for (;;) {
        for (const name of files) {
            const candidate = path.join(dir, name);
            if (existsSync(candidate)) return candidate;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

/**
 * Resolves the configuration: an explicit `--config` file, else a config file found from `start` upwards,
 * else defaults rooted at `start`.
 */
export async function loadConfig<T>(opts: { start: string; configPath?: string }, format: ConfigFileFormat<T>): Promise<T> {
    const file = opts.configPath ? path.resolve(opts.configPath) : findConfigFile(opts.start, format.files);
    if (opts.configPath && !existsSync(file!)) throw format.notFound(opts.configPath);
    if (!file) return format.defaults(opts.start);
    return format.resolve(await readFile(file, 'utf8'), file);
}
