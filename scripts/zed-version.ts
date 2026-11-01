// The Zed extension's version follows the package's, in four places: the extension, its crate, the crate's lock entry,
// and the `dt` the extension installs when neither the settings nor the PATH give one. `npm version` runs this script
// (the `version` lifecycle script) after bumping package.json, so the four go into the release commit;
// test/zed-version.test.ts fails when any of them differs. Run by hand with `bun scripts/zed-version.ts`.
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export const ROOT = path.join(import.meta.dir, '..');

export interface VersionSite {
    /** The file, relative to the repository root. */
    file: string;
    /** Matches the version in the file: the text before it, the version, and the text after it. */
    pattern: RegExp;
}

export const ZED_VERSION_SITES: readonly VersionSite[] = [
    { file: 'editors/zed/extension.toml', pattern: /^(version = ")([^"]+)(")$/m },
    { file: 'editors/zed/Cargo.toml', pattern: /^(version = ")([^"]+)(")$/m },
    { file: 'editors/zed/Cargo.lock', pattern: /^(name = "zed_domaintrail"\nversion = ")([^"]+)(")$/m },
    { file: 'editors/zed/src/lib.rs', pattern: /^(const PINNED_VERSION: &str = ")([^"]+)(";)$/m },
];

export async function packageVersion(): Promise<string> {
    const pkg: unknown = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
    if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') {
        throw new Error('package.json has no version');
    }
    return pkg.version;
}

/** The version written at a site; fails when the site's pattern no longer matches the file. */
export async function versionAt(site: VersionSite): Promise<string> {
    const m = (await readFile(path.join(ROOT, site.file), 'utf8')).match(site.pattern);
    if (!m) throw new Error(`no version found in ${site.file} (${site.pattern})`);
    return m[2];
}

/** Writes the package's version at every site. */
export async function syncZedVersion(): Promise<void> {
    const version = await packageVersion();
    for (const site of ZED_VERSION_SITES) {
        const file = path.join(ROOT, site.file);
        const text = await readFile(file, 'utf8');
        if (!site.pattern.test(text)) throw new Error(`no version found in ${site.file} (${site.pattern})`);
        await writeFile(file, text.replace(site.pattern, `$1${version}$3`));
    }
}

if (import.meta.main) await syncZedVersion();
