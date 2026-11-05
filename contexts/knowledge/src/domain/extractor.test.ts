// The extractor's reply (ADR 0031, section 3): read without trusting it — a malformed reply extracts nothing, a malformed
// operation is dropped and the others kept — and made into an extraction's operations over what the extractor was given.
import { describe, expect, test } from 'bun:test';
import { extractedItemId, extractorJsonSchema, type ExtractionInput, operationsOf, readExtractorReply, readUsage } from './extractor.js';

const input: ExtractionInput = {
    session: 's1',
    number: 3,
    messages: [
        {
            key: 'm1',
            id: 'r-1',
            at: '2026-11-05T09:00:00.000Z',
            from: 'person',
            author: 'P1',
            text: '見積もりは  営業が\n出します',
            stickies: ['Ordering.Estimate'],
            isNew: false,
        },
        { key: 'm2', id: 'r-2', at: '2026-11-05T09:01:00.000Z', from: 'person', author: 'P2', text: '急ぎの案件は当日中に出す', stickies: [], isNew: true },
        { key: 'm3', id: 'r-3', at: '2026-11-05T09:02:00.000Z', from: 'ai', author: 'AI', text: '確認しました', stickies: [], isNew: true },
    ],
    items: [
        {
            key: 'k1',
            id: 'kn_0000000001',
            version: 2,
            text: '見積もりは営業が出す',
            when: 'as_is',
            kind: 'rule',
            origin: 'said',
            about: ['Ordering.Estimate'],
            conflictsWith: [],
            thisSession: false,
            createdAt: '2026-10-01T00:00:00.000Z',
        },
    ],
    stickies: [{ ref: 'Ordering.Estimate', label: '見積もり' }],
};

/** A value compared as plain data (its brands aside). */
const plain = (v: unknown): unknown => v;

const finding = { text: '急ぎの案件は当日中に見積もりを出す', when: 'as_is', kind: 'rule', origin: 'said', about: ['Ordering.Estimate'] };

const read = (raw: unknown) => {
    const r = readExtractorReply(raw);
    if (!r.ok) throw new Error(`refused: ${r.error.path}`);
    return r.value;
};

describe("reading the extractor's reply", () => {
    test('a reply that is not { operations: [...] } is refused whole', () => {
        expect(readExtractorReply(undefined).ok).toBe(false);
        expect(readExtractorReply('{"operations": []}').ok).toBe(false);
        expect(readExtractorReply({ ops: [] }).ok).toBe(false);
        expect(readExtractorReply({ operations: {} }).ok).toBe(false);
        expect(read({ operations: [] })).toEqual({ operations: [], rejected: [] });
    });

    test('each operation is read on its own: a malformed one is dropped with why, the others kept', () => {
        const reply = read({
            operations: [
                { op: 'add', ...finding, sources: [{ message: 'm2', quote: '当日中' }], reason: '新しい決まり' },
                { op: 'add', ...finding, kind: 'opinion', sources: [{ message: 'm2', quote: 'x' }], reason: 'r' },
                { op: 'add', ...finding, sources: [], reason: 'r' },
                { op: 'update', ...finding, reason: 'r' },
                { op: 'delete', item: 'k1', reason: 'r' },
                { op: 'addSource', item: 'k1', sources: [{ message: 'm2', quote: 'q' }], reason: '' },
                'not an object',
                { op: 'addSource', item: 'k1', sources: [{ message: 'm2', quote: 'q' }], agreed: true, reason: 'again' },
            ],
        });
        expect(reply.operations.map((o) => o.op)).toEqual(['add', 'addSource']);
        expect(reply.rejected.map((r) => r.path)).toEqual([
            'reply.operations[1].kind',
            'reply.operations[2].sources',
            'reply.operations[3].item',
            'reply.operations[4].op',
            'reply.operations[5].reason',
            'reply.operations[6]',
        ]);
    });

    test('texts are trimmed and cut to their limits; operations past the limit are dropped', () => {
        const reply = read({
            operations: Array.from({ length: 45 }, () => ({
                op: 'add',
                ...finding,
                text: `  ${'x'.repeat(5000)}  `,
                sources: [{ message: 'm2', quote: 'q' }],
                reason: 'r',
            })),
        });
        expect(reply.operations).toHaveLength(40);
        expect(reply.rejected).toHaveLength(5);
        expect(reply.operations[0].op === 'add' && reply.operations[0].finding.text.length).toBe(4000);
    });

    test('the schema asks for the operations, each with its op and reason, references as keys', () => {
        const schema = extractorJsonSchema() as {
            required: string[];
            properties: { operations: { items: { required: string[]; properties: Record<string, { pattern?: string }> } } };
        };
        expect(schema.required).toEqual(['operations']);
        expect(schema.properties.operations.items.required).toEqual(['op', 'reason']);
        expect(schema.properties.operations.items.properties.item.pattern).toBe('^k[0-9]+$');
    });

    test('the usage reported: numbers only', () => {
        expect(readUsage({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 8, costUsd: 0.01, other: 1 })).toEqual({
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 8,
            costUsd: 0.01,
        });
        expect(readUsage({ inputTokens: -1, outputTokens: 'many' })).toBeUndefined();
        expect(readUsage(undefined)).toBeUndefined();
    });
});

