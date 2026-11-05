// A session's extractions over fakes of their ports (ADR 0031, section 3): the input given, the guards at work across
// extractions, the checkpoint that makes a restart neither repeat nor lose work, the cost recorded, and the timing put
// to work by the scheduler.
import { describe, expect, test } from 'bun:test';
import { DatabaseSync } from 'node:sqlite';
import type { Knowledge } from '../generated/index.js';
import type { ExtractionInput, ExtractionResultBody } from '../domain/extractor.js';
import { extractedItemId } from '../domain/extractor.js';
import { createExtractionScheduler } from './extraction-scheduler.js';
import {
    createSessionExtraction,
    EMPTY_CHECKPOINT,
    type ExtractionCheckpoint,
    type ExtractionCheckpoints,
    type ExtractionCost,
    type Extractor,
    type SessionMessage,
} from './extraction.js';
import { createSqliteCheckpoints, extractionCosts } from '../infrastructure/sqlite-checkpoints.js';
import { content, liveItem, memoryStore } from '../test-helpers.js';

const SESSION = 'sess-1';
const project = 'shop' as Knowledge.ProjectName;
const config = { quietSeconds: 30, minIntervalSeconds: 60, contextMinutes: 10, settleSeconds: 120 };
const t = (s: number): Date => new Date(Date.UTC(2026, 10, 5, 9, 0, 0) + s * 1000);

const message = (id: string, at: number, over: Partial<SessionMessage> = {}): SessionMessage => ({
    id,
    at: t(at),
    from: 'person',
    author: 'P1',
    text: `message ${id} about the estimate`,
    stickies: [{ ref: 'Ordering.Estimate', label: '見積もり' }],
    answer: false,
    ...over,
});

/** Checkpoints in memory, kept as the session database keeps them (survive a new extraction object: a restart). */
function memoryCheckpoints(): ExtractionCheckpoints & { costs: ExtractionCost[]; saved: () => ExtractionCheckpoint } {
    let saved: ExtractionCheckpoint = EMPTY_CHECKPOINT;
    const costs: ExtractionCost[] = [];
    return {
        costs,
        saved: () => saved,
        load: async () => saved,
        save: async (_s, c) => void (saved = c),
        recordCost: async (c) => void costs.push(c),
    };
}

/** An extractor that replies what the test gives it, and keeps the inputs it was given. */
function fakeExtractor(...replies: (ExtractionResultBody | 'unavailable')[]): Extractor & { inputs: ExtractionInput[] } {
    const inputs: ExtractionInput[] = [];
    return {
        inputs,
        async extract(input) {
            inputs.push(input);
            const reply = replies.shift() ?? { reply: { operations: [] }, durationMs: 1 };
            return reply === 'unavailable' ? { kind: 'unavailable' } : { kind: 'done', result: reply };
        },
    };
}

const reply = (...operations: unknown[]): ExtractionResultBody => ({
    reply: { operations },
    model: 'claude-opus',
    durationMs: 4200,
    usage: { inputTokens: 9000, outputTokens: 300, cacheReadTokens: 7000, cacheCreationTokens: 0, costUsd: 0.02 },
});
const addFinding = (message: string, text = '急ぎの見積もりは当日中に出す') => ({
    op: 'add',
    text,
    when: 'as_is',
    kind: 'rule',
    origin: 'said',
    about: ['Ordering.Estimate'],
    sources: [{ message, quote: 'estimate' }],
    reason: 'a rule was stated',
});
const updateFinding = (item: string, text = '急ぎの見積もりは当日17時までに出す') => ({
    op: 'update',
    item,
    text,
    when: 'as_is',
    kind: 'rule',
    origin: 'said',
    about: ['Ordering.Estimate'],
    reason: 'more precise',
});

function setup(messages: SessionMessage[], extractor: Extractor, over: { items?: Knowledge.LiveKnowledgeItem[]; now?: () => Date } = {}) {
    const store = memoryStore(over.items);
    const checkpoints = memoryCheckpoints();
    const log: string[] = [];
    let now = t(1000);
    const make = (): ReturnType<typeof createSessionExtraction> =>
        createSessionExtraction({
            project,
            session: SESSION,
            store,
            checkpoints,
            talk: { messages: async () => messages },
            extractor,
            config,
            now: over.now ?? (() => now),
            log: (line) => log.push(line),
        });
    return { store, checkpoints, log, extraction: make(), restart: make, setNow: (d: Date) => (now = d) };
}

