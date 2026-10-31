import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { staysInside } from '@domaintrail/modeling/core/config';
import { GENERATED_MARKER } from '@domaintrail/modeling/generator/typescript';

/** A file of `dt generate ts`: `path` relative to the root (`/`-separated), `file` absolute. */
export interface GeneratedFile {
    path: string;
    file: string;
    content: string;
}

/** Files written by the last `generate ts`, relative to the root, so that a later run can remove those it no longer writes. */
export const MANIFEST_FILE = path.join('.domaintrail', 'generated.json');

/**
 * The output of `dt generate ts` on disk: the safety checks before writing and the writing itself (a `GeneratedOutput`
 * of the CLI, `src/presentation/cli/ports.ts`).
 */
export function createGeneratedOutput(): {
    manifestFile: string;
    symlinkOnPath(root: string, target: string): Promise<string | undefined>;
    foreignFiles(files: readonly string[]): Promise<string[]>;
    replace(root: string, files: readonly GeneratedFile[]): Promise<{ recorded: boolean }>;
} {
    return { manifestFile: MANIFEST_FILE, symlinkOnPath, foreignFiles, replace };
}

/**
 * Replaces the output of the previous run with `files`: deletes the files of the previous run this one does not write,
 * removes the generated files of the output directories, writes `files` and records them in the manifest. `recorded`
 * is false when the manifest could not be written (see `writeManifest`). The output directories must already be
 * checked to be inside the root and free of symlinks, and `files` to be generated or missing (see `foreignFiles`).
 */
async function replace(root: string, files: readonly GeneratedFile[]): Promise<{ recorded: boolean }> {
    const outDirs = [...new Set(files.map((f) => path.dirname(f.file)))];
    const previous = await readManifest(root);
    await removeStale(root, previous, new Set(files.map((f) => f.file)));
    for (const dir of outDirs) await cleanGenerated(dir);
    for (const f of files) await writeNew(f.file, f.content);
    const recorded = await writeManifest(
        root,
        files.map((f) => f.path),
    );
    return { recorded };
}

/**
 * Existing entries at the paths about to be written that the generator may not replace:
 * anything that is not a regular file written by the generator (symlinks included, even dangling ones).
 */
async function foreignFiles(files: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const file of files) {
        if (!(await isGeneratedOrMissing(file))) out.push(file);
    }
    return out;
}

async function isGeneratedOrMissing(file: string): Promise<boolean> {
    const stat = await lstat(file).catch(() => undefined);
    return !stat || (stat.isFile() && (await readFile(file, 'utf8')).startsWith(GENERATED_MARKER));
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

/** Writes via a fresh temp file and rename, so an existing symlink is replaced rather than followed. */
async function writeNew(file: string, content: string): Promise<void> {
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    await writeFile(temp, content, { flag: 'wx' });
    await rename(temp, file);
}

/**
 * Removes previous output. Only files written by the generator (recognized by their header) are deleted,
 * so pointing the output at a directory with hand-written code never destroys it. `outDir` must already be checked
 * to be inside the root and free of symlinks.
 */
async function cleanGenerated(outDir: string): Promise<void> {
    await mkdir(outDir, { recursive: true });
    for (const entry of await readdir(outDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
        const file = path.join(outDir, entry.name);
        if ((await readFile(file, 'utf8')).startsWith(GENERATED_MARKER)) await rm(file);
    }
}

interface Manifest {
    version: 1;
    /** Root-relative, `/`-separated paths. */
    files: string[];
}

async function readManifest(root: string): Promise<string[]> {
    try {
        const m: { version?: unknown; files?: unknown } = JSON.parse(await readFile(path.join(root, MANIFEST_FILE), 'utf8'));
        // the file may have been crafted: entries that would leave the root are dropped
        return m.version === 1 && Array.isArray(m.files) ? m.files.filter((f) => typeof f === 'string' && f !== '' && staysInside(f)) : [];
    } catch {
        return [];
    }
}

/** Records the generated files; false when `.domaintrail` is not a plain directory (never written through a symlink). */
async function writeManifest(root: string, files: string[]): Promise<boolean> {
    const target = path.join(root, MANIFEST_FILE);
    const dir = path.dirname(target);
    const existing = await lstat(dir).catch(() => undefined);
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) return false;
    await mkdir(dir, { recursive: true });
    const manifest: Manifest = { version: 1, files: [...files].sort() };
    await writeNew(target, `${JSON.stringify(manifest, null, 2)}\n`);
    return true;
}

/**
 * Deletes files of the previous run that this run does not write. Like cleanGenerated, only files with the generator's
 * header are deleted, only inside the root and never through a symlinked directory; a directory left empty is removed
 * too (never the root itself).
 */
async function removeStale(root: string, previous: string[], written: Set<string>): Promise<void> {
    for (const rel of previous) {
        const file = path.resolve(root, rel);
        if (written.has(file) || !file.endsWith('.ts') || !staysInside(rel) || !isInside(root, file)) continue;
        const dir = path.dirname(file);
        if (await symlinkOnPath(root, dir)) continue;
        const stat = await lstat(file).catch(() => undefined);
        if (!stat?.isFile() || !(await isGeneratedOrMissing(file))) continue;
        await rm(file);
        if (dir !== root) await rmdir(dir).catch(() => {}); // fails unless empty
    }
}

const isInside = (root: string, p: string): boolean => {
    const rel = path.relative(root, p);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
