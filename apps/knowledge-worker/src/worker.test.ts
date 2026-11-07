// The Worker in workerd (Miniflare, a local D1 and R2), driven through the `cloudflare` adapter of the knowledge store
// as dt drives it: the HTTP API of ADR 0031 section 8, the extraction applied once by its idempotency key, the guard
// against changes made meanwhile, deletion with restore, the sweep with the redaction log, and who may call.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloudflareKnowledgeStore, KnowledgeStoreError, type Knowledge, type KnowledgeStore } from '@domaintrail/knowledge';
import * as wire from '@domaintrail/knowledge/protocol';
import { guard } from './store.js';
import { statementsOf, startWorker, type RunningWorker } from './test-helpers.js';

/** The error a promise rejects with (fails when it resolves). */
async function thrown(p: Promise<unknown>): Promise<Error> {
    const e = await p.then(
        () => undefined,
        (x: unknown) => x,
    );
    if (!(e instanceof Error)) throw new Error('expected a rejection with an Error');
    return e;
}

const WRITER = 'writer.access';
const READER = 'reader.access';

let worker: RunningWorker;
let store: KnowledgeStore;
let reader: KnowledgeStore;

beforeAll(async () => {
    worker = await startWorker({ INSECURE_SKIP_ACCESS_CHECK: 'true', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', WRITER_TOKENS: `${WRITER}, other.access` });
    store = cloudflareKnowledgeStore({ url: worker.url, serviceToken: { clientId: WRITER, clientSecret: 'secret' } });
    reader = cloudflareKnowledgeStore({ url: worker.url, serviceToken: { clientId: READER, clientSecret: 'secret' } });
});
afterAll(() => worker?.dispose());

// ---- values ------------------------------------------------------------------------------------------------------

let projects = 0;
/** A project of its own per test. */
const newProject = (): Knowledge.ProjectName => wire.projectName(`p${++projects}`, 'test');
const user = wire.userName('facilitator@example.com', 'test');
const id = (n: number): Knowledge.KnowledgeItemId => wire.itemId(`kn_${String(n).padStart(8, '0')}`, 'test');

const content = (text: string, over: { about?: string[]; kind?: string; origin?: string; title?: string } = {}): unknown => ({
    title: over.title ?? `${text.slice(0, 30).trim()}`,
    text,
    labels: { when: 'as_is', kind: over.kind ?? 'rule', origin: over.origin ?? 'said' },
    about: over.about ?? ['Ordering.CreateSpecification'],
});
const source = (session: string, message: string, quote = 'そういう決まりです'): unknown => ({ session, message, at: '2026-11-05T09:00:00.000Z', quote });
const add = (
    n: number,
    text: string,
    session = 's1',
    over: { about?: string[]; kind?: string; message?: string; quote?: string; title?: string } = {},
): unknown => ({
    kind: 'Add',
    id: id(n),
    content: content(text, over),
    sources: [source(session, over.message ?? `m${n}`, over.quote)],
    reason: `${session} で言われた`,
});
const extraction = (session: string, number: number, operations: unknown[]): Knowledge.Extraction =>
    wire.extraction({ by: { session, number }, operations }, 'test');
/** A value as its JSON: compared with plain values. */
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
const texts = (items: readonly Knowledge.LiveKnowledgeItem[]): string[] => items.map((i) => i.content.text);

// ---- tests -------------------------------------------------------------------------------------------------------

describe('extractions', () => {
    test('applies the operations in one batch, and the same extraction sent again applies nothing', async () => {
        const project = newProject();
        const first = extraction('s1', 1, [add(1, '見積もりは案件担当が作る'), add(2, '受注のあとに作業指示を出す', 's1', { about: ['Ordering.Accept'] })]);
        const applied = await store.applyExtraction(project, first);
        expect(applied.replayed).toBe(false);
        expect(texts(applied.items)).toEqual(['見積もりは案件担当が作る', '受注のあとに作業指示を出す']);
        expect(applied.dropped).toEqual([]);

        const again = await store.applyExtraction(project, first);
        expect(again).toEqual({ ...applied, replayed: true });
        expect((await store.search(project, {})).items).toHaveLength(2);

        // the same key with other operations is a mistake, not a retry
        const other = extraction('s1', 1, [add(3, '別の発見')]);
        const refused = await store.applyExtraction(project, other).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(KnowledgeStoreError);
        expect(refused).toMatchObject({ status: 409, type: 'IdempotencyKeyReused' });
    });

    test('adds a source, rewrites in place within the session, makes a new version for a correction with its message and later, links a conflict', async () => {
        const project = newProject();
        await store.applyExtraction(project, extraction('s1', 1, [add(1, '見積もりは案件担当が作る')]));
        const second = await store.applyExtraction(
            project,
            extraction('s1', 2, [
                { kind: 'AddSource', item: id(1), base: 1, source: source('s1', 'm9'), agreed: true },
                { kind: 'Update', item: id(1), base: 1, revised: content('見積もりは案件担当が作り、営業が確かめる'), sources: [source('s1', 'm9')] },
            ]),
        );
        // one more source, and the content rewritten in place (version 1: the item is this session's, the update adds no source)
        expect(plain(second.items.map((i) => [i.version, i.content.text, i.sources.length]))).toEqual([[1, '見積もりは案件担当が作り、営業が確かめる', 2]]);
        expect((await store.audit(project, { item: id(1) })).items.map((a) => a.operation)).toEqual(['rewrite', 'addSource', 'add']);

        // a correction in the same session: its message joins the sources, and the content before it is kept as version 1
        const corrected = await store.applyExtraction(
            project,
            extraction('s1', 3, [
                { kind: 'Update', item: id(1), base: 1, revised: content('見積もりは営業が確かめる（訂正）'), sources: [source('s1', 'm10')] },
            ]),
        );
        expect(plain(corrected.items.map((i) => [i.version, i.sources.map((x) => x.message)]))).toEqual([[2, ['m1', 'm9', 'm10']]]);

        const later = await store.applyExtraction(
            project,
            extraction('s2', 1, [
                { kind: 'Update', item: id(1), base: 2, revised: content('見積もりは案件担当が作り、営業と所長が確かめる'), sources: [source('s2', 'm2')] },
                { kind: 'Conflict', id: id(2), content: content('見積もりは営業が作る'), sources: [source('s2', 'm1')], item: id(1), base: 3 },
            ]),
        );
        expect(later.dropped).toEqual([]);
        const got = await store.get(project, id(1), { history: true });
        expect(got?.item.version).toBe(wire.itemVersion(3, 'test'));
        expect(got?.item.conflictsWith).toEqual([id(2)]);
        expect(plain(got?.history?.map((h) => [h.version, h.content.text]))).toEqual([
            [2, '見積もりは営業が確かめる（訂正）'],
            [1, '見積もりは案件担当が作り、営業が確かめる'],
        ]);
        expect(await store.counts(project, 'Ordering')).toEqual([
            { sticky: wire.stickyRef('Ordering.CreateSpecification', 'test'), hasItems: true, hasConflict: true },
        ]);
    });

    test('unlinks a conflict on both sides (食い違いではない), keeping the versions, and audits it', async () => {
        const project = newProject();
        await store.applyExtraction(project, extraction('s1', 1, [add(1, '締めは前日17時')]));
        await store.applyExtraction(
            project,
            extraction('s2', 1, [{ kind: 'Conflict', id: id(2), content: content('締めは当日9時'), sources: [source('s2', 'm1')], item: id(1), base: 1 }]),
        );
        const r = await store.unlinkConflict(project, id(2), id(1), user);
        expect(r.ok && plain(r.value.map((i) => [i.id, i.conflictsWith, i.version]))).toEqual([
            [id(2), [], 1],
            [id(1), [], 1],
        ]);
        expect(await store.counts(project, 'Ordering')).toEqual([
            { sticky: wire.stickyRef('Ordering.CreateSpecification', 'test'), hasItems: true, hasConflict: false },
        ]);
        expect((await store.audit(project, { item: id(1) })).items[0]?.operation).toBe('unlinkConflict');
        expect(await store.unlinkConflict(project, id(9), id(1), user)).toEqual({ ok: false, error: { type: 'KnowledgeItemNotFound', itemId: id(9) } });
    });

    test('reads an item without its conflict while the other side is deleted, and with it again once restored', async () => {
        const project = newProject();
        await store.applyExtraction(project, extraction('s1', 1, [add(1, '締めは前日17時')]));
        await store.applyExtraction(
            project,
            extraction('s2', 1, [{ kind: 'Conflict', id: id(2), content: content('締めは当日9時'), sources: [source('s2', 'm1')], item: id(1), base: 1 }]),
        );
        await store.delete(project, id(2), user);
        expect(await store.counts(project, 'Ordering')).toEqual([
            { sticky: wire.stickyRef('Ordering.CreateSpecification', 'test'), hasItems: true, hasConflict: false },
        ]);
        expect(plain((await store.get(project, id(1)))?.item.conflictsWith)).toEqual([]);
        expect(plain((await store.get(project, id(1), { history: true }))?.item.conflictsWith)).toEqual([]);
        expect(plain((await store.search(project, {})).items.map((i) => i.conflictsWith))).toEqual([[]]);
        expect(plain((await store.about(project, [wire.stickyRef('Ordering.CreateSpecification', 'test')])).map((i) => i.conflictsWith))).toEqual([[]]);
        await store.restore(project, id(2), user);
        expect(plain((await store.get(project, id(1)))?.item.conflictsWith)).toEqual([id(2)]);
    });

    test('hands a conflict over to a hotspot (ホットスポットにする): both sides about it, unlinked, versions kept, audited with the hotspot', async () => {
        const project = newProject();
        await store.applyExtraction(project, extraction('s1', 1, [add(1, '締めは前日17時')]));
        await store.applyExtraction(
            project,
            extraction('s2', 1, [{ kind: 'Conflict', id: id(2), content: content('締めは当日9時'), sources: [source('s2', 'm1')], item: id(1), base: 1 }]),
        );
        const hotspot = wire.stickyRef('Ordering.CutOffUnclear', 'test');
        const r = await store.handOverToHotspot(project, id(2), id(1), hotspot, user);
        expect(r.ok && plain(r.value.map((i) => [i.id, i.content.about, i.conflictsWith, i.version]))).toEqual([
            [id(2), ['Ordering.CreateSpecification', 'Ordering.CutOffUnclear'], [], 1],
            [id(1), ['Ordering.CreateSpecification', 'Ordering.CutOffUnclear'], [], 1],
        ]);
        expect(plain(await store.counts(project, 'Ordering'))).toEqual([
            { sticky: 'Ordering.CreateSpecification', hasItems: true, hasConflict: false },
            { sticky: 'Ordering.CutOffUnclear', hasItems: true, hasConflict: false },
        ]);
        expect(texts(await store.about(project, [hotspot]))).toEqual(['締めは当日9時', '締めは前日17時']);
        const audit = (await store.audit(project, { item: id(1) })).items[0];
        expect(plain([audit?.operation, audit?.actor, audit?.reason])).toEqual([
            'handOverToHotspot',
            { kind: 'Person', user },
            'hotspot Ordering.CutOffUnclear',
        ]);
        expect(await store.handOverToHotspot(project, id(9), id(1), hotspot, user)).toEqual({
            ok: false,
            error: { type: 'KnowledgeItemNotFound', itemId: id(9) },
        });
    });

    test('drops the operations on an item a person corrected or deleted meanwhile, and keeps the person’s change', async () => {
        const project = newProject();
        await store.applyExtraction(project, extraction('s1', 1, [add(1, '締めは月末'), add(2, '請求は翌月')]));
        const corrected = await store.correct(project, id(1), wire.itemContent(content('締めは毎月20日'), 'test'), user);
        expect(corrected.ok && corrected.value.version).toBe(wire.itemVersion(2, 'test'));
        expect((await store.delete(project, id(2), user)).ok).toBe(true);

        const applied = await store.applyExtraction(
            project,
            extraction('s2', 1, [
                { kind: 'Update', item: id(1), base: 1, revised: content('締めは月末の営業日'), sources: [source('s2', 'm5')] },
                { kind: 'AddSource', item: id(2), base: 1, source: source('s2', 'm1'), agreed: false },
            ]),
        );
        expect(applied.items).toEqual([]);
        expect(applied.dropped.map((d) => d.reason)).toEqual([{ type: 'StaleOperation' }, { type: 'KnowledgeItemGone', itemId: id(2) }]);
        expect(plain((await store.get(project, id(1)))?.item.content.text)).toBe('締めは毎月20日');
    });

    test('a batch whose items changed after they were read writes nothing (the guard)', async () => {
        const project = newProject();
        await store.applyExtraction(project, extraction('s1', 1, [add(1, '見積もりは案件担当が作る')]));
        const { db } = worker;
        const write = db.prepare("INSERT INTO projects (name, visibility, created_at) VALUES ('guarded', 'open', 'x')");
        expect(
            await db.batch([guard(db, project, [{ id: id(1), rev: 99 }]), write]).then(
                () => 'written',
                () => 'rolled back',
            ),
        ).toBe('rolled back');
        expect(await db.prepare("SELECT name FROM projects WHERE name = 'guarded'").first()).toBeNull();
        await db.batch([
            guard(db, project, [
                { id: id(1), rev: 1 },
                { id: id(5), rev: null },
            ]),
            write,
        ]);
        expect(await db.prepare("SELECT name FROM projects WHERE name = 'guarded'").first()).toEqual({ name: 'guarded' });
    });
});

describe('reading', () => {
    test('filters by stickies, labels, session and full text (Japanese, two characters too), newest first, a page at a time', async () => {
        const project = newProject();
        await store.applyExtraction(
            project,
            extraction('s1', 1, [add(1, '見積もりは案件担当が作る', 's1', { quote: '見積もりは私たちが作っています', title: '見積もりの担当' })]),
        );
        await store.applyExtraction(project, extraction('s1', 2, [add(2, '請求書は月末に出す', 's1', { about: ['Billing.Issue'], kind: 'flow' })]));
        await store.applyExtraction(
            project,
            extraction('s2', 1, [add(3, 'Invoices go out at 100% of the order', 's2', { about: ['Billing.Issue'], kind: 'pain' })]),
        );

        expect(texts((await store.search(project, {})).items)).toEqual([
            'Invoices go out at 100% of the order',
            '請求書は月末に出す',
            '見積もりは案件担当が作る',
        ]);
        expect(texts(await store.about(project, [wire.stickyRef('Billing.Issue', 'test')]))).toEqual([
            'Invoices go out at 100% of the order',
            '請求書は月末に出す',
        ]);
        expect(texts((await store.search(project, { kind: ['flow', 'rule'] })).items)).toEqual(['請求書は月末に出す', '見積もりは案件担当が作る']);
        expect(texts((await store.search(project, { session: wire.sessionRef('s2', 'test') })).items)).toEqual(['Invoices go out at 100% of the order']);
        // three characters and more through the trigram index, fewer by a scan; the quotes are searched too
        expect(texts((await store.search(project, { q: '案件担当' })).items)).toEqual(['見積もりは案件担当が作る']);
        expect(texts((await store.search(project, { q: '月末' })).items)).toEqual(['請求書は月末に出す']);
        expect(texts((await store.search(project, { q: '私たち' })).items)).toEqual(['見積もりは案件担当が作る']);
        // and the titles
        expect(texts((await store.search(project, { q: 'の担当' })).items)).toEqual(['見積もりは案件担当が作る']);
        expect((await store.get(project, id(1)))?.item.content.title).toBe(wire.itemContent(content('x', { title: '見積もりの担当' }), 'test').title);
        expect(texts((await store.search(project, { q: 'invoices 100%' })).items)).toEqual(['Invoices go out at 100% of the order']);
        expect(texts((await store.search(project, { q: '0%' })).items)).toEqual(['Invoices go out at 100% of the order']);

        const one = await store.search(project, { limit: 2 });
        expect(one.items).toHaveLength(2);
        const two = await store.search(project, { limit: 2, cursor: one.next });
        expect(texts(two.items)).toEqual(['見積もりは案件担当が作る']);
        expect(two.next).toBeUndefined();
        // another project sees none of it
        expect((await store.search(newProject(), {})).items).toEqual([]);
    });
});

describe('retiring (廃止)', () => {
    const said = (message: string): unknown => ({ kind: 'Said', session: 's2', message, quote: 'もうやっていない' });
    const candidate = (item: number, over: Record<string, unknown> = {}): ReturnType<typeof wire.retirementCandidate> =>
        wire.retirementCandidate(
            {
                item: id(item),
                action: 'retire',
                reason: 'obsolete',
                explanation: 'the talk says it is no longer done',
                evidence: [said('m9')],
                proposedBy: { kind: 'Review', review: 'review-1' },
                ...over,
            },
            'test',
        );

    test('keeps the item, hidden from the lists and the counts unless asked; undone; audited', async () => {
        const project = newProject();
        await store.applyExtraction(
            project,
            extraction('s1', 1, [add(1, '古いやり方', 's1', { about: ['Ordering.Accept'] }), add(2, '新しいやり方', 's1', { about: ['Ordering.Accept'] })]),
        );
        const r = await store.retire(project, id(1), { reason: 'replaced', replacedBy: id(2) }, user);
        expect(r.ok && plain(r.value.retirement)).toMatchObject({ reason: 'replaced', replacedBy: id(2), by: user });
        expect(texts((await store.search(project, {})).items)).toEqual(['新しいやり方']);
        expect(texts((await store.search(project, { retired: 'only' })).items)).toEqual(['古いやり方']);
        expect(texts((await store.search(project, { retired: 'include' })).items).sort()).toEqual(['古いやり方', '新しいやり方'].sort());
        expect(texts(await store.about(project, [wire.stickyRef('Ordering.Accept', 'test')]))).toEqual(['新しいやり方']);
        expect((await store.get(project, id(1)))?.item.retirement?.reason).toBe('replaced');
        await store.retire(project, id(2), {}, user);
        expect(await store.counts(project, 'Ordering')).toEqual([]);
        expect(await store.retire(project, id(2), {}, user)).toEqual({ ok: false, error: { type: 'AlreadyRetired' } });
        expect(await store.retire(project, id(9), {}, user)).toEqual({ ok: false, error: { type: 'KnowledgeItemNotFound', itemId: id(9) } });
        expect((await store.unretire(project, id(1), user)).ok).toBe(true);
        expect(await store.unretire(project, id(1), user)).toEqual({ ok: false, error: { type: 'NotRetired' } });
        expect(texts((await store.search(project, {})).items)).toEqual(['古いやり方']);
        expect((await store.audit(project, {})).items.slice(0, 3).map((e) => e.operation)).toEqual(['unretire', 'retire', 'retire']);
    });

    test('proposals: the review proposes, the list shows the open ones, a person approves or dismisses, a dismissal is remembered', async () => {
        const project = newProject();
        await store.applyExtraction(project, extraction('s1', 1, [add(1, '一'), add(2, '二')]));
        const proposed = await store.propose(project, candidate(1));
        if (!proposed.ok) throw new Error('not proposed');
        expect(await store.propose(project, candidate(1))).toEqual(proposed);
        expect(await store.propose(project, candidate(1, { evidence: [said('m10')] }))).toEqual({
            ok: false,
            error: { type: 'ProposalRefused', reason: 'pending' },
        });
        expect((await reader.proposals(project)).map((p) => p.id)).toEqual([proposed.value.id]);
        // a reading token does not propose
        expect(await thrown(reader.propose(project, candidate(2)))).toMatchObject({ status: 403 });

        const approved = await store.approveProposal(project, proposed.value.id, user);
        expect(approved.ok && approved.value.item.retirement?.proposal).toBe(proposed.value.id);
        expect(await store.approveProposal(project, proposed.value.id, user)).toEqual({
            ok: false,
            error: { type: 'ProposalDecided', proposalId: proposed.value.id },
        });
        expect(await store.proposals(project)).toEqual([]);

        const second = await store.propose(project, candidate(2));
        if (!second.ok) throw new Error('not proposed');
        expect((await store.dismissProposal(project, second.value.id, user)).ok).toBe(true);
        expect(await store.propose(project, candidate(2, { proposedBy: { kind: 'Review', review: 'review-2' } }))).toEqual({
            ok: false,
            error: { type: 'ProposalRefused', reason: 'dismissedBefore' },
        });
        expect((await store.propose(project, candidate(2, { evidence: [said('m9'), said('m12')] }))).ok).toBe(true);
        expect((await store.audit(project, {})).items.map((e) => e.operation)).toContain('dismiss');
    });

    test("an extraction's proposals and the drop of an operation on a retired item; the sweep forgets a deleted item's proposals", async () => {
        const project = newProject();
        await store.applyExtraction(project, extraction('s1', 1, [add(1, '一'), add(2, '二')]));
        const applied = await store.applyExtraction(
            project,
            extraction('s2', 1, [{ kind: 'ProposeRetire', item: id(1), retirementReason: 'wrong', evidence: [said('m1')], reason: 'it never was so' }]),
        );
        expect(applied.proposals?.map((p) => [p.item, p.action])).toEqual([[id(1), 'retire']]);
        expect((await store.proposals(project)).map((p) => p.item)).toEqual([id(1)]);
        await store.retire(project, id(2), {}, user);
        const dropped = await store.applyExtraction(
            project,
            extraction('s2', 2, [{ kind: 'AddSource', item: id(2), base: 1, source: source('s2', 'm3'), agreed: false }]),
        );
        expect(plain(dropped.dropped.map((d) => d.reason))).toEqual([{ type: 'RetiredItem', itemId: id(2) }]);
        await store.delete(project, id(1), user);
        await worker.scheduled(new Date(Date.now() + 10 * 60 * 1000));
        expect(await worker.db.prepare('SELECT count(*) AS n FROM proposals WHERE project = ?1').bind(project).first<{ n: number }>()).toEqual({ n: 0 });
    });
});

describe('deleting', () => {
    test('hides at once, restores until the sweep, and the sweep removes everything and logs the messages to redact', async () => {
        const project = newProject();
        const image = await store.putImage(project, { mediaType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) });
        const shared = await store.putImage(project, { mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
        await store.applyExtraction(
            project,
            extraction('s1', 1, [
                add(1, `山田さんの電話番号は… ![](image:${image}) ![](image:${shared})`, 's1', { message: 'm1' }),
                add(2, `別の発見 ![](image:${shared})`, 's1', { message: 'm2' }),
            ]),
        );
        expect(await store.getImage(project, image)).toEqual({ mediaType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) });

        const deleted = await store.delete(project, id(1), user);
        expect(plain(deleted)).toEqual({ ok: true, value: { items: [id(1)], messages: [{ session: 's1', message: 'm1' }] } });
        expect(await store.get(project, id(1))).toBeUndefined();
        expect(texts((await store.search(project, { q: '電話番号' })).items)).toEqual([]);
        expect((await store.restore(project, id(1), user)).ok).toBe(true);
        expect((await store.get(project, id(1)))?.item.state).toBe('Live');
        expect((await store.correct(project, id(9), wire.itemContent(content('x'), 'test'), user)).ok).toBe(false);

        await store.delete(project, id(1), user);
        expect(await store.correct(project, id(1), wire.itemContent(content('x'), 'test'), user)).toEqual({
            ok: false,
            error: { type: 'KnowledgeItemGone', itemId: id(1) },
        });
        // too early for the sweep: the undo window has not passed
        await worker.scheduled(new Date());
        expect((await store.restore(project, id(1), user)).ok).toBe(true);
        await store.delete(project, id(1), user);

        await worker.scheduled(new Date(Date.now() + 10 * 60 * 1000));
        expect(await store.restore(project, id(1), user)).toEqual({ ok: false, error: { type: 'KnowledgeItemNotFound', itemId: id(1) } });
        expect(await store.getImage(project, image)).toBeUndefined();
        // an image another item refers to stays
        expect(await store.getImage(project, shared)).toBeDefined();
        const redactions = await store.redactions(project);
        expect(plain(redactions.map((r) => r.redaction))).toEqual([{ item: id(1), messages: [{ session: 's1', message: 'm1' }] }]);
        expect(await store.redactions(project, redactions[0].cursor)).toEqual([]);
        // the audit keeps who did what to the item, without the reasons
        const audit = (await store.audit(project, { item: id(1) })).items;
        expect(audit.map((a) => a.operation)).toEqual(['delete', 'restore', 'delete', 'restore', 'delete', 'add']);
        expect(audit.every((a) => a.reason === undefined)).toBe(true);
        // another item's reasons stay
        expect(plain((await store.audit(project, { item: id(2) })).items[0].reason)).toBe('s1 で言われた');
    });

    test("deletes a session's items at once", async () => {
        const project = newProject();
        await store.applyExtraction(project, extraction('s1', 1, [add(1, 'a finding'), add(2, 'another finding')]));
        await store.applyExtraction(project, extraction('s2', 1, [add(3, 'a later finding', 's2')]));
        const deletion = await store.deleteSession(project, wire.sessionRef('s1', 'test'), user);
        expect([...deletion.items].sort()).toEqual([id(1), id(2)]);
        expect(deletion.messages).toHaveLength(2);
        expect(texts((await store.search(project, {})).items)).toEqual(['a later finding']);
    });
});

describe('who may call', () => {
    test('a reading service token reads but does not write', async () => {
        const project = newProject();
        await store.applyExtraction(project, extraction('s1', 1, [add(1, 'a finding')]));
        expect((await reader.search(project, {})).items).toHaveLength(1);
        expect(await thrown(reader.applyExtraction(project, extraction('s1', 2, [add(2, 'more')])))).toMatchObject({ status: 403, type: 'Forbidden' });
        expect(await thrown(reader.delete(project, id(1), user))).toMatchObject({ status: 403 });
    });

    test('a call without an identity is refused; a person acts as itself, and the audit records the caller', async () => {
        const project = newProject();
        const path = `${worker.url}${wire.projectPath(project)}`;
        expect((await fetch(`${path}/knowledge`)).status).toBe(401);

        await store.applyExtraction(project, extraction('s1', 1, [add(1, 'a finding')]));
        const res = await fetch(`${path}/knowledge/${id(1)}`, {
            method: 'DELETE',
            headers: { 'Cf-Access-Authenticated-User-Email': 'reader@example.com', [wire.ACTOR_HEADER]: 'someone-else@example.com' },
        });
        expect(res.status).toBe(200);
        const audit = (await (await fetch(`${path}/audit`, { headers: { 'CF-Access-Client-Id': READER } })).json()) as { items: unknown[] };
        expect(audit.items).toMatchObject([
            { operation: 'delete', actor: { kind: 'Person', user: 'reader@example.com' }, caller: 'reader@example.com' },
            { operation: 'add', actor: { kind: 'Extractor', extraction: { session: 's1', number: 1 } }, caller: `service:${WRITER}` },
        ]);
    });

    test('a service token acting for a person must name it; bodies that are not the API’s are refused', async () => {
        const project = newProject();
        const path = `${worker.url}${wire.projectPath(project)}`;
        const headers = { 'CF-Access-Client-Id': WRITER, 'Content-Type': 'application/json' };
        const noActor = await fetch(`${path}/knowledge/${id(1)}`, { method: 'DELETE', headers });
        expect(noActor.status).toBe(400);
        const bad = await fetch(`${path}/extractions`, { method: 'POST', headers, body: JSON.stringify({ by: { session: 's1', number: 0 }, operations: [] }) });
        expect(bad.status).toBe(400);
        expect(await bad.json()).toMatchObject({ error: { type: 'BadRequest', message: expect.stringContaining('body.by.number') } });
        const svg = await fetch(`${path}/images`, { method: 'POST', headers: { ...headers, 'Content-Type': 'image/svg+xml' }, body: '<svg/>' });
        expect(svg.status).toBe(415);
        expect((await fetch(`${path}/published/Ordering`, { method: 'PUT', headers })).status).toBe(400);
    });

    test('without Access settings the Worker refuses every call', async () => {
        const unconfigured = await startWorker({ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' }, { migrate: false });
        try {
            const res = await fetch(`${unconfigured.url}/v1/projects/p/knowledge`, { headers: { 'CF-Access-Client-Id': WRITER } });
            expect(res.status).toBe(500);
            expect(await res.json()).toMatchObject({ error: { message: expect.stringContaining('ACCESS_AUD') } });
        } finally {
            await unconfigured.dispose();
        }
    });
});

test('migration 2: the items from before titles are removed, and a new row must have its title', async () => {
    const bare = await startWorker({ INSECURE_SKIP_ACCESS_CHECK: 'true', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', WRITER_TOKENS: WRITER }, { migrate: false });
    try {
        const migrate = async (file: string): Promise<void> => {
            const sql = await Bun.file(`${import.meta.dir}/../template/migrations/${file}`).text();
            await bare.db.batch(statementsOf(sql).map((st) => bare.db.prepare(st)));
        };
        await migrate('0001_init.sql');
        const s = cloudflareKnowledgeStore({ url: bare.url, serviceToken: { clientId: WRITER, clientSecret: 'x' } });
        const project = newProject();
        // an item as version 1 wrote it, without a title: its stickies, search text and version too
        await bare.db.batch([
            bare.db
                .prepare(
                    `INSERT INTO items (project, id, state, version, text, when_label, kind, origin, about, sources, conflicts_with, created_at, updated_at, rev)
                     VALUES (?1, 'kn_00000001', 'Live', 2, '古い', 'as_is', 'rule', 'said', '["Ordering.A"]', '[]', '[]', '2026-11-05T09:00:00.000Z', '2026-11-05T09:00:00.000Z', 1)`,
                )
                .bind(project),
            bare.db.prepare("INSERT INTO item_about (project, sticky, item) VALUES (?1, 'Ordering.A', 'kn_00000001')").bind(project),
            bare.db.prepare("INSERT INTO item_search (rowid, body) VALUES (1, '古い')"),
            bare.db.prepare("INSERT INTO item_versions (project, item, version, content, replaced_at) VALUES (?1, 'kn_00000001', 1, '{}', 'x')").bind(project),
        ]);
        await migrate('0002_item_title.sql');
        for (const table of ['items', 'item_about', 'item_search', 'item_versions'])
            expect(await bare.db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>()).toEqual({ n: 0 });
        // a row without its title is refused; the store writes it
        expect(
            await bare.db
                .prepare(
                    `INSERT INTO items (project, id, state, version, text, when_label, kind, origin, about, sources, conflicts_with, created_at, updated_at, rev)
                     VALUES ('p', 'kn_00000002', 'Live', 1, 't', 'as_is', 'rule', 'said', '[]', '[]', '[]', 'x', 'x', 1)`,
                )
                .run()
                .then(
                    () => 'written',
                    () => 'refused',
                ),
        ).toBe('refused');
        await migrate('0003_retirement.sql');
        await s.applyExtraction(project, extraction('s1', 1, [add(3, '新しい', 's1', { title: '新しい見出し' })]));
        expect((await s.search(project, {})).items.map((i) => i.content.title)).toEqual([
            wire.itemContent(content('x', { title: '新しい見出し' }), 'test').title,
        ]);
    } finally {
        await bare.dispose();
    }
});

test('an unmigrated database answers 503', async () => {
    const bare = await startWorker({ INSECURE_SKIP_ACCESS_CHECK: 'true', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' }, { migrate: false });
    try {
        const s = cloudflareKnowledgeStore({ url: bare.url, serviceToken: { clientId: WRITER, clientSecret: 'x' } });
        expect(await thrown(s.search(newProject(), {}))).toMatchObject({ status: 503, type: 'StoreNotMigrated' });
    } finally {
        await bare.dispose();
    }
});
