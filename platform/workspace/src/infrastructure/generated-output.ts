import { chmod, lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/** A file of `dt generate ts`: `path` relative to the root (`/`-separated), `file` absolute. */
export interface GeneratedFile {
    path: string;
    file: string;
    content: string;
}

/**
 * Files written by the last `generate ts`, relative to the root, so that a later run can remove those it no longer
 * writes: in the workspace's state directory (./state-dirs.ts), never in the workspace.
 */
export const MANIFEST_FILE = 'generated.json';

/**
 * The output of `dt generate ts` on disk: the safety checks before writing and the writing itself (a `GeneratedOutput`
 * of the CLI, `@domaintrail/dt/cli/ports`). `marker` starts every file the generator writes (the generator's
 * `GENERATED_MARKER`, given by the app): only such files are ever replaced or removed. `stateDir` gives the workspace's
 * state directory (made), where the manifest is.
 */
export function createGeneratedOutput(
    marker: string,
    stateDir: (root: string) => Promise<string>,
): {
    symlinkOnPath(root: string, target: string): Promise<string | undefined>;
    foreignFiles(files: readonly string[]): Promise<string[]>;
    replace(root: string, files: readonly GeneratedFile[]): Promise<{ recorded: boolean; manifest: string }>;
} {
    return {
        symlinkOnPath,
        foreignFiles: (files) => foreignFiles(files, marker),
        replace: async (root, files) => replace(root, files, marker, path.join(await stateDir(root), MANIFEST_FILE)),
    };
}

/**
 * Replaces the output of the previous run with `files`: deletes the files of the previous run this one does not write,
 * removes the generated files of the output directories, writes `files` and records them in the manifest `manifest`.
 * `recorded` is false when the manifest could not be written (see `writeManifest`). The output directories must
 * already be checked to be inside the root and free of symlinks, and `files` to be generated or missing (see
 * `foreignFiles`).
 */
async function replace(root: string, files: readonly GeneratedFile[], marker: string, manifest: string): Promise<{ recorded: boolean; manifest: string }> {
    const outDirs = [...new Set(files.map((f) => path.dirname(f.file)))];
    const previous = await readManifest(manifest);
    await removeStale(root, previous, new Set(files.map((f) => f.file)), marker);
    for (const dir of outDirs) await cleanGenerated(dir, marker);
    for (const f of files) await writeNew(f.file, f.content);
    const recorded = await writeManifest(
        manifest,
        files.map((f) => f.path),
    );
    return { recorded, manifest };
}

/**
 * Existing entries at the paths about to be written that the generator may not replace:
 * anything that is not a regular file written by the generator (symlinks included, even dangling ones).
 */
async function foreignFiles(files: readonly string[], marker: string): Promise<string[]> {
    const out: string[] = [];
    for (const file of files) {
        if (!(await isGeneratedOrMissing(file, marker))) out.push(file);
    }
    return out;
}

async function isGeneratedOrMissing(file: string, marker: string): Promise<boolean> {
    const stat = await lstat(file).catch(() => undefined);
    return !stat || (stat.isFile() && (await readFile(file, 'utf8')).startsWith(marker));
}

/** The first existing path component between `root` (exclusive) and `target` that is a symlink, if any. */
async function symlinkOnPath(root: string, target: string): Promise<string | undefined> {
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return target;
    let current = root;
    for (const part of rel.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        const stat = await lstat(current).catch(() => undefined);
        if (!stat) return undefined;
        if (stat.isSymbolicLink()) return current;
    }
    return undefined;
}

/**
 * Writes via a fresh temp file and rename, so an existing symlink is replaced rather than followed. With `mode`, the
 * file gets exactly those permissions, whatever the umask.
 */
async function writeNew(file: string, content: string, mode?: number): Promise<void> {
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    await writeFile(temp, content, { flag: 'wx', ...(mode !== undefined && { mode }) });
    if (mode !== undefined) await chmod(temp, mode);
    await rename(temp, file);
}

/**
 * Removes previous output. Only files written by the generator (recognized by their header) are deleted,
 * so pointing the output at a directory with hand-written code never destroys it. `outDir` must already be checked
 * to be inside the root and free of symlinks.
 */
async function cleanGenerated(outDir: string, marker: string): Promise<void> {
    await mkdir(outDir, { recursive: true });
    for (const entry of await readdir(outDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
        const file = path.join(outDir, entry.name);
        if ((await readFile(file, 'utf8')).startsWith(marker)) await rm(file);
    }
}

interface Manifest {
    version: 1;
    /** Root-relative, `/`-separated paths. */
    files: string[];
}

async function readManifest(file: string): Promise<string[]> {
    try {
        const m: { version?: unknown; files?: unknown } = JSON.parse(await readFile(file, 'utf8'));
        // the file may have been crafted: entries that would leave the root are dropped
        return m.version === 1 && Array.isArray(m.files) ? m.files.filter((f) => typeof f === 'string' && f !== '' && staysInside(f)) : [];
    } catch {
        return [];
    }
}

/** Records the generated files in `target`; false when its directory is not a plain one (never written through a symlink). */
async function writeManifest(target: string, files: string[]): Promise<boolean> {
    const dir = path.dirname(target);
    const existing = await lstat(dir).catch(() => undefined);
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) return false;
    // the state directory is the user's alone (0700) and so is the manifest (0600), whatever the umask
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const manifest: Manifest = { version: 1, files: [...files].sort() };
    await writeNew(target, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    return true;
}

/**
 * Deletes files of the previous run that this run does not write. Like cleanGenerated, only files with the generator's
 * header are deleted, only inside the root and never through a symlinked directory; a directory left empty is removed
 * too (never the root itself).
 */
async function removeStale(root: string, previous: string[], written: Set<string>, marker: string): Promise<void> {
    for (const rel of previous) {
        const file = path.resolve(root, rel);
        if (written.has(file) || !file.endsWith('.ts') || !staysInside(rel) || !isInside(root, file)) continue;
        const dir = path.dirname(file);
        if (await symlinkOnPath(root, dir)) continue;
        const stat = await lstat(file).catch(() => undefined);
        if (!stat?.isFile() || !(await isGeneratedOrMissing(file, marker))) continue;
        await rm(file);
        if (dir !== root) await rmdir(dir).catch(() => {}); // fails unless empty
    }
}

const isInside = (root: string, p: string): boolean => {
    const rel = path.relative(root, p);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/** Whether a path relative to the root stays inside it: not absolute and without a `..` segment (a manifest's entry). */
function staysInside(rel: string): boolean {
    return !path.isAbsolute(rel) && !path.win32.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..');
}
