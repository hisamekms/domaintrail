// The `files` adapter of `KnowledgeStore` (ADR 0031, section 5): one Markdown file per item in the workspace's
// `knowledge/` (`domain/item-file.ts` says the format), the images beside them in `knowledge/images/`, versions left to
// git.
//
// **For workspaces without personal data only.** Everything here is meant to be committed, and git's history cannot
// forget: an item deleted here is gone from the working tree at once, but stays in every commit that had it (ADR 0031,
// section 7). A workspace where personal data may be spoken uses the `cloudflare` store.
//
// What it keeps, and where:
//
// - `knowledge/<id>.md`: the live items, one per file;
// - `knowledge/images/<img_…>.<ext>`: the images (`image:<id>` in the text);
// - `knowledge/audit.jsonl`: the audit log, one JSON record per line, appended (who changed what, and the extraction's
//   reason; no text, no quote);
// - `knowledge/redactions.jsonl`: the redaction log, IDs only, appended and kept for good, so that every clone's dt
//   redacts its own session database (it reaches them through git);
// - `knowledge/.gitattributes`: the two logs merge with `union`, so that sessions on two branches do not conflict;
// - in the state directory the app gives (outside the workspace, never committed): `deleted/<id>.md`, the items
//   deleted within the undo window, and `extractions.jsonl`, the extractions applied (the idempotency keys).
//
// Deleting moves the item's file out of the workspace into `deleted/` at once (it no longer shows in the tree, in a
// diff or in any read). `restore` moves it back within the undo window; the sweep — run first by every write, and
// callable on a timer — removes it for good after that window: its file, the images only it referred to, the reasons
// of its audit records, and appends its redaction.
//
// Idempotency is kept in the state directory because only the dt that runs a session sends its extractions (a retry
// comes from the same machine, within seconds), and the record of a replay — which operations were dropped — is of no
// use to anyone else. A record holds the item IDs and the indexes of the dropped operations with their reasons, never
// the operations' text; a replay is answered with those items as they are now.
//
// Writes are atomic per file (a temporary file, then a rename) and an extraction's items are all written to temporary
// files before any is renamed: a failure while writing leaves nothing applied. One process writes (the session's dt);
// its calls that write run one at a time. Reads take no lock: a file is replaced by a rename, never seen half-written.
import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { err, Knowledge, ok, type Result } from '../generated/index.js';
import { applyExtraction as applyOperations, idempotencyKey, type DropReason } from '../domain/extraction.js';
import { knowledgeItemCommands } from '../domain/items.js';
import { auditOf, imagesIn, redactionOf, sourceMessages, withoutReason } from '../domain/records.js';
import { IMAGES_DIR, idOfFileName, itemFileName, printItemFile, readItemFile } from '../domain/item-file.js';
import type { KnowledgeFile } from '../domain/check.js';
import type {
    AppliedExtraction,
    AuditQuery,
    Deletion,
    ItemWithHistory,
    KnowledgeImage,
    KnowledgeQuery,
    KnowledgeStore,
    Page,
    RedactionEntry,
    StickyCount,
} from '../application/ports.js';

export const AUDIT_FILE = 'audit.jsonl';
export const REDACTIONS_FILE = 'redactions.jsonl';
const GITATTRIBUTES = `${AUDIT_FILE} merge=union\n${REDACTIONS_FILE} merge=union\n`;
const DELETED_DIR = 'deleted';
const EXTRACTIONS_FILE = 'extractions.jsonl';
/** The extractions remembered: a retry comes within seconds, so the last ones suffice. */
const EXTRACTIONS_KEPT = 500;

/** How long a deleted item can be restored: the page's undo is 10 seconds (ADR 0031, section 7); this leaves slack. */
export const DEFAULT_UNDO_WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
};

