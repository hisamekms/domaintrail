import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { CONFIG_FILES, ConfigError, defaultConfig, resolveConfig, type ResolvedConfig } from '../../core/config.js';

/** Finds a config file in `start` or its parents (like tsconfig.json). */
export function findConfigFile(start: string): string | undefined {
    let dir = path.resolve(start);
    for (;;) {
        for (const name of CONFIG_FILES) {
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
export async function loadConfig(opts: { start: string; configPath?: string }): Promise<ResolvedConfig> {
    const file = opts.configPath ? path.resolve(opts.configPath) : findConfigFile(opts.start);
    if (opts.configPath && !existsSync(file!)) throw new ConfigError(`Config file not found: ${opts.configPath}`);
    if (!file) return defaultConfig(opts.start);
    return resolveConfig(await readFile(file, 'utf8'), file);
}
