// Snapshots of the workspace, between transactions: read the sources, keep their bytes as blobs, validate them; and
// read a revision's sources back from the blobs.
import { Collaboration, err, ok, type Result } from '../generated/index.js';
import { comparePaths, snapshotFile, snapshotHash, workspacePath } from '../domain/snapshot.js';
import { summarize } from '../domain/validation.js';
import type { CollaborationDeps, ValidationResult, WorkspaceScan } from './ports.js';

/** The blobs of a revision's files are gone (or no longer hold their content): it cannot be read back. */
export interface BlobMissing {
    readonly type: 'BlobMissing';
    readonly path: Collaboration.WorkspacePath;
    readonly hash: Collaboration.ContentHash;
}

/** A snapshot of the workspace, stored as blobs and validated, ready to be recorded as a revision. */
export interface Captured {
    readonly files: readonly Collaboration.SnapshotFile[];
    readonly contentHash: Collaboration.ContentHash;
    readonly validation: Collaboration.ValidationSummary;
    readonly analysis: ValidationResult;
}

const decoder = new TextDecoder();

/** Validates sources given by bytes (UTF-8). */
async function validate(deps: Pick<CollaborationDeps, 'validator'>, files: readonly { path: string; bytes: Uint8Array }[]): Promise<ValidationResult> {
    return deps.validator.validate(files.map((f) => ({ path: f.path, text: decoder.decode(f.bytes) })));
}

/**
 * Reads the workspace's sources (or takes a scan already read), stores their bytes as blobs and validates them. A path
 * that is not a workspace path (outside the root) is refused; symbolic links are not sources and are not read.
 */
export async function capture(
    deps: Pick<CollaborationDeps, 'workspace' | 'blobs' | 'validator'>,
    scanned?: WorkspaceScan,
): Promise<Result<Captured, Collaboration.PathOutsideRoot>> {
    const scan = scanned ?? (await deps.workspace.read());
    const files: Collaboration.SnapshotFile[] = [];
    for (const f of scan.files) {
        const p = workspacePath(f.path);
        if (!p.ok) return p;
        const hash = Collaboration.makeContentHash(f.hash);
        if (!hash.ok) throw new Error(`The workspace adapter gave ${f.path} a hash that is not a SHA-256: ${f.hash}`);
        files.push(snapshotFile(p.value, f.bytes, hash.value));
    }
    files.sort((a, b) => comparePaths(a.path, b.path));
    await deps.blobs.put(scan.files);
    const analysis = await validate(deps, scan.files);
    return ok({ files, contentHash: snapshotHash(files), validation: summarize(analysis.diagnostics, false), analysis });
}

/** The sources of a revision, read back from the blobs. */
export async function sourcesOf(
    deps: Pick<CollaborationDeps, 'blobs'>,
    revision: Collaboration.Revision,
): Promise<Result<{ path: Collaboration.WorkspacePath; bytes: Uint8Array }[], BlobMissing>> {
    const out: { path: Collaboration.WorkspacePath; bytes: Uint8Array }[] = [];
    for (const f of revision.files) {
        const bytes = await deps.blobs.get(f.hash);
        if (!bytes) return err({ type: 'BlobMissing', path: f.path, hash: f.hash });
        out.push({ path: f.path, bytes });
    }
    return ok(out);
}

/** Validates the sources of a revision, read back from the blobs. */
export async function analysisOf(
    deps: Pick<CollaborationDeps, 'blobs' | 'validator'>,
    revision: Collaboration.Revision,
): Promise<Result<ValidationResult, BlobMissing>> {
    const sources = await sourcesOf(deps, revision);
    if (!sources.ok) return sources;
    return ok(await validate(deps, sources.value));
}