export interface FilesKnowledgeStoreOptions {
    /** The workspace's knowledge directory (`<root>/knowledge`, `KNOWLEDGE_DIR`). */
    readonly dir: string;
    /** The project the workspace names: the one every call must name. */
    readonly project: Knowledge.ProjectName;
    /** A directory of the workspace's state, outside the workspace: the deleted items and the extractions applied. */
    readonly stateDir: string;
    /** How long a deleted item can be restored (`DEFAULT_UNDO_WINDOW_MS`). */
    readonly undoWindowMs?: number;
    /** The clock (tests). */
    readonly now?: () => Date;
}

export interface FilesKnowledgeStore extends KnowledgeStore {
    /**
     * Removes for good the items deleted longer ago than the undo window (see the module's comment). Every call that
     * writes runs it first; the app may also run it on a timer, so that a deletion completes while nothing is written.
     */
    sweep(): Promise<void>;
}

/** The items' files of a knowledge directory with their texts, for `dt check` (none when the directory is absent). */
export async function readKnowledgeFiles(dir: string, relativeTo: string): Promise<KnowledgeFile[]> {
    const names = await listDir(dir);
    const files: KnowledgeFile[] = [];
    for (const name of names.filter((n) => idOfFileName(n) !== undefined).sort()) {
        const text = await readText(path.join(dir, name));
        if (text !== undefined) files.push({ path: path.relative(relativeTo, path.join(dir, name)).split(path.sep).join('/'), text });
    }
    return files;
}

// ---- files ----

const isMissing = (e: unknown): boolean => e instanceof Error && 'code' in e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');

async function listDir(dir: string): Promise<string[]> {
    return readdir(dir).catch((e: unknown) => {
        if (isMissing(e)) return [];
        throw e;
    });
}

async function readText(file: string): Promise<string | undefined> {
    return readFile(file, 'utf8').catch((e: unknown) => {
        if (isMissing(e)) return undefined;
        throw e;
    });
}

const temporary = (file: string): string => path.join(path.dirname(file), `.${path.basename(file)}.tmp-${randomBytes(6).toString('hex')}`);

/** Writes several files, each whole: all to temporary files first, then each renamed into place. */
async function writeAll(files: readonly { readonly file: string; readonly data: string | Uint8Array }[]): Promise<void> {
    const staged: { tmp: string; file: string }[] = [];
    try {
        for (const { file, data } of files) {
            const tmp = temporary(file);
            staged.push({ tmp, file });
            await writeFile(tmp, data);
        }
    } catch (e) {
        await Promise.all(staged.map(({ tmp }) => rm(tmp, { force: true })));
        throw e;
    }
    for (const { tmp, file } of staged) await rename(tmp, file);
}

const lines = (text: string | undefined): string[] =>
    text === undefined || text === '' ? [] : text.split('\n').filter((l, i, all) => l !== '' || i < all.length - 1);

function randomId(prefix: string): string {
    return prefix + [...randomBytes(16)].map((b) => (b % 36).toString(36)).join('');
}

// ---- the logs' records ----

function auditJson(entry: Knowledge.AuditEntry): string {
    const actor = entry.actor.kind === 'Extractor' ? { kind: 'Extractor', extraction: entry.actor.extraction } : { kind: 'Person', user: entry.actor.user };
    return JSON.stringify({
        item: entry.item,
        version: entry.version,
        operation: entry.operation,
        actor,
        ...(entry.reason !== undefined && { reason: entry.reason }),
        at: entry.at.toISOString(),
    });
}

const AUDIT_OPERATIONS: readonly Knowledge.AuditOperation[] = ['add', 'addSource', 'rewrite', 'revise', 'linkConflict', 'correct', 'delete', 'restore', 'unlinkConflict'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const number = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);

function parsed(line: string): unknown {
    try {
        return JSON.parse(line);
    } catch {
        return undefined;
    }
}

