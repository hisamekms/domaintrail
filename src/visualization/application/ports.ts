import type { SourceFile } from '../../core/analyze.js';
import type { LaidOutGraph } from '../domain/graph/ir.js';
import type { LayoutEngine } from './layout-engine.js';

/**
 * What the view service needs from outside, defined here on its side (ADR 0025): the adapters implement these
 * structurally, so that visualization depends on none of them.
 */

/** The sources of a workspace: those its scope selects (`sources`, `.gitignore`, never outside the root). */
export interface WorkspaceReader {
    readSources(): Promise<readonly SourceFile[]>;
}

/** A resolved revision. */
export interface GitCommit {
    /** Full object name. */
    hash: string;
    subject: string;
    /** Committer date (ISO 8601). */
    date: string;
}

/** Revisions offered as baselines: branches, tags and the latest commits of HEAD. */
export interface GitRefs {
    branches: string[];
    tags: string[];
    commits: (GitCommit & { short: string })[];
}

/** A ref the repository does not have (or that does not name a commit). */
export class UnknownRevisionError extends Error {}

/** Read-only access to the git repository around a Live View workspace, for comparing the model with a revision. */
export interface GitRevisions {
    /** Resolves `ref` to a commit; rejects with `UnknownRevisionError` when it names none. */
    resolveCommit(ref: string): Promise<GitCommit>;
    /**
     * The sources of the workspace as they are in `commit`: the files below the workspace's root that match `sources`
     * (paths relative to the root, sorted).
     */
    sourcesAt(commit: string, sources: readonly string[]): Promise<SourceFile[]>;
    /** Branches, tags and the latest commits of HEAD; empty lists outside a repository or before the first commit. */
    listRefs(): Promise<GitRefs>;
    /** The git directories to watch for moving refs (`HEAD`, branches), or undefined outside a repository. */
    gitDirs(): Promise<string[] | undefined>;
}

/** Laid-out graphs by graph ID, as cached between refreshes. */
export type LayoutCache = Map<string, LaidOutGraph>;

/** The layout engine a cache was computed with: layouts of another engine, or another version of it, are not reused. */
export type LayoutEngineId = Pick<LayoutEngine, 'name' | 'version'>;

/** Where the layouts are kept between runs, apart from the DSL. */
export interface LayoutStore {
    /** The layouts saved for `engine`; empty when there are none, they cannot be read, or are another engine's. */
    load(engine: LayoutEngineId): Promise<LayoutCache>;
    /** Replaces the saved layouts with `layouts`, as laid out by `engine`. */
    save(engine: LayoutEngineId, layouts: ReadonlyMap<string, LaidOutGraph>): Promise<void>;
}