describe("a session's extraction", () => {
    test('the input: the new messages after the talk of the last ten minutes, keyed; the items of the session and of the stickies', async () => {
        const messages = [message('old', 0), message('ctx', 500), message('new', 1000, { from: 'ai', author: 'AI', answer: true })];
        const aboutIt = { ...liveItem('kn_00000077', { createdIn: 'sess-0' }), content: content('見積もりは営業が出す', 'said', ['Ordering.Estimate']) };
        const elsewhere = liveItem('kn_00000078', { createdIn: 'sess-0' });
        const mine = liveItem('kn_00000079', { createdIn: SESSION });
        const extractor = fakeExtractor(reply());
        const { extraction, checkpoints } = setup(messages, extractor, { items: [aboutIt, elsewhere, mine] });
        await checkpoints.save(SESSION, { ...EMPTY_CHECKPOINT, number: 4, lastMessage: 'ctx', lastMessageAt: t(500) });
        expect<unknown>(await extraction.extract('answer')).toEqual({ applied: 0, held: 0, dropped: 0, rejected: 0 });
        const [input] = extractor.inputs;
        expect<unknown>(input.number).toBe(5);
        expect<unknown>(input.messages.map((m) => [m.key, m.id, m.isNew, m.author])).toEqual([
            ['m1', 'ctx', false, 'P1'],
            ['m2', 'new', true, 'AI'],
        ]);
        expect<unknown>(input.items.map((i) => [i.key, i.id, i.thisSession])).toEqual([
            ['k1', 'kn_00000079', true],
            ['k2', 'kn_00000077', false],
        ]);
        expect<unknown>(input.stickies).toEqual([{ ref: 'Ordering.Estimate', label: '見積もり' }]);
    });

    test('adds apply at once, with the idempotency key of the session and the number; the checkpoint moves on; the cost is recorded', async () => {
        const messages = [message('r1', 990), message('r2', 995, { from: 'ai', author: 'AI', answer: true })];
        const { extraction, store, checkpoints, log } = setup(messages, fakeExtractor(reply(addFinding('m1'))));
        expect<unknown>(await extraction.extract('answer')).toEqual({ applied: 1, held: 0, dropped: 0, rejected: 0 });
        expect<unknown>(store.applied.map((e) => [e.by.session, e.by.number, e.operations.map((o) => o.kind)])).toEqual([[SESSION, 1, ['Add']]]);
        expect<unknown>([...store.items.keys()]).toEqual([extractedItemId(SESSION, 1, 0)]);
        expect<unknown>(checkpoints.saved()).toEqual({ number: 1, lastMessage: 'r2', lastMessageAt: t(995), lastExtractionAt: t(1000), held: [], failures: 0 });
        expect<unknown>(checkpoints.costs).toEqual([
            {
                session: SESSION,
                number: 1,
                trigger: 'answer',
                at: t(1000),
                model: 'claude-opus',
                durationMs: 4200,
                usage: { inputTokens: 9000, outputTokens: 300, cacheReadTokens: 7000, cacheCreationTokens: 0, costUsd: 0.02 },
                messages: 2,
                newMessages: 2,
                items: 0,
                proposed: 1,
                applied: 1,
                held: 0,
                dropped: 0,
                rejected: 0,
            },
        ]);
        expect<unknown>(log.at(-1)).toBe(
            'knowledge: extraction 1 (answer; 2 new of 2 messages, 0 items): 1 proposed: 1 applied, 0 held, 0 dropped, 0 rejected; tokens in 9000 (cache read 7000, written 0), out 300; $0.0200; 4.2 s (claude-opus)',
        );
        expect<unknown>(await extraction.extract('quiet')).toBe('nothing-new');
    });

    test('an update is held, unseen, and applies when the next extraction makes the same call', async () => {
        const messages = [message('r1', 900)];
        const mine = liveItem('kn_00000001', { createdIn: SESSION });
        const { extraction, store, checkpoints } = setup(messages, fakeExtractor(reply(updateFinding('k1')), reply(updateFinding('k1', '急ぎは17時まで'))), {
            items: [mine],
        });
        expect<unknown>(await extraction.extract('quiet')).toEqual({ applied: 0, held: 1, dropped: 0, rejected: 0 });
        expect<unknown>(store.applied).toEqual([]);
        expect<unknown>(checkpoints.saved().held.map((h) => [h.operation.kind, h.operation.item, h.heldIn, h.heldAt])).toEqual([
            ['Update', 'kn_00000001', 1, t(900)],
        ]);
        messages.push(message('r2', 1000));
        expect<unknown>(await extraction.extract('quiet')).toEqual({ applied: 1, held: 0, dropped: 0, rejected: 0 });
        const item = store.items.get('kn_00000001');
        expect<unknown>(item?.state === 'Live' && [item.content.text, item.version]).toEqual(['急ぎは17時まで', 1]);
    });

    test('a held update the next extraction calls otherwise is dropped; one nobody returns to applies once settled', async () => {
        const messages = [message('r1', 900)];
        // the store lists the newest first: k1 is kn_00000001, k2 kn_00000002
        const items = [liveItem('kn_00000002', { createdIn: SESSION }), liveItem('kn_00000001', { createdIn: SESSION })];
        const extractor = fakeExtractor(reply(updateFinding('k1'), updateFinding('k2')), reply({ ...updateFinding('k1'), kind: 'example' }));
        const { extraction, store, checkpoints, setNow } = setup(messages, extractor, { items });
        await extraction.extract('quiet');
        messages.push(message('r2', 1000));
        expect<unknown>(await extraction.extract('quiet')).toEqual({ applied: 0, held: 2, dropped: 1, rejected: 0 });
        expect<unknown>(checkpoints.saved().held.map((h) => [h.operation.item, h.heldIn])).toEqual([
            ['kn_00000001', 2],
            ['kn_00000002', 1],
        ]);
        // nobody spoke of k2 again: settled two minutes after its talk
        setNow(new Date(t(900).getTime() + 120_000));
        expect<unknown>((await extraction.talkState()).settleAt).toEqual(new Date(t(900).getTime() + 120_000));
        await extraction.settle(false);
        expect<unknown>(store.applied.map((e) => [e.by.number, e.operations.map((o) => (o.kind === 'Update' ? o.item : o.kind))])).toEqual([
            [3, ['kn_00000002']],
        ]);
        expect<unknown>(checkpoints.saved().held.map((h) => h.operation.item)).toEqual(['kn_00000001']);
        // the session ends: what is held applies
        await extraction.settle(true);
        expect<unknown>(checkpoints.saved().held).toEqual([]);
        expect<unknown>(store.applied.map((e) => e.by.number)).toEqual([3, 4]);
    });

    test('an extractor that fails leaves the messages to the next extraction, then skips them after two failures in a row', async () => {
        const messages = [message('r1', 900)];
        const failed: ExtractionResultBody = { error: 'claude exited with 1', durationMs: 10 };
        const { extraction, checkpoints, store } = setup(messages, fakeExtractor(failed, failed));
        expect<unknown>(await extraction.extract('quiet')).toBe('failed');
        expect<unknown>(checkpoints.saved()).toMatchObject({ number: 1, failures: 1, lastExtractionAt: t(1000) });
        expect<unknown>(checkpoints.saved().lastMessage).toBeUndefined();
        expect<unknown>(await extraction.extract('quiet')).toBe('failed');
        expect<unknown>(checkpoints.saved()).toMatchObject({ number: 2, failures: 0, lastMessage: 'r1' });
        expect<unknown>(checkpoints.costs.map((c) => c.error)).toEqual(['claude exited with 1', 'claude exited with 1']);
        expect<unknown>(store.applied).toEqual([]);
    });

    test('a malformed reply extracts nothing, safely; the messages are not asked about again', async () => {
        const messages = [message('r1', 900)];
        const { extraction, checkpoints, store, log } = setup(messages, fakeExtractor({ reply: 'not json at all', durationMs: 3 }));
        expect<unknown>(await extraction.extract('quiet')).toEqual({ applied: 0, held: 0, dropped: 0, rejected: 1 });
        expect<unknown>(store.applied).toEqual([]);
        expect<unknown>(checkpoints.saved().lastMessage).toBe('r1');
        expect<unknown>(log.some((l) => l.includes('the reply is not one'))).toBe(true);
    });

    test('no extractor connected: nothing changes, the scheduler asks again when one connects', async () => {
        const { extraction, checkpoints } = setup([message('r1', 900)], fakeExtractor('unavailable'));
        expect<unknown>(await extraction.extract('quiet')).toBe('unavailable');
        expect<unknown>(checkpoints.saved()).toEqual(EMPTY_CHECKPOINT);
    });

    test('a store that fails keeps the extraction pending; after a restart it is sent first, and a store that had it applies nothing twice', async () => {
        const messages = [message('r1', 900)];
        const extractor = fakeExtractor(reply(addFinding('m1')), reply());
        const { extraction, checkpoints, store, restart } = setup(messages, {
            // the store goes away while the extractor works
            extract: async (input) => {
                store.failing = true;
                return extractor.extract(input);
            },
        });
        expect<unknown>(await extraction.extract('quiet')).toBe('store-failed');
        expect<unknown>(checkpoints.saved().pending?.by.number).toBe(1);
        expect<unknown>(checkpoints.saved().lastMessage).toBe('r1');
        // something pending is due at once
        expect<unknown>((await extraction.talkState()).settleAt).toEqual(new Date(0));
        store.failing = false;
        const again = restart();
        await again.settle(false);
        expect<unknown>(checkpoints.saved().pending).toBeUndefined();
        expect<unknown>(store.applied.map((e) => e.by.number)).toEqual([1]);
        // sent once more (a store that applied it, but whose answer was lost): replayed, nothing applied twice
        await checkpoints.save(SESSION, { ...checkpoints.saved(), pending: store.applied[0] });
        await restart().settle(false);
        expect<unknown>(store.applied.map((e) => e.by.number)).toEqual([1]);
        expect<unknown>(store.items.size).toBe(1);
    });

    test('where the talk stands: a person waiting, the answer, the held operations', async () => {
        const messages = [message('r1', 900), message('r2', 905, { from: 'ai', author: 'AI', answer: true }), message('r3', 910)];
        const { extraction } = setup(messages, fakeExtractor());
        expect<unknown>(await extraction.talkState()).toEqual({ lastMessageAt: t(910), personWaiting: true, answeredAt: t(905) });
    });
});