function actorOfJson(a: unknown): Knowledge.Actor | undefined {
    if (!isRecord(a)) return undefined;
    if (a.kind === 'Person') {
        const user = Knowledge.makeUserName(text(a.user));
        return user.ok ? { kind: 'Person', user: user.value } : undefined;
    }
    if (a.kind !== 'Extractor' || !isRecord(a.extraction)) return undefined;
    const session = Knowledge.makeSessionRef(text(a.extraction.session));
    const n = Knowledge.makeExtractionNumber(number(a.extraction.number));
    return session.ok && n.ok ? { kind: 'Extractor', extraction: { session: session.value, number: n.value } } : undefined;
}

/** An audit record read back, or `undefined` for a line that is not one (a hand edit): it is skipped. */
function auditOfJson(line: string): Knowledge.AuditEntry | undefined {
    const r = parsed(line);
    if (!isRecord(r)) return undefined;
    const item = Knowledge.makeKnowledgeItemId(text(r.item));
    const version = Knowledge.makeItemVersion(number(r.version));
    const operation = AUDIT_OPERATIONS.find((o) => o === r.operation);
    const at = new Date(text(r.at));
    const actor = actorOfJson(r.actor);
    const reason = r.reason === undefined ? undefined : Knowledge.makeReason(text(r.reason));
    if (!item.ok || !version.ok || !operation || !actor || Number.isNaN(at.getTime()) || (reason && !reason.ok)) return undefined;
    return { item: item.value, version: version.value, operation, actor, ...(reason?.ok && { reason: reason.value }), at };
}

function redactionOfJson(line: string): Knowledge.Redaction | undefined {
    const r = parsed(line);
    if (!isRecord(r) || !Array.isArray(r.messages)) return undefined;
    const item = Knowledge.makeKnowledgeItemId(text(r.item));
    if (!item.ok) return undefined;
    const messages: Knowledge.MessageKey[] = [];
    for (const m of r.messages as unknown[]) {
        if (!isRecord(m)) return undefined;
        const session = Knowledge.makeSessionRef(text(m.session));
        const message = Knowledge.makeMessageRef(text(m.message));
        if (!session.ok || !message.ok) return undefined;
        messages.push({ session: session.value, message: message.value });
    }
    return { item: item.value, messages };
}

/** The redaction log's cursor: how many lines were read, and a digest of them (a merge may put lines before it). */
const digest = (read: readonly string[]): string => createHash('sha256').update(read.join('\n')).digest('hex').slice(0, 16);
const redactionCursor = (all: readonly string[], n: number): string => `${n}:${digest(all.slice(0, n))}`;

/** An extraction applied, as remembered for a replay: no operation's text, only indexes. */
interface AppliedRecord {
    readonly key: string;
    readonly items: readonly string[];
    readonly dropped: readonly { readonly index: number; readonly reason: DropReason }[];
}

/** A record of the state directory, which only this store writes: its shape is checked, not its values. */
function isAppliedRecord(r: unknown): r is AppliedRecord {
    return (
        isRecord(r) &&
        typeof r.key === 'string' &&
        Array.isArray(r.items) &&
        Array.isArray(r.dropped) &&
        r.dropped.every((d: unknown) => isRecord(d) && typeof d.index === 'number' && isRecord(d.reason) && typeof d.reason.type === 'string')
    );
}

// ---- items in a page ----

/** Newest first: by the time an item was made, then by ID. */
const newestFirst = (a: Knowledge.KnowledgeItemCommon, b: Knowledge.KnowledgeItemCommon): number =>
    b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

const itemCursor = (item: Knowledge.KnowledgeItemCommon): string => `${item.createdAt.getTime()}:${item.id}`;

function afterItemCursor(cursor: string): (item: Knowledge.KnowledgeItemCommon) => boolean {
    const m = /^(\d+):(kn_[0-9a-z]+)$/.exec(cursor);
    if (!m) throw new Error(`Not a cursor of the knowledge store: ${cursor}`);
    const time = Number(m[1]);
    const id = m[2];
    return (item) => item.createdAt.getTime() < time || (item.createdAt.getTime() === time && item.id < id);
}

