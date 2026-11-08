// The `files` store on a temporary directory: what each call leaves on disk and reads back.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Knowledge } from '../generated/index.js';
import { createFilesKnowledgeStore, readKnowledgeFiles, type FilesKnowledgeStore } from './files.js';
import { content, extraction, itemId, reason, sessionRef, source, stickyRef, userName, version } from '../test-helpers.js';

const project = 'shop' as Knowledge.ProjectName;
const alice = userName('alice@example.com');

let root: string;
let dir: string;
let stateDir: string;
let clock: Date;
let store: FilesKnowledgeStore;

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'domaintrail-knowledge-'));
    dir = path.join(root, 'knowledge');
    stateDir = path.join(root, 'state');
    clock = new Date('2026-11-05T09:00:00Z');
    store = createFilesKnowledgeStore({ dir, project, stateDir, undoWindowMs: 60_000, now: () => clock });
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const tick = (ms: number): void => {
    clock = new Date(clock.getTime() + ms);
};

const add = (
    id: string,
    over: { text?: string; about?: string[]; origin?: Knowledge.Origin; session?: string; message?: string } = {},
): Extract<Knowledge.Operation, { kind: 'Add' }> => ({
    kind: 'Add',
    id: itemId(id),
    content: content(over.text ?? `the finding of ${id}`, over.origin, over.about),
    sources: [source(over.session ?? 's1', over.message ?? `m-${id}`)],
    reason: reason(`heard ${id}`),
});

async function apply(
    session: string,
    number: number,
    ...operations: Knowledge.Operation[]
): Promise<Awaited<ReturnType<FilesKnowledgeStore['applyExtraction']>>> {
    return store.applyExtraction(project, { by: extraction(session, number), operations });
}

const ids = (items: readonly { id: Knowledge.KnowledgeItemId }[]): string[] => items.map((i) => i.id);