describe('the checkpoint in the session database', () => {
    test('a checkpoint with held and pending operations reads back as it was written, dates and all', async () => {
        const db = new DatabaseSync(':memory:');
        const sqlite = createSqliteCheckpoints(db);
        const messages = [message('r1', 900)];
        const store = memoryStore([liveItem('kn_00000001', { createdIn: SESSION })]);
        store.failing = false;
        const extraction = createSessionExtraction({
            project,
            session: SESSION,
            store,
            checkpoints: sqlite,
            talk: { messages: async () => messages },
            extractor: fakeExtractor(reply(addFinding('m1'), updateFinding('k1'))),
            config,
            now: () => t(1000),
            log: () => {},
        });
        await extraction.extract('quiet');
        const read = await sqlite.load(SESSION);
        expect<unknown>(read.number).toBe(1);
        expect<unknown>(read.lastMessageAt).toEqual(t(900));
        expect<unknown>(read.held[0].heldAt).toEqual(t(900));
        expect<unknown>(read.held[0].operation.kind).toBe('Update');
        // a pending extraction's sources come back with their dates
        await sqlite.save(SESSION, { ...read, pending: store.applied[0] });
        const pending = (await createSqliteCheckpoints(db).load(SESSION)).pending;
        expect<unknown>(pending?.operations[0].kind === 'Add' && pending.operations[0].sources[0].at).toEqual(t(900));
        expect<unknown>(extractionCosts(db, SESSION).map((c) => [c.number, c.applied, c.held])).toEqual([[1, 1, 1]]);
        expect<unknown>(await createSqliteCheckpoints(db).load('another')).toEqual(EMPTY_CHECKPOINT);
        db.close();
    });
});