const limitOf = (limit: number | undefined): number => Math.min(Math.max(Math.floor(limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);

const known = <T>(r: Result<T, never>): T => {
    if (!r.ok) throw new Error('A command that cannot fail failed.');
    return r.value;
};

// ---- the store ----

/** The `files` store of one workspace (see the module's comment). */
export function createFilesKnowledgeStore(options: FilesKnowledgeStoreOptions): FilesKnowledgeStore {
    const { dir, stateDir } = options;
    const deletedDir = path.join(stateDir, DELETED_DIR);
    const imagesDir = path.join(dir, IMAGES_DIR);
    const undoWindow = options.undoWindowMs ?? DEFAULT_UNDO_WINDOW_MS;
    const now = options.now ?? (() => new Date());

    const checkProject = (project: Knowledge.ProjectName): void => {
        if (project !== options.project) throw new Error(`This knowledge store is project '${options.project}', not '${project}'.`);
    };

    let queue: Promise<unknown> = Promise.resolve();
    /** Runs the calls that write one at a time, each after the sweep. */
    function exclusive<T>(f: () => Promise<T>): Promise<T> {
        const run = queue.then(async () => {
            await sweepNow();
            return f();
        });
        queue = run.catch(() => undefined);
        return run;
    }

    // ---- reading items

    /** The items of a directory that read, and the IDs of the files that do not (skipped; `dt check` reports them). */
    async function itemsIn(from: string): Promise<{ items: Map<Knowledge.KnowledgeItemId, Knowledge.KnowledgeItem>; unreadable: Set<string> }> {
        const items = new Map<Knowledge.KnowledgeItemId, Knowledge.KnowledgeItem>();
        const unreadable = new Set<string>();
        for (const name of await listDir(from)) {
            const id = idOfFileName(name);
            if (id === undefined) continue;
            const text = await readText(path.join(from, name));
            if (text === undefined) continue;
            const read = readItemFile(text, name);
            if (read.ok) items.set(read.value.item.id, read.value.item);
            else unreadable.add(id);
        }
        return { items, unreadable };
    }

    async function liveItems(): Promise<Knowledge.LiveKnowledgeItem[]> {
        const { items } = await itemsIn(dir);
        return [...items.values()].filter((i): i is Knowledge.LiveKnowledgeItem => i.state === 'Live');
    }

    async function readOne(from: string, id: Knowledge.KnowledgeItemId): Promise<Knowledge.KnowledgeItem | undefined> {
        const name = itemFileName(id);
        const text = await readText(path.join(from, name));
        if (text === undefined) return undefined;
        const read = readItemFile(text, name);
        return read.ok ? read.value.item : undefined;
    }

    async function liveOne(id: Knowledge.KnowledgeItemId): Promise<Knowledge.LiveKnowledgeItem | undefined> {
        const item = await readOne(dir, id);
        return item?.state === 'Live' ? item : undefined;
    }

    async function deletedOne(id: Knowledge.KnowledgeItemId): Promise<Knowledge.DeletedKnowledgeItem | undefined> {
        const item = await readOne(deletedDir, id);
        return item?.state === 'Deleted' ? item : undefined;
    }

    // ---- writing

    async function writeItems(items: readonly Knowledge.KnowledgeItem[], into: string): Promise<void> {
        if (items.length === 0) return;
        await mkdir(into, { recursive: true, mode: into === deletedDir ? 0o700 : undefined });
        await writeAll(items.map((item) => ({ file: path.join(into, itemFileName(item.id)), data: printItemFile(item) })));
    }

    async function ensureGitattributes(): Promise<void> {
        const file = path.join(dir, '.gitattributes');
        if ((await readText(file)) === undefined) await writeFile(file, GITATTRIBUTES, { flag: 'wx' }).catch(() => undefined);
    }

    async function appendLines(file: string, records: readonly string[]): Promise<void> {
        if (records.length === 0) return;
        await mkdir(path.dirname(file), { recursive: true });
        if (path.dirname(file) === dir) await ensureGitattributes();
        await appendFile(file, records.map((r) => `${r}\n`).join(''));
    }

    const appendAudit = (entries: readonly Knowledge.AuditEntry[]): Promise<void> => appendLines(path.join(dir, AUDIT_FILE), entries.map(auditJson));

    async function readApplied(): Promise<AppliedRecord[]> {
        return lines(await readText(path.join(stateDir, EXTRACTIONS_FILE))).flatMap((l) => {
            const r = parsed(l);
            return isAppliedRecord(r) ? [r] : [];
        });
    }

    async function remember(record: AppliedRecord): Promise<void> {
        const file = path.join(stateDir, EXTRACTIONS_FILE);
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        const kept = lines(await readText(file));
        if (kept.length < EXTRACTIONS_KEPT) await appendFile(file, `${JSON.stringify(record)}\n`);
        else await writeAll([{ file, data: [...kept.slice(-EXTRACTIONS_KEPT / 2), JSON.stringify(record)].map((l) => `${l}\n`).join('') }]);
    }

    // ---- the sweep

    async function sweepNow(): Promise<void> {
        const { items } = await itemsIn(deletedDir);
        const due = [...items.values()].filter(
            (i): i is Knowledge.DeletedKnowledgeItem => i.state === 'Deleted' && i.deletedAt.getTime() + undoWindow <= now().getTime(),
        );
        if (due.length === 0) return;
        const dueIds = new Set<string>(due.map((i) => i.id));
        // the redactions first: a sweep cut short is run again, and redacting a message twice is harmless
        await appendLines(
            path.join(dir, REDACTIONS_FILE),
            due.map((i) => JSON.stringify(redactionOf(i))),
        );
        // the reasons of their audit records (an extraction's reason may quote someone)
        const auditFile = path.join(dir, AUDIT_FILE);
        const auditLines = lines(await readText(auditFile));
        let changed = false;
        const rewritten = auditLines.map((l) => {
            const entry = auditOfJson(l);
            if (entry === undefined || !dueIds.has(entry.item) || entry.reason === undefined) return l;
            changed = true;
            return auditJson(withoutReason(entry));
        });
        if (changed) await writeAll([{ file: auditFile, data: rewritten.map((l) => `${l}\n`).join('') }]);
        // the images only they referred to
        const kept = [...(await liveItems()), ...[...items.values()].filter((i) => !dueIds.has(i.id))];
        const stillUsed = new Set<string>(kept.flatMap((i) => imagesIn(i.content.text)));
        const images = await listDir(imagesDir);
        for (const id of new Set(due.flatMap((i) => imagesIn(i.content.text))))
            if (!stillUsed.has(id)) for (const name of images.filter((n) => n.startsWith(`${id}.`))) await rm(path.join(imagesDir, name), { force: true });
        for (const item of due) await rm(path.join(deletedDir, itemFileName(item.id)), { force: true });
    }

    // ---- deleting

    async function deleteNow(item: Knowledge.LiveKnowledgeItem, by: Knowledge.UserName): Promise<Deletion> {
        const { aggregate, events } = known(knowledgeItemCommands.delete(item, { by, at: now() })).Deleted;
        await writeItems([aggregate], deletedDir);
        await rm(path.join(dir, itemFileName(item.id)), { force: true });
        await appendAudit([auditOf(events.KnowledgeItemDeleted)]);
        return { items: [item.id], messages: sourceMessages(item) };
    }

    return {
        sweep: () => exclusive(async () => undefined),

        async about(project, stickies) {
            checkProject(project);
            const wanted = new Set<string>(stickies);
            return (await liveItems()).filter((i) => i.content.about.some((a) => wanted.has(a))).sort(newestFirst);
        },

        async search(project, query: KnowledgeQuery): Promise<Page<Knowledge.LiveKnowledgeItem>> {
            checkProject(project);
            const about = query.about && new Set<string>(query.about);
            const terms = (query.q ?? '')
                .toLowerCase()
                .split(/\s+/)
                .filter((t) => t !== '');
            const after = query.cursor === undefined ? undefined : afterItemCursor(query.cursor);
            const matching = (await liveItems())
                .filter((i) => {
                    const { labels } = i.content;
                    if (about && !i.content.about.some((a) => about.has(a))) return false;
                    if (query.when && !query.when.includes(labels.when)) return false;
                    if (query.kind && !query.kind.includes(labels.kind)) return false;
                    if (query.origin && !query.origin.includes(labels.origin)) return false;
                    if (query.perspective !== undefined && labels.perspective !== query.perspective) return false;
                    if (query.session !== undefined && i.createdIn !== query.session) return false;
                    if (terms.length > 0) {
                        const haystack = [i.content.text, ...i.sources.map((s) => s.quote)].join('\n').toLowerCase();
                        if (!terms.every((t) => haystack.includes(t))) return false;
                    }
                    return after === undefined || after(i);
                })
                .sort(newestFirst);
            const limit = limitOf(query.limit);
            const items = matching.slice(0, limit);
            return matching.length > limit ? { items, next: itemCursor(items[items.length - 1]) } : { items };
        },

        async counts(project, storming): Promise<readonly StickyCount[]> {
            checkProject(project);
            const live = await liveItems();
            const liveIds = new Set<string>(live.map((i) => i.id));
            const counts = new Map<Knowledge.StickyRef, StickyCount>();
            for (const item of live) {
                // a conflict counts while its other side is live
                const conflict = item.conflictsWith.some((id) => liveIds.has(id));
                for (const sticky of item.content.about) {
                    if (!sticky.startsWith(`${storming}.`)) continue;
                    const was = counts.get(sticky);
                    counts.set(sticky, { sticky, hasItems: true, hasConflict: (was?.hasConflict ?? false) || conflict });
                }
            }
            return [...counts.values()].sort((a, b) => (a.sticky < b.sticky ? -1 : a.sticky > b.sticky ? 1 : 0));
        },

        /** The live item. Its `history` is always empty: the files store keeps no past versions; git's history has them. */
        async get(project, id, opts): Promise<ItemWithHistory | undefined> {
            checkProject(project);
            const item = await liveOne(id);
            if (item === undefined) return undefined;
            return opts?.history ? { item, history: [] } : { item };
        },

        /**
         * Applies the extraction (`domain/extraction.ts`). An operation on an item whose file does not read is dropped
         * (the item not found, or, for a new item's ID, existing), so that a file a person broke is never written over.
         * The past versions the operations replace are not kept (git has them).
         */
        async applyExtraction(project, extraction): Promise<AppliedExtraction> {
            checkProject(project);
            return exclusive(async () => {
                const key = idempotencyKey(extraction.by);
                const before = (await readApplied()).find((r) => r.key === key);
                if (before) {
                    const ids = before.items.flatMap((id) => {
                        const made = Knowledge.makeKnowledgeItemId(id);
                        return made.ok ? [made.value] : [];
                    });
                    const items = await Promise.all(ids.map(liveOne));
                    return {
                        items: items.filter((i) => i !== undefined),
                        dropped: before.dropped.flatMap(({ index, reason }) => {
                            const operation = extraction.operations[index];
                            return operation ? [{ operation, reason }] : [];
                        }),
                        replayed: true,
                    };
                }
                const live = await itemsIn(dir);
                const deleted = await itemsIn(deletedDir);
                const unreadable = new Set([...live.unreadable, ...deleted.unreadable]);
                const blocked: { index: number; reason: DropReason }[] = [];
                const kept: { index: number; operation: Knowledge.Operation }[] = [];
                extraction.operations.forEach((operation, index) => {
                    const reason = blockedBy(operation, unreadable);
                    if (reason) blocked.push({ index, reason });
                    else kept.push({ index, operation });
                });
                const outcome = applyOperations(
                    { by: extraction.by, operations: kept.map((k) => k.operation) },
                    (id) => live.items.get(id) ?? deleted.items.get(id),
                    now(),
                );
                const indexOf = (operation: Knowledge.Operation): number => kept.find((k) => k.operation === operation)?.index ?? -1;
                const dropped = [...blocked, ...outcome.dropped.map((d) => ({ index: indexOf(d.operation), reason: d.reason }))].sort(
                    (a, b) => a.index - b.index,
                );
                const items = outcome.items.filter((i): i is Knowledge.LiveKnowledgeItem => i.state === 'Live');
                await mkdir(dir, { recursive: true });
                await writeItems(items, dir);
                await appendAudit(outcome.applied.flatMap((a) => a.changes.map((c) => auditOf(c.event))));
                await remember({ key, items: items.map((i) => i.id), dropped });
                return {
                    items,
                    dropped: dropped.map(({ index, reason }) => ({ operation: extraction.operations[index], reason })),
                    replayed: false,
                };
            });
        },

        async correct(project, id, corrected, by) {
            checkProject(project);
            return exclusive(async (): Promise<Result<Knowledge.LiveKnowledgeItem, Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone>> => {
                const item = await liveOne(id);
                if (item === undefined)
                    return (await deletedOne(id)) ? err({ type: 'KnowledgeItemGone', itemId: id }) : err({ type: 'KnowledgeItemNotFound', itemId: id });
                const { aggregate, events } = known(knowledgeItemCommands.correct(item, { corrected, by, at: now() })).Live;
                await writeItems([aggregate], dir);
                await appendAudit([auditOf(events.KnowledgeItemCorrected)]);
                return ok(aggregate);
            });
        },

        async unlinkConflict(project, id, other, by) {
            checkProject(project);
            return exclusive(async (): Promise<Result<readonly Knowledge.LiveKnowledgeItem[], Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone>> => {
                const item = await liveOne(id);
                if (item === undefined)
                    return (await deletedOne(id)) ? err({ type: 'KnowledgeItemGone', itemId: id }) : err({ type: 'KnowledgeItemNotFound', itemId: id });
                if (other === id) return ok([item]);
                const at = now();
                const sides = [item, await liveOne(other)].filter((i): i is Knowledge.LiveKnowledgeItem => i !== undefined);
                const unlinked = sides.map((side) => {
                    const r = knowledgeItemCommands.unlinkConflict(side, { other: side.id === id ? other : id, by, at });
                    if (!r.ok) throw new Error('unlinkConflict refused two distinct items');
                    return r.value.Live;
                });
                await writeItems(
                    unlinked.map((u) => u.aggregate),
                    dir,
                );
                await appendAudit(unlinked.map((u) => auditOf(u.events.KnowledgeConflictUnlinked)));
                return ok(unlinked.map((u) => u.aggregate));
            });
        },

        async delete(project, id, by) {
            checkProject(project);
            return exclusive(async (): Promise<Result<Deletion, Knowledge.KnowledgeItemNotFound>> => {
                const item = await liveOne(id);
                if (item === undefined) return err({ type: 'KnowledgeItemNotFound', itemId: id });
                return ok(await deleteNow(item, by));
            });
        },

        async deleteSession(project, session, by) {
            checkProject(project);
            return exclusive(async (): Promise<Deletion> => {
                const items: Knowledge.KnowledgeItemId[] = [];
                const messages: Knowledge.MessageKey[] = [];
                for (const item of (await liveItems()).filter((i) => i.createdIn === session).sort(newestFirst)) {
                    const d = await deleteNow(item, by);
                    items.push(...d.items);
                    messages.push(...d.messages);
                }
                return { items, messages };
            });
        },

        async restore(project, id, by) {
            checkProject(project);
            return exclusive(async (): Promise<Result<Knowledge.LiveKnowledgeItem, Knowledge.KnowledgeItemNotFound>> => {
                const item = await deletedOne(id);
                if (item === undefined) return err({ type: 'KnowledgeItemNotFound', itemId: id });
                const { aggregate, events } = known(knowledgeItemCommands.restore(item, { by, at: now() })).Live;
                await writeItems([aggregate], dir);
                await rm(path.join(deletedDir, itemFileName(id)), { force: true });
                await appendAudit([auditOf(events.KnowledgeItemRestored)]);
                return ok(aggregate);
            });
        },

        async redactions(project, after): Promise<readonly RedactionEntry[]> {
            checkProject(project);
            const all = lines(await readText(path.join(dir, REDACTIONS_FILE)));
            let start = 0;
            if (after !== undefined) {
                const m = /^(\d+):([0-9a-f]+)$/.exec(after);
                if (!m) throw new Error(`Not a cursor of the redaction log: ${after}`);
                const n = Number(m[1]);
                // the lines read are still the first ones: read on; otherwise (a merge put lines among them) from the start
                if (n <= all.length && digest(all.slice(0, n)) === m[2]) start = n;
            }
            const entries: RedactionEntry[] = [];
            for (let i = start; i < all.length; i++) {
                const redaction = redactionOfJson(all[i]);
                if (redaction) entries.push({ redaction, cursor: redactionCursor(all, i + 1) });
            }
            return entries;
        },

        async audit(project, query: AuditQuery): Promise<Page<Knowledge.AuditEntry>> {
            checkProject(project);
            const all = lines(await readText(path.join(dir, AUDIT_FILE)));
            // the cursor is the line the next page starts below (newest first: towards the start of the file)
            let below = all.length;
            if (query.cursor !== undefined) {
                if (!/^\d+$/.test(query.cursor)) throw new Error(`Not a cursor of the audit log: ${query.cursor}`);
                below = Math.min(Number(query.cursor), all.length);
            }
            const limit = limitOf(query.limit);
            const items: Knowledge.AuditEntry[] = [];
            let i = below - 1;
            for (; i >= 0 && items.length < limit; i--) {
                const entry = auditOfJson(all[i]);
                if (entry && (query.item === undefined || entry.item === query.item)) items.push(entry);
            }
            const more = all.slice(0, i + 1).some((l) => {
                const entry = auditOfJson(l);
                return entry !== undefined && (query.item === undefined || entry.item === query.item);
            });
            return more ? { items, next: String(i + 1) } : { items };
        },

        async putImage(project, image: KnowledgeImage): Promise<Knowledge.ImageId> {
            checkProject(project);
            const ext = MEDIA_TYPES[image.mediaType];
            if (ext === undefined) throw new Error(`The knowledge store keeps images of ${Object.keys(MEDIA_TYPES).join(', ')}: not ${image.mediaType}.`);
            const made = Knowledge.makeImageId(randomId('img_'));
            if (!made.ok) throw new Error('An image ID was made wrong.');
            await mkdir(imagesDir, { recursive: true });
            await writeAll([{ file: path.join(imagesDir, `${made.value}.${ext}`), data: image.bytes }]);
            return made.value;
        },

        async getImage(project, id): Promise<KnowledgeImage | undefined> {
            checkProject(project);
            for (const [mediaType, ext] of Object.entries(MEDIA_TYPES)) {
                const bytes = await readFile(path.join(imagesDir, `${id}.${ext}`)).catch((e: unknown) => {
                    if (isMissing(e)) return undefined;
                    throw e;
                });
                if (bytes) return { mediaType, bytes: new Uint8Array(bytes) };
            }
            return undefined;
        },
    };
}

/** Why an operation cannot be applied over files that do not read: none when it touches none. */
function blockedBy(operation: Knowledge.Operation, unreadable: ReadonlySet<string>): DropReason | undefined {
    const fresh = operation.kind === 'Add' || operation.kind === 'Conflict' ? operation.id : undefined;
    const existing = operation.kind === 'Add' ? undefined : operation.item;
    if (fresh !== undefined && unreadable.has(fresh)) return { type: 'KnowledgeItemExists', itemId: fresh };
    if (existing !== undefined && unreadable.has(existing)) return { type: 'KnowledgeItemNotFound', itemId: existing };
    return undefined;
}