describe('the files store', () => {
    test('add writes one Markdown file per item; get and about read it back', async () => {
        const r = await apply('s1', 1, add('kn_00000001'), add('kn_00000002', { about: ['Ordering.Placed'] }));
        expect(r.replayed).toBe(false);
        expect(ids(r.items)).toEqual(['kn_00000001', 'kn_00000002']);
        expect((await readdir(dir)).sort()).toEqual(['.gitattributes', 'audit.jsonl', 'kn_00000001.md', 'kn_00000002.md']);
        const text = await readFile(path.join(dir, 'kn_00000001.md'), 'utf8');
        expect(text).toContain('createdIn: s1\n');
        expect(text).toEndWith('---\n\nthe finding of kn_00000001\n');
        expect((await store.get(project, itemId('kn_00000001')))?.item).toEqual(r.items[0]);
        expect(await store.get(project, itemId('kn_00000001'), { history: true })).toEqual({ item: r.items[0], history: [] });
        expect(ids(await store.about(project, ['Ordering.Placed' as Knowledge.StickyRef]))).toEqual(['kn_00000002']);
        expect(await store.get(project, itemId('kn_00000009'))).toBeUndefined();
    });

    test('addSource adds a source and raises said to agreed', async () => {
        await apply('s1', 1, add('kn_00000001'));
        const r = await apply('s1', 2, { kind: 'AddSource', item: itemId('kn_00000001'), base: version(1), source: source('s1', 'm-2'), agreed: true });
        expect(r.items[0].sources.map((s) => s.message)).toEqual(['m-kn_00000001', 'm-2'] as Knowledge.MessageRef[]);
        expect(r.items[0].content.labels.origin).toBe('agreed');
        expect((await store.get(project, itemId('kn_00000001')))?.item.sources).toHaveLength(2);
    });

    test('update: a rewording in place in the session that made it; one with a new source, or from a later session, a new version', async () => {
        await apply('s1', 1, add('kn_00000001'));
        const revised = content('more precisely');
        const own = [source('s1', 'm-kn_00000001')] as const;
        const inPlace = await apply('s1', 2, { kind: 'Update', item: itemId('kn_00000001'), base: version(1), revised, sources: own });
        expect(inPlace.items[0].version).toBe(version(1));
        expect(inPlace.items[0].content.text).toBe(revised.text);
        // the correction's message joins the sources, a new version
        const corrected = await apply('s1', 3, {
            kind: 'Update',
            item: itemId('kn_00000001'),
            base: version(1),
            revised: content('30 days'),
            sources: [source('s1', 'm-correction')],
        });
        expect(corrected.items[0].version).toBe(version(2));
        expect(corrected.items[0].sources.map((s) => s.message)).toEqual(['m-kn_00000001', 'm-correction'] as Knowledge.MessageRef[]);
        const later = await apply('s2', 1, { kind: 'Update', item: itemId('kn_00000001'), base: version(2), revised: content('later still'), sources: own });
        expect(later.items[0].version).toBe(version(3));
        // a stale base is dropped, the item stands
        const stale = await apply('s2', 2, { kind: 'Update', item: itemId('kn_00000001'), base: version(1), revised: content('stale'), sources: own });
        expect(stale.items).toEqual([]);
        expect(stale.dropped.map((d) => d.reason.type)).toEqual(['StaleOperation']);
        expect((await store.get(project, itemId('kn_00000001')))?.item.content.text).toBe(content('later still').text);
    });

    test('a conflict adds the new item and links both; counts show the mark while both are live', async () => {
        await apply('s0', 1, add('kn_00000001', { session: 's0', about: ['Ordering.Placed'] }));
        const r = await apply('s1', 1, {
            kind: 'Conflict',
            id: itemId('kn_00000002'),
            content: content('the other way round', 'said', ['Ordering.Placed', 'Ordering.Paid']),
            sources: [source('s1', 'm-9')],
            item: itemId('kn_00000001'),
            base: version(1),
        });
        expect(r.items.map((i) => [i.id, i.conflictsWith])).toEqual([
            ['kn_00000002', ['kn_00000001']],
            ['kn_00000001', ['kn_00000002']],
        ] as unknown as [Knowledge.KnowledgeItemId, Knowledge.KnowledgeItemId[]][]);
        expect(await store.counts(project, 'Ordering')).toEqual([
            { sticky: 'Ordering.Paid' as Knowledge.StickyRef, hasItems: true, hasConflict: true },
            { sticky: 'Ordering.Placed' as Knowledge.StickyRef, hasItems: true, hasConflict: true },
        ]);
        expect(await store.counts(project, 'Billing')).toEqual([]);
        await store.delete(project, itemId('kn_00000001'), alice);
        expect(await store.counts(project, 'Ordering')).toEqual([
            { sticky: 'Ordering.Paid' as Knowledge.StickyRef, hasItems: true, hasConflict: false },
            { sticky: 'Ordering.Placed' as Knowledge.StickyRef, hasItems: true, hasConflict: false },
        ]);
        // the remaining side is read without the conflict, in every read; restoring the other side brings it back
        const other = itemId('kn_00000002');
        expect((await store.get(project, other))?.item.conflictsWith).toEqual([]);
        expect((await store.about(project, ['Ordering.Paid' as Knowledge.StickyRef])).map((i) => i.conflictsWith)).toEqual([[]]);
        expect((await store.search(project, {})).items.map((i) => i.conflictsWith)).toEqual([[]]);
        await store.restore(project, itemId('kn_00000001'), alice);
        expect((await store.get(project, other))?.item.conflictsWith).toEqual([itemId('kn_00000001')]);
    });

    test('unlinkConflict unlinks both sides, keeps their versions and audits it; counts lose the mark', async () => {
        await apply('s0', 1, add('kn_00000001', { session: 's0', about: ['Ordering.Placed'] }));
        await apply('s1', 1, {
            kind: 'Conflict',
            id: itemId('kn_00000002'),
            content: content('the other way round', 'said', ['Ordering.Placed']),
            sources: [source('s1', 'm-9')],
            item: itemId('kn_00000001'),
            base: version(1),
        });
        const r = await store.unlinkConflict(project, itemId('kn_00000002'), itemId('kn_00000001'), alice);
        expect(r.ok && r.value.map((i) => [i.id, i.conflictsWith, i.version])).toEqual([
            ['kn_00000002', [], 1],
            ['kn_00000001', [], 1],
        ] as unknown as [Knowledge.KnowledgeItemId, Knowledge.KnowledgeItemId[], Knowledge.ItemVersion][]);
        expect((await store.get(project, itemId('kn_00000001')))?.item.conflictsWith).toEqual([]);
        expect(await store.counts(project, 'Ordering')).toEqual([{ sticky: 'Ordering.Placed' as Knowledge.StickyRef, hasItems: true, hasConflict: false }]);
        const audit = await store.audit(project, {});
        expect(audit.items.slice(0, 2).map((e) => [e.item, e.operation])).toEqual([
            ['kn_00000001', 'unlinkConflict'],
            ['kn_00000002', 'unlinkConflict'],
        ] as unknown as [Knowledge.KnowledgeItemId, Knowledge.AuditOperation][]);
        expect(await store.unlinkConflict(project, itemId('kn_00000009'), itemId('kn_00000001'), alice)).toEqual({
            ok: false,
            error: { type: 'KnowledgeItemNotFound', itemId: itemId('kn_00000009') },
        });
    });

    test('handOverToHotspot puts the hotspot in both items’ about and unlinks them, keeping their versions; the hotspot is the audit’s reason', async () => {
        await apply('s0', 1, add('kn_00000001', { session: 's0', about: ['Ordering.Placed'] }));
        await apply('s1', 1, {
            kind: 'Conflict',
            id: itemId('kn_00000002'),
            content: content('the other way round', 'said', ['Ordering.Placed']),
            sources: [source('s1', 'm-9')],
            item: itemId('kn_00000001'),
            base: version(1),
        });
        const hotspot = stickyRef('Ordering.CutOffUnclear');
        const r = await store.handOverToHotspot(project, itemId('kn_00000002'), itemId('kn_00000001'), hotspot, alice);
        expect(r.ok && r.value.map((i) => [i.id, i.content.about, i.conflictsWith, i.version])).toEqual([
            ['kn_00000002', ['Ordering.Placed', 'Ordering.CutOffUnclear'], [], 1],
            ['kn_00000001', ['Ordering.Placed', 'Ordering.CutOffUnclear'], [], 1],
        ] as unknown as [Knowledge.KnowledgeItemId, Knowledge.StickyRef[], Knowledge.KnowledgeItemId[], Knowledge.ItemVersion][]);
        expect((await store.get(project, itemId('kn_00000001')))?.item.content.about).toEqual([
            'Ordering.Placed',
            'Ordering.CutOffUnclear',
        ] as unknown as Knowledge.StickyRef[]);
        expect(await store.counts(project, 'Ordering')).toEqual([
            { sticky: 'Ordering.CutOffUnclear' as Knowledge.StickyRef, hasItems: true, hasConflict: false },
            { sticky: 'Ordering.Placed' as Knowledge.StickyRef, hasItems: true, hasConflict: false },
        ]);
        const audit = await store.audit(project, {});
        expect(audit.items.slice(0, 2).map((e) => [e.item, e.operation, e.actor, e.reason])).toEqual([
            ['kn_00000001', 'handOverToHotspot', { kind: 'Person', user: alice }, 'hotspot Ordering.CutOffUnclear'],
            ['kn_00000002', 'handOverToHotspot', { kind: 'Person', user: alice }, 'hotspot Ordering.CutOffUnclear'],
        ] as unknown as [Knowledge.KnowledgeItemId, Knowledge.AuditOperation, Knowledge.Actor, Knowledge.Reason][]);
        expect(await store.handOverToHotspot(project, itemId('kn_00000009'), itemId('kn_00000001'), hotspot, alice)).toEqual({
            ok: false,
            error: { type: 'KnowledgeItemNotFound', itemId: itemId('kn_00000009') },
        });
    });

    test('correct makes a new version; correcting a deleted item says it is gone', async () => {
        await apply('s1', 1, add('kn_00000001'));
        const r = await store.correct(project, itemId('kn_00000001'), content('corrected'), alice);
        expect(r.ok && [r.value.version, r.value.content.text]).toEqual([version(2), content('corrected').text]);
        expect(await store.correct(project, itemId('kn_00000009'), content('x'), alice)).toEqual({
            ok: false,
            error: { type: 'KnowledgeItemNotFound', itemId: itemId('kn_00000009') },
        });
        await store.delete(project, itemId('kn_00000001'), alice);
        expect(await store.correct(project, itemId('kn_00000001'), content('x'), alice)).toEqual({
            ok: false,
            error: { type: 'KnowledgeItemGone', itemId: itemId('kn_00000001') },
        });
    });

    test('delete removes the file at once and returns the messages; restore within the window brings it back', async () => {
        await apply('s1', 1, add('kn_00000001'));
        const d = await store.delete(project, itemId('kn_00000001'), alice);
        expect(d).toEqual({
            ok: true,
            value: { items: [itemId('kn_00000001')], messages: [{ session: sessionRef('s1'), message: 'm-kn_00000001' as Knowledge.MessageRef }] },
        });
        expect(await readdir(dir)).not.toContain('kn_00000001.md');
        expect(await store.get(project, itemId('kn_00000001'))).toBeUndefined();
        expect((await store.search(project, {})).items).toEqual([]);
        // an extraction meanwhile cannot bring it back
        const meanwhile = await apply('s1', 2, {
            kind: 'AddSource',
            item: itemId('kn_00000001'),
            base: version(1),
            source: source('s1', 'm-3'),
            agreed: false,
        });
        expect(meanwhile.dropped.map((x) => x.reason.type)).toEqual(['KnowledgeItemGone']);
        expect(await store.delete(project, itemId('kn_00000001'), alice)).toEqual({
            ok: false,
            error: { type: 'KnowledgeItemNotFound', itemId: itemId('kn_00000001') },
        });
        tick(10_000);
        const restored = await store.restore(project, itemId('kn_00000001'), alice);
        expect(restored.ok && restored.value.state).toBe('Live');
        expect(await readdir(dir)).toContain('kn_00000001.md');
        expect(await store.redactions(project)).toEqual([]);
    });

    test('after the window the sweep removes it for good: no restore, its images and reasons gone, its redaction logged', async () => {
        const kept = await store.putImage(project, { mediaType: 'image/png', bytes: new Uint8Array([1, 2]) });
        const only = await store.putImage(project, { mediaType: 'image/png', bytes: new Uint8Array([3]) });
        await apply(
            's1',
            1,
            add('kn_00000001', { text: `see ![a](image:${kept}) and ![b](image:${only})` }),
            add('kn_00000002', { text: `also ![a](image:${kept})` }),
        );
        await store.delete(project, itemId('kn_00000001'), alice);
        tick(60_000);
        await store.sweep();
        expect(await store.restore(project, itemId('kn_00000001'), alice)).toEqual({
            ok: false,
            error: { type: 'KnowledgeItemNotFound', itemId: itemId('kn_00000001') },
        });
        expect(await store.getImage(project, only)).toBeUndefined();
        expect(await store.getImage(project, kept)).toEqual({ mediaType: 'image/png', bytes: new Uint8Array([1, 2]) });
        const log = await store.audit(project, { item: itemId('kn_00000001') });
        expect(log.items.map((e) => [e.operation, e.reason])).toEqual([
            ['delete', undefined],
            ['add', undefined],
        ]);
        expect((await store.audit(project, { item: itemId('kn_00000002') })).items[0].reason).toBe(reason('heard kn_00000002'));
        const redactions = await store.redactions(project);
        expect(redactions.map((r) => r.redaction)).toEqual([
            { item: itemId('kn_00000001'), messages: [{ session: sessionRef('s1'), message: 'm-kn_00000001' as Knowledge.MessageRef }] },
        ]);
    });

    test('deleteSession deletes the items made in a session', async () => {
        await apply('s1', 1, add('kn_00000001'), add('kn_00000002'));
        await apply('s2', 1, add('kn_00000003', { session: 's2' }));
        const d = await store.deleteSession(project, sessionRef('s1'), alice);
        expect([...d.items].sort()).toEqual([itemId('kn_00000001'), itemId('kn_00000002')]);
        expect(d.messages).toHaveLength(2);
        expect(ids((await store.search(project, {})).items)).toEqual(['kn_00000003']);
    });

    test('the redaction log reads on from a cursor, and from the start when the lines read changed', async () => {
        await apply('s1', 1, add('kn_00000001'), add('kn_00000002'));
        await store.delete(project, itemId('kn_00000001'), alice);
        tick(60_000);
        await store.sweep();
        const first = await store.redactions(project);
        expect(first).toHaveLength(1);
        expect(await store.redactions(project, first[0].cursor)).toEqual([]);
        await store.delete(project, itemId('kn_00000002'), alice);
        tick(60_000);
        await store.sweep();
        const next = await store.redactions(project, first[0].cursor);
        expect(next.map((r) => r.redaction.item)).toEqual([itemId('kn_00000002')]);
        // a merge put a line before the cursor: everything again (redacting twice is harmless)
        const file = path.join(dir, 'redactions.jsonl');
        await writeFile(file, `{"item":"kn_00000099","messages":[]}\n${await readFile(file, 'utf8')}`);
        expect(await store.redactions(project, next[0].cursor)).toHaveLength(3);
    });

    test('an extraction sent again applies nothing and returns the first result', async () => {
        const operations = [
            add('kn_00000001'),
            {
                kind: 'Update',
                item: itemId('kn_00000009'),
                base: version(1),
                revised: content('x'),
                sources: [source('s1', 'm-x')],
            } satisfies Knowledge.Operation,
        ];
        const first = await apply('s1', 1, ...operations);
        await store.correct(project, itemId('kn_00000001'), content('corrected meanwhile'), alice);
        const again = await apply('s1', 1, ...operations);
        expect(again.replayed).toBe(true);
        expect(again.dropped).toEqual(first.dropped);
        expect(again.items[0].content.text).toBe(content('corrected meanwhile').text);
        expect((await store.audit(project, {})).items.filter((e) => e.operation === 'add')).toHaveLength(1);
    });

    test('search: filters, full text over the text and the quotes, newest first, a page at a time', async () => {
        await apply('s1', 1, add('kn_00000001', { text: 'Invoices close at month end', about: ['Ordering.Placed'] }));
        tick(1000);
        await apply('s1', 2, { ...add('kn_00000002', { text: 'Second', origin: 'agreed' }), sources: [source('s1', 'm-x', 'we close at MONTH end')] });
        tick(1000);
        await apply('s2', 1, add('kn_00000003', { session: 's2', text: 'Third' }));
        expect(ids((await store.search(project, {})).items)).toEqual(['kn_00000003', 'kn_00000002', 'kn_00000001']);
        expect(ids((await store.search(project, { q: 'month END' })).items)).toEqual(['kn_00000002', 'kn_00000001']);
        expect(ids((await store.search(project, { origin: ['agreed'] })).items)).toEqual(['kn_00000002']);
        expect(ids((await store.search(project, { about: ['Ordering.Placed' as Knowledge.StickyRef] })).items)).toEqual(['kn_00000001']);
        expect(ids((await store.search(project, { session: sessionRef('s2') })).items)).toEqual(['kn_00000003']);
        expect(ids((await store.search(project, { kind: ['pain'] })).items)).toEqual([]);
        const page1 = await store.search(project, { limit: 2 });
        expect(ids(page1.items)).toEqual(['kn_00000003', 'kn_00000002']);
        const page2 = await store.search(project, { limit: 2, cursor: page1.next });
        expect(ids(page2.items)).toEqual(['kn_00000001']);
        expect(page2.next).toBeUndefined();
    });

    test('the audit log, newest first, a page at a time', async () => {
        await apply('s1', 1, add('kn_00000001'), add('kn_00000002'));
        await store.correct(project, itemId('kn_00000001'), content('c'), alice);
        const page1 = await store.audit(project, { limit: 2 });
        expect(page1.items.map((e) => [e.item, e.operation])).toEqual([
            ['kn_00000001', 'correct'],
            ['kn_00000002', 'add'],
        ] as unknown as [Knowledge.KnowledgeItemId, Knowledge.AuditOperation][]);
        expect(page1.items[0].actor).toEqual({ kind: 'Person', user: alice });
        const page2 = await store.audit(project, { limit: 2, cursor: page1.next });
        expect(page2.items.map((e) => e.operation)).toEqual(['add']);
        expect(page2.items[0].actor).toEqual({ kind: 'Extractor', extraction: extraction('s1', 1) });
        expect(page2.next).toBeUndefined();
    });

    test('a file a person broke is skipped by reads, reported to dt check and never written over', async () => {
        await apply('s1', 1, add('kn_00000001'));
        await writeFile(path.join(dir, 'kn_00000002.md'), '---\nid: kn_00000002\n---\n');
        expect(ids((await store.search(project, {})).items)).toEqual(['kn_00000001']);
        const r = await apply('s1', 2, add('kn_00000002'), {
            kind: 'AddSource',
            item: itemId('kn_00000002'),
            base: version(1),
            source: source('s1', 'm-5'),
            agreed: false,
        });
        expect(r.dropped.map((d) => d.reason.type)).toEqual(['KnowledgeItemExists', 'KnowledgeItemNotFound']);
        expect(await readFile(path.join(dir, 'kn_00000002.md'), 'utf8')).toBe('---\nid: kn_00000002\n---\n');
        expect((await readKnowledgeFiles(dir, root)).map((f) => f.path)).toEqual(['knowledge/kn_00000001.md', 'knowledge/kn_00000002.md']);
    });

    test('images by media type; another project is refused', async () => {
        const id = await store.putImage(project, { mediaType: 'image/jpeg', bytes: new Uint8Array([9]) });
        expect(id).toMatch(/^img_[0-9a-z]{16}$/);
        expect(await readdir(path.join(dir, 'images'))).toEqual([`${id}.jpg`]);
        expect(await store.getImage(project, id)).toEqual({ mediaType: 'image/jpeg', bytes: new Uint8Array([9]) });
        const failure = (p: Promise<unknown>): Promise<string> =>
            p.then(
                () => 'resolved',
                (e: unknown) => String(e),
            );
        expect(await failure(store.putImage(project, { mediaType: 'text/html', bytes: new Uint8Array() }))).toContain('not text/html');
        expect(await failure(store.search('other' as Knowledge.ProjectName, {}))).toContain("not 'other'");
        expect(await failure(store.delete('other' as Knowledge.ProjectName, itemId('kn_00000001'), alice))).toContain("not 'other'");
        expect(await readKnowledgeFiles(path.join(root, 'none'), root)).toEqual([]);
    });
});