describe('the scheduler', () => {
    /** Timers fired by the test. */
    function manualTimers() {
        const armed: { at: number; run: () => void; cancelled: boolean }[] = [];
        return {
            armed,
            set(ms: number, run: () => void) {
                const timer = { at: ms, run, cancelled: false };
                armed.push(timer);
                return () => void (timer.cancelled = true);
            },
            fire() {
                const live = armed.filter((a) => !a.cancelled);
                armed.length = 0;
                for (const a of live) a.run();
            },
        };
    }

    test("waits for 30 s of quiet after a person's message, extracts, and at the end extracts what is new once more", async () => {
        const messages = [message('r1', 10)];
        let now = t(15);
        const extractor = fakeExtractor(reply(addFinding('m1')), reply());
        const { extraction } = setup(messages, extractor, { now: () => now });
        const timers = manualTimers();
        const scheduler = createExtractionScheduler({ extraction, timing: { quietMs: 30_000, minIntervalMs: 60_000 }, now: () => now, timers, log: () => {} });
        scheduler.kick();
        await scheduler.settled();
        expect<unknown>(extractor.inputs).toEqual([]);
        expect<unknown>(timers.armed.map((a) => a.at)).toEqual([25_000]);
        now = t(40);
        timers.fire();
        await scheduler.settled();
        expect<unknown>(extractor.inputs.map((i) => i.number)).toEqual([1]);
        // a message right after: the minute between extractions is kept
        messages.push(message('r2', 45));
        now = t(80);
        scheduler.kick();
        await scheduler.settled();
        expect<unknown>(extractor.inputs).toHaveLength(1);
        // the end: at once
        await scheduler.end();
        expect<unknown>(extractor.inputs.map((i) => [i.number, i.messages.filter((m) => m.isNew).map((m) => m.id)])).toEqual([
            [1, ['r1']],
            [2, ['r2']],
        ]);
        scheduler.stop();
    });
});
