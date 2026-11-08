// The configuration files kept from the runner (the security reviews of the read paths): a runner that wrote one —
// a `domaintrail.local.jsonc` git ignores, or the `-c` file — could widen what the next agent reads or runs. Its deny
// rules name each file by every path it may be reached by (`configFileRules`: as given, by its real path, and, below
// the workspace, relative to it); and, since a case-insensitive file system lets `DomainTrail.Local.JSONC` through a
// case-sensitive rule, the files of the `-c` file's directory named like a configuration file in any case are part of
// the runner's scan before and after each run (`configGuardScan`): one created or changed fails the run and stops the
// subscriber, as any change outside the sources does (the workspace itself is scanned whole already). The loader finds
// configuration files by their exact names only, so a case variant is never loaded either.
import { realpathSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { CONFIG_FILE_NAMES, foldedName } from '@domaintrail/agent';
import { localConfigFiles } from '../config/config.js';

/** `p` (absolute) by its real path: the deepest existing directory's, the rest as written. */
function realOf(p: string): string {
    try {
        return realpathSync.native(p);
    } catch {
        const parent = path.dirname(p);
        return parent === p ? p : path.join(realOf(parent), path.basename(p));
    }
}

/** `p` relative to `root` (`/`-separated) when it is below it. */
function below(root: string, p: string): string | undefined {
    const rel = path.relative(root, p);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : undefined;
}

/**
 * The configuration files of `-c <configPath>` (it and its local override) as the runner's `configFiles`: each as
 * resolved and by its real path (a link above it, `/tmp` for `/private/tmp`), and relative to the workspace `root`
 * (as given and real) when below it.
 */
export function configFileRules(configPath: string, root: string): string[] {
    const file = path.resolve(configPath);
    const roots = [path.resolve(root), realOf(path.resolve(root))];
    const out = new Set<string>();
    for (const f of [file, ...localConfigFiles(file)]) {
        for (const abs of [f, realOf(f)]) {
            out.add(abs);
            for (const r of roots) {
                const rel = below(r, abs);
                if (rel) out.add(rel);
            }
        }
    }
    return [...out];
}

/** The names a configuration file may have in the `-c` file's directory, folded (any case, any Unicode form). */
function guardedNames(configPath: string | undefined): Set<string> {
    const names = [...CONFIG_FILE_NAMES];
    if (configPath) for (const f of [path.resolve(configPath), ...localConfigFiles(path.resolve(configPath))]) names.push(path.basename(f));
    return new Set(names.map(foldedName));
}

/**
 * The files named like a configuration file (any case) in the `-c` file's directory when it is outside the workspace,
 * by absolute real path, with a fingerprint of their metadata: added to the runner's scan, so that one the agent
 * created or changed fails the run. Nothing without `-c` or with its directory inside the workspace (scanned whole).
 */
export async function configGuardScan(configPath: string | undefined, root: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!configPath) return out;
    const dir = realOf(path.dirname(path.resolve(configPath)));
    const realRoot = realOf(path.resolve(root));
    if (dir === realRoot || below(realRoot, dir)) return out;
    const names = guardedNames(configPath);
    for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (!names.has(foldedName(name))) continue;
        const full = path.join(dir, name);
        const s = await lstat(full, { bigint: true }).catch(() => undefined);
        if (s) out.set(full, `${s.isSymbolicLink() ? 'link' : s.isFile() ? 'file' : 'other'}|${s.size}|${s.ino}|${s.mtimeNs}|${s.ctimeNs}`);
    }
    return out;
}