describe('retiring in the files store (廃止)', () => {
    const said = (message: string): Extract<Knowledge.Evidence, { readonly kind: 'Said' }> => ({
        kind: 'Said',
        session: sessionRef('s2'),
        message: message as Knowledge.MessageRef,
        quote: 'もうやっていない' as Knowledge.Quote,
    });
    const candidate = (item: string, over: Partial<Parameters<FilesKnowledgeStore['propose']>[1]> = {}): Parameters<FilesKnowledgeStore['propose']>[1] => ({
        item: itemId(item),
        action: 'retire',
        reason: 'obsolete',
        explanation: reason('the talk says it is no longer done'),
        evidence: [said('m9')],
        proposedBy: { kind: 'Review', review: 'review-1' as Knowledge.ReviewRef },
        ...over,
    });

    test('a retired item keeps its file, with its retirement; the lists and the counts leave it out unless asked', async () => {
        await apply('s1', 1, add('kn_00000001', { about: ['Ordering.Placed'] }), add('kn_00000002', { about: ['Ordering.Placed'] }));
        tick(1000);
        const r = await store.retire(project, itemId('kn_00000001'), { reason: 'replaced', replacedBy: itemId('kn_00000002') }, alice);
        expect(r.ok && r.value.retirement).toEqual({ reason: 'replaced', replacedBy: itemId('kn_00000002'), by: alice, at: clock });
        const text = await readFile(path.join(dir, 'kn_00000001.md'), 'utf8');
        expect(text).toContain('retired:\n  reason: replaced\n  replacedBy: kn_00000002\n  by: alice@example.com\n');
        expect(text).toContain('the finding of kn_00000001');
        expect(ids((await store.search(project, {})).items)).toEqual(['kn_00000002']);
        expect(ids((await store.search(project, { retired: 'include' })).items).sort()).toEqual(['kn_00000001', 'kn_00000002']);
        expect(ids((await store.search(project, { retired: 'only' })).items)).toEqual(['kn_00000001']);
        expect(ids(await store.about(project, ['Ordering.Placed' as Knowledge.StickyRef]))).toEqual(['kn_00000002']);
        expect((await store.get(project, itemId('kn_00000001')))?.item.retirement?.reason).toBe('replaced');
        // the dot counts the other item only; retired alone, no dot
        expect(await store.counts(project, 'Ordering')).toEqual([{ sticky: 'Ordering.Placed' as Knowledge.StickyRef, hasItems: true, hasConflict: false }]);
        await store.retire(project, itemId('kn_00000002'), {}, alice);
        expect(await store.counts(project, 'Ordering')).toEqual([]);
        // undone
        const back = await store.unretire(project, itemId('kn_00000001'), alice);
        expect(back.ok && back.value.retirement).toBeUndefined();
        expect(await readFile(path.join(dir, 'kn_00000001.md'), 'utf8')).not.toContain('retired:');
        const audit = (await store.audit(project, {})).items.map((e) => [e.item, e.operation]);
        expect<unknown>(audit.slice(0, 3)).toEqual([
            ['kn_00000001', 'unretire'],
            ['kn_00000002', 'retire'],
            ['kn_00000001', 'retire'],
        ]);
    });

    test('a replacement that is not a usable item is refused; retiring twice and unretiring an item not retired too', async () => {
        await apply('s1', 1, add('kn_00000001'), add('kn_00000002'));
        expect(await store.retire(project, itemId('kn_00000001'), { reason: 'replaced', replacedBy: itemId('kn_00000009') }, alice)).toEqual({
            ok: false,
            error: { type: 'ProposalRefused', reason: 'replacementUnavailable' },
        });
        await store.retire(project, itemId('kn_00000001'), {}, alice);
        expect(await store.retire(project, itemId('kn_00000001'), {}, alice)).toEqual({ ok: false, error: { type: 'AlreadyRetired' } });
        expect(await store.unretire(project, itemId('kn_00000002'), alice)).toEqual({ ok: false, error: { type: 'NotRetired' } });
        expect(await store.retire(project, itemId('kn_00000009'), {}, alice)).toEqual({
            ok: false,
            error: { type: 'KnowledgeItemNotFound', itemId: itemId('kn_00000009') },
        });
    });

    test('proposals: kept as files, listed while open, approved or dismissed by anyone, a dismissal remembered', async () => {
        await apply('s1', 1, add('kn_00000001'), add('kn_00000002'));
        const proposed = await store.propose(project, candidate('kn_00000001'));
        if (!proposed.ok) throw new Error('not proposed');
        expect(await readdir(path.join(dir, 'proposals'))).toEqual([`${proposed.value.id}.json`]);
        expect((await store.proposals(project)).map((p) => p.id)).toEqual([proposed.value.id]);
        // the same again answers it; another while it waits is refused
        expect(await store.propose(project, candidate('kn_00000001'))).toEqual(proposed);
        expect(await store.propose(project, candidate('kn_00000001', { evidence: [said('m10')] }))).toEqual({
            ok: false,
            error: { type: 'ProposalRefused', reason: 'pending' },
        });

        const approved = await store.approveProposal(project, proposed.value.id, alice);
        expect(approved.ok && approved.value.item.retirement).toEqual({ reason: 'obsolete', by: alice, at: clock, proposal: proposed.value.id });
        expect(await store.proposals(project)).toEqual([]);
        expect(ids((await store.search(project, {})).items)).toEqual(['kn_00000002']);

        const second = await store.propose(project, candidate('kn_00000002'));
        if (!second.ok) throw new Error('not proposed');
        const dismissed = await store.dismissProposal(project, second.value.id, userName('guest:bob'));
        expect(dismissed.ok && dismissed.value.state).toBe('Dismissed');
        expect(await store.dismissProposal(project, second.value.id, alice)).toEqual({
            ok: false,
            error: { type: 'ProposalDecided', proposalId: second.value.id },
        });
        // the same reason on the same evidence, by the extractor this time: not again; with a new message: again
        expect(await store.propose(project, candidate('kn_00000002', { proposedBy: { kind: 'Extraction', extraction: extraction('s3', 1) } }))).toEqual({
            ok: false,
            error: { type: 'ProposalRefused', reason: 'dismissedBefore' },
        });
        expect((await store.propose(project, candidate('kn_00000002', { evidence: [said('m9'), said('m11')] }))).ok).toBe(true);

        const audit = (await store.audit(project, {})).items.map((e) => [e.operation, e.actor.kind]);
        expect(audit).toContainEqual(['propose', 'Review']);
        expect(audit).toContainEqual(['dismiss', 'Person']);
        expect(audit).toContainEqual(['retire', 'Person']);
    });

    test("an extraction's proposals are written with its items; an operation on a retired item is dropped", async () => {
        await apply('s1', 1, add('kn_00000001'));
        const r = await apply('s2', 1, {
            kind: 'ProposeRetire',
            item: itemId('kn_00000001'),
            retirementReason: 'wrong',
            evidence: [said('m1')],
            reason: reason('it never was so'),
        });
        expect<unknown>(r.proposals?.map((p) => [p.item, p.action, p.proposedBy.kind])).toEqual([['kn_00000001', 'retire', 'Extraction']]);
        expect((await store.proposals(project)).map((p) => p.item)).toEqual(['kn_00000001'] as Knowledge.KnowledgeItemId[]);
        await store.retire(project, itemId('kn_00000001'), {}, alice);
        const dropped = await apply('s2', 2, { kind: 'AddSource', item: itemId('kn_00000001'), base: version(1), source: source('s2', 'm2'), agreed: false });
        expect(dropped.dropped.map((d) => d.reason)).toEqual([{ type: 'RetiredItem', itemId: itemId('kn_00000001') }]);
        // moot now: no longer listed
        expect(await store.proposals(project)).toEqual([]);
    });

    test('the sweep forgets the proposals about a deleted item; nothing of their explanation or quotes is left in the audit log', async () => {
        await apply('s1', 1, add('kn_00000001'));
        const p = await store.propose(
            project,
            candidate('kn_00000001', {
                explanation: reason('山田さんが言うにはもうやらない'),
                evidence: [{ ...said('m9'), quote: '山田の引用' as Knowledge.Quote }],
            }),
        );
        expect(p.ok).toBe(true);
        const audit = await readFile(path.join(dir, 'audit.jsonl'), 'utf8');
        expect(audit).toContain('"operation":"propose"');
        expect(audit).not.toContain('山田');
        await store.delete(project, itemId('kn_00000001'), alice);
        tick(61_000);
        await store.sweep();
        expect(await readdir(path.join(dir, 'proposals'))).toEqual([]);
        expect(await readFile(path.join(dir, 'audit.jsonl'), 'utf8')).not.toContain('山田');
    });

    test("a proposal file of the candidate's ID that proposes something else is a collision: refused, never overwritten", async () => {
        await apply('s1', 1, add('kn_00000001'), add('kn_00000002'));
        const p = await store.propose(project, candidate('kn_00000001'));
        if (!p.ok) throw new Error('not proposed');
        const file = path.join(dir, 'proposals', `${p.value.id}.json`);
        const forged = (await readFile(file, 'utf8')).replace('kn_00000001', 'kn_00000002');
        await writeFile(file, forged);
        expect(await store.propose(project, candidate('kn_00000001')).catch((e: unknown) => (e instanceof Error ? e.name : e))).toBe('ProposalIdCollision');
        expect(await readFile(file, 'utf8')).toBe(forged);
    });
});