describe('the reply made into operations', () => {
    test("an add: a new item's ID from the session, the number and its place; the source's quote, time and message", () => {
        const made = operationsOf(
            read({ operations: [{ op: 'add', ...finding, perspective: '営業', sources: [{ message: 'm2', quote: '当日中に' }], reason: '決まり' }] }),
            input,
        );
        expect(made.rejected).toEqual([]);
        expect(plain(made.operations)).toEqual([
            {
                kind: 'Add',
                id: extractedItemId('s1', 3, 0),
                content: { text: finding.text, labels: { when: 'as_is', kind: 'rule', origin: 'said', perspective: '営業' }, about: ['Ordering.Estimate'] },
                sources: [{ session: 's1', message: 'r-2', at: new Date('2026-11-05T09:01:00.000Z'), quote: '当日中に' }],
                reason: '決まり',
            },
        ]);
    });

    test('the same extraction names the same items; another number or place, others', () => {
        expect(extractedItemId('s1', 3, 0)).toBe(extractedItemId('s1', 3, 0));
        expect(extractedItemId('s1', 3, 0)).toMatch(/^kn_[0-9a-z]{13}$/);
        expect(new Set([extractedItemId('s1', 3, 0), extractedItemId('s1', 3, 1), extractedItemId('s1', 4, 0), extractedItemId('s2', 3, 0)]).size).toBe(4);
    });

    test("a quote not in its message is replaced by the message's start; spacing does not matter", () => {
        const made = operationsOf(
            read({
                operations: [
                    { op: 'add', ...finding, sources: [{ message: 'm1', quote: '営業が 出します' }], reason: 'r' },
                    { op: 'add', ...finding, sources: [{ message: 'm2', quote: 'something nobody said' }], reason: 'r' },
                ],
            }),
            input,
        );
        const quotes = made.operations.map((o) => (o.kind === 'Add' ? o.sources[0].quote : undefined));
        expect(plain(quotes)).toEqual(['営業が 出します', '急ぎの案件は当日中に出す']);
    });

    test('items and messages by their keys: an unknown key drops the operation (or the source); a base is the version given', () => {
        const made = operationsOf(
            read({
                operations: [
                    { op: 'update', item: 'k1', ...finding, sources: [{ message: 'm2', quote: '当日中' }], reason: 'more precise' },
                    { op: 'update', item: 'k9', ...finding, sources: [{ message: 'm2', quote: '当日中' }], reason: 'r' },
                    { op: 'addSource', item: 'k1', sources: [{ message: 'm9', quote: 'q' }], reason: 'r' },
                    {
                        op: 'addSource',
                        item: 'k1',
                        sources: [
                            { message: 'm2', quote: '当日中' },
                            { message: 'm3', quote: '確認' },
                        ],
                        agreed: true,
                        reason: 'again',
                    },
                    { op: 'conflict', item: 'k1', ...finding, sources: [{ message: 'm2', quote: '当日中' }], reason: 'contradicts' },
                ],
            }),
            input,
        );
        expect(plain(made.operations.map((o) => [o.kind, 'item' in o ? o.item : undefined, 'base' in o ? o.base : undefined]))).toEqual([
            ['Update', 'kn_0000000001', 2],
            ['AddSource', 'kn_0000000001', 2],
            ['AddSource', 'kn_0000000001', 2],
            ['Conflict', 'kn_0000000001', 2],
        ]);
        expect(made.operations[3].kind === 'Conflict' && made.operations[3].id).toBe(extractedItemId('s1', 3, 4));
        expect(made.rejected.map((r) => r.path)).toEqual(['reply.operations[1].item', 'reply.operations[2].sources[0]', 'reply.operations[2].sources']);
    });

    test('stickies the extractor was not given are left out of `about`; duplicate sources kept once', () => {
        const made = operationsOf(
            read({
                operations: [
                    {
                        op: 'add',
                        ...finding,
                        about: ['Ordering.Estimate', 'Billing.Invoice', 'not a ref', 'Ordering.Estimate'],
                        sources: [
                            { message: 'm2', quote: '当日中' },
                            { message: 'm2', quote: '急ぎ' },
                        ],
                        reason: 'r',
                    },
                ],
            }),
            input,
        );
        const op = made.operations[0];
        expect(plain(op.kind === 'Add' && [op.content.about, op.sources.length])).toEqual([['Ordering.Estimate'], 1]);
        expect(made.rejected.map((r) => r.message)).toEqual([
            'Billing.Invoice is not a sticky that was given; left out.',
            'not a ref is not a sticky that was given; left out.',
        ]);
    });

    test('a sticky of the workspace given, which no message points at, is kept in `about`; one not given is still left out', () => {
        const given: ExtractionInput = {
            ...input,
            workspaceStickies: [
                { ref: 'Ordering.Rush', label: '急ぎの見積もり', kind: 'event' },
                { ref: 'Ordering.Sales', label: '営業', kind: 'actor' },
            ],
        };
        const made = operationsOf(
            read({
                operations: [
                    {
                        op: 'add',
                        ...finding,
                        about: ['Ordering.Rush', 'Ordering.Sales', 'Ordering.Estimate', 'Billing.Invoice'],
                        sources: [{ message: 'm2', quote: '当日中' }],
                        reason: 'r',
                    },
                ],
            }),
            given,
        );
        const op = made.operations[0];
        expect(plain(op.kind === 'Add' && op.content.about)).toEqual(['Ordering.Rush', 'Ordering.Sales', 'Ordering.Estimate']);
        expect(made.rejected.map((r) => r.message)).toEqual(['Billing.Invoice is not a sticky that was given; left out.']);
    });

    test('an update names the messages it rests on: one without a source is dropped with why; its sources are made like an add’s', () => {
        const reply = read({
            operations: [
                { op: 'update', item: 'k1', ...finding, reason: 'more precise' },
                { op: 'update', item: 'k1', ...finding, sources: [{ message: 'm9', quote: 'x' }], reason: 'r' },
                { op: 'update', item: 'k1', ...finding, sources: [{ message: 'm2', quote: '当日中' }], reason: 'corrected' },
            ],
        });
        expect(reply.rejected).toEqual([{ path: 'reply.operations[0].sources', message: 'Expected at least one source.' }]);
        const made = operationsOf(reply, input);
        // the one read without a source, then the one whose only source is not a message given
        expect(made.rejected.map((r) => r.path)).toEqual(['reply.operations[0].sources', 'reply.operations[0].sources[0]', 'reply.operations[0].sources']);
        const [op] = made.operations;
        expect(plain(made.operations.length)).toBe(1);
        expect(plain(op.kind === 'Update' && op.sources.map((s) => [s.message, s.quote]))).toEqual([['r-2', '当日中']]);
    });
});
