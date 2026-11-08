// The sources of a workspace as one ZIP archive (`dt export sources`, the Live View's 「ソース一式をダウンロード」): the
// `.dt` and `.dtes` files `dt check` analyzes and the project's config file, with their folders, so that someone without
// the repository can open them and run `dt` on them elsewhere.
import { lstat, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { SourceSelection } from '../ports.js';
import { findDomainFiles } from './files.js';
import { gitReadableFiles, type GitFilesOptions } from './git-files.js';
import { zip, type ZipEntry } from './zip.js';

/** What a source archive is made of. */
export interface SourceArchiveOptions {
    /** The workspace root: the paths in the archive are relative to it. */
    readonly root: string;
    readonly selection: SourceSelection;
    /** The project's config file (absolute; in the root), if there is one. Its local override is never included. */
    readonly configFile?: string;
    /** The archive's top folder (default: the root's name; see `archiveName`). */
    readonly name?: string;
    readonly git?: GitFilesOptions;
}

/** A source archive. */
export interface SourceArchive {
    /** The top folder of the archive, also the base of its file name (`<name>-sources.zip`). */
    readonly name: string;
    /** The files in it, relative to the root, `/`-separated, sorted (the config file first). */
    readonly files: readonly string[];
    /** How many of them are sources (`.dt` and `.dtes` files): none, and there is nothing to share. */
    readonly sources: number;
    readonly zip: Buffer;
}

/** The file extensions of the DSL: only these are ever archived as sources, whatever the `sources` globs say. */
const DSL_FILE = /\.dt(es)?$/;
/** The local override of the configuration (`<name>.local.json[c]`): one person's own, never shared. */
const LOCAL_CONFIG = /\.local\.jsonc?$/;

/**
 * The name of a workspace rooted at `root`, usable as a file name on every system: its directory's name with the
 * characters Windows refuses replaced by `-`; `workspace` when nothing is left.
 */
export function archiveName(root: string): string {
    const name = path
        .basename(path.resolve(root))
        // oxlint-disable-next-line eslint/no-control-regex -- the control characters are what is replaced
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
        .replace(/^[.\s]+|[.\s]+$/g, '');
    return name || 'workspace';
}

/**
 * The files a source archive of the workspace holds, relative to the root, `/`-separated: the config file (when it is a
 * plain file in the root, not a local override), then the sources as `dt check` finds them (`findDomainFiles`: symlinks
 * are neither followed nor listed; `node_modules`, `.git` and `.domaintrail` are never walked), `.dt` and `.dtes` files
 * only. When git speaks for the root, only the files it does not ignore — whatever `respectGitignore` says, since an
 * ignored file is nobody's to share.
 */
export async function sourceArchiveFiles(options: Omit<SourceArchiveOptions, 'name'>): Promise<string[]> {
    const root = path.resolve(options.root);
    const sources = (await findDomainFiles(root, options.selection)).map(toPosix).filter((f) => DSL_FILE.test(f));
    const config = await configEntry(root, options.configFile);
    const files = [...(config ? [config] : []), ...sources];
    const readable = await gitReadableFiles(root, options.git ?? {});
    if (!readable) return files;
    const kept = new Set(readable.map((f) => f.normalize('NFC')));
    return files.filter((f) => kept.has(f.normalize('NFC')));
}

/** The config file's path relative to the root, when it is a plain file directly in it and not a local override. */
async function configEntry(root: string, file: string | undefined): Promise<string | undefined> {
    if (file === undefined) return undefined;
    const absolute = path.resolve(file);
    if (path.dirname(absolute) !== root || LOCAL_CONFIG.test(absolute)) return undefined;
    const info = await lstat(absolute).catch(() => undefined);
    return info?.isFile() ? path.basename(absolute) : undefined;
}

/**
 * The source archive of the workspace as it is on disk now: `sourceArchiveFiles`, each below a top folder named after
 * the workspace (`shop/sales/order.dt`), with its modification time. A file that became anything but a plain file since
 * it was listed (a symlink, removed) is left out.
 */
export async function createSourceArchive(options: SourceArchiveOptions): Promise<SourceArchive> {
    const root = path.resolve(options.root);
    const name = options.name ?? archiveName(root);
    const entries: ZipEntry[] = [];
    const files: string[] = [];
    for (const file of await sourceArchiveFiles(options)) {
        const absolute = path.join(root, ...file.split('/'));
        const info = await lstat(absolute).catch(() => undefined);
        if (!info?.isFile()) continue;
        const data = await readFile(absolute).catch(() => undefined);
        if (!data) continue;
        entries.push({ path: `${name}/${file}`, data, mtime: info.mtime });
        files.push(file);
    }
    return { name, files, sources: files.filter((f) => DSL_FILE.test(f)).length, zip: zip(entries) };
}

const toPosix = (p: string): string => p.split(path.sep).join('/');
