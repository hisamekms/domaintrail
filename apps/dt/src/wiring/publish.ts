// `dt publish` wired (ADR 0031, section 11): the workspace's stormings laid out as the Live View lays them out (from
// scratch, as `dt export svg` does: the same sources always give the same drawing), each dated by the last commit that
// changed its file, and sent to the `cloudflare` store's Worker — opened by `openKnowledgeStore`, with the proof that
// the knowledge settings were approved — or written as JSON files into a directory (`--out`), which sends nothing.
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { KnowledgeStoreError, type Knowledge, type StormingPublisher } from '@domaintrail/knowledge';
import { gitLastCommit, type FileCommit } from '@domaintrail/workspace';
import type { DiagramViews, PublishOptions, PublishReport, SourcesExportOptions } from '../cli/ports.js';
import { chosenStormings, publishedForm, PublishError } from '../cli/publish.js';
import { loadDiagramViews } from './diagram.js';
import { openKnowledgeStore, type KnowledgeStoreOptions } from './knowledge.js';

export interface PublishDeps extends KnowledgeStoreOptions {
    /** The workspace's views (default: laid out from scratch, `loadDiagramViews`). */
    readonly views?: (options: SourcesExportOptions) => Promise<DiagramViews>;
    /** The last commit of a file (default: git's, `gitLastCommit`). */
    readonly lastCommit?: (root: string, file: string) => Promise<FileCommit | undefined>;
}

/** Where the published forms go: the Worker and the project. */
interface Destination {
    readonly publisher: StormingPublisher;
    readonly project: Knowledge.ProjectName;
}

/** The workspace's store, if it has a page to publish to and its settings are approved; else why not. */
async function destination(options: PublishOptions, deps: PublishDeps): Promise<Destination> {
    const opened = await openKnowledgeStore(options.config, options.approval, deps);
    if (!opened.ok) throw new PublishError(`Not published: ${opened.error.message}`, 1);
    if (!opened.value.publisher)
        throw new PublishError(
            `Not published: the knowledge store '${opened.value.kind}' has no read-only page to publish to; publishing needs knowledge.store "cloudflare" (or --out <dir> to write the published form as files).`,
            1,
        );
    return { publisher: opened.value.publisher, project: opened.value.project };
}

export async function publishStormings(options: PublishOptions, deps: PublishDeps = {}): Promise<PublishReport> {
    const { config: cfg, log } = options;
    if (options.prune && options.out !== undefined) throw new PublishError('--prune removes what the Worker keeps: it does not go with --out.', 2);
    const now = deps.now ?? ((): Date => new Date());
    const lastCommit = deps.lastCommit ?? ((root: string, file: string): Promise<FileCommit | undefined> => gitLastCommit(root, file));
    // the destination first: nothing is laid out for a store that cannot take it
    const to = options.out === undefined ? await destination(options, deps) : undefined;

    const views = await (deps.views ?? loadDiagramViews)({ root: cfg.root, sources: cfg.sources, respectGitignore: cfg.respectGitignore });
    try {
        if (options.prune) {
            // a .dtes file with an error may hold a storming that is not drawn (it does not parse, or its ID is taken):
            // pruning then would remove one the workspace still has, so nothing is sent
            const broken = [...new Set(views.payload.diagnostics.filter((d) => d.severity === 'error' && d.file.endsWith('.dtes')).map((d) => d.file))];
            if (broken.length)
                throw new PublishError(`Not published: --prune needs every .dtes file without errors (${broken.join(', ')}): run \`dt check\`.`, 1);
        }
        const stormings = chosenStormings(views.payload.stormings, options.stormings);
        if (stormings.length === 0) throw new PublishError(`No storming to publish: the workspace has no .dtes file (sources: ${cfg.sources.join(', ')}).`, 1);
        const report: PublishReport = { published: [] };
        for (const view of stormings) {
            const committed = await lastCommit(cfg.root, view.file);
            if (committed?.changed) log(`${view.id}: ${view.file} differs from its last commit; dated now, without a commit`);
            const form = publishedForm(view, committed && !committed.changed ? { at: committed.at, commit: committed.commit } : { at: now() });
            if (options.out !== undefined) {
                const file = path.join(path.resolve(options.out), `${view.id}.json`);
                await mkdir(path.dirname(file), { recursive: true });
                await writeFile(file, `${JSON.stringify(form, null, 2)}\n`);
                report.published.push({ storming: view.id, version: form.version, ...(form.drawing.commit && { commit: form.drawing.commit }), file });
                continue;
            }
            if (!to) continue;
            const result = await to.publisher.publish(to.project, form).catch((e: unknown) => {
                const done = report.published.map((p) => p.storming);
                const message = e instanceof KnowledgeStoreError ? e.message : e instanceof Error ? e.message : String(e);
                throw new PublishError(`Not published: ${view.id}: ${message}${done.length ? ` (published before it: ${done.join(', ')})` : ''}`, 1);
            });
            report.published.push({
                storming: view.id,
                version: form.version,
                ...(form.drawing.commit && { commit: form.drawing.commit }),
                changed: result.changed,
            });
        }
        // only after every storming was published
        if (options.prune && to)
            report.removed = await prune(
                to,
                views.payload.stormings.map((s) => s.id),
            );
        return report;
    } finally {
        views.dispose();
    }
}

/**
 * Removes from the Worker the published stormings that the workspace no longer has (`--prune`): removed or renamed
 * since they were published. The knowledge about their stickies stays, listed apart on the page.
 */
async function prune(to: Destination, kept: readonly string[]): Promise<string[]> {
    const removed: string[] = [];
    const fail = (e: unknown, what: string): never => {
        const message = e instanceof Error ? e.message : String(e);
        throw new PublishError(`Not pruned: ${what}: ${message}${removed.length ? ` (removed before it: ${removed.join(', ')})` : ''}`, 1);
    };
    const published = await to.publisher.published(to.project).catch((e: unknown) => fail(e, 'the published stormings'));
    for (const { storming } of published.filter((e) => !kept.includes(e.storming))) {
        if (await to.publisher.unpublish(to.project, storming).catch((e: unknown) => fail(e, storming))) removed.push(storming);
    }
    return removed;
}
