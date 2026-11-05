// The knowledge tools of `dt mcp`, called in process on a temporary workspace: items in its `files` store, a storming
// whose stickies `ref` the `.dt` model.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createFilesKnowledgeStore, Knowledge, type KnowledgeStore } from '@domaintrail/knowledge';
import { analyzeStormings } from '@domaintrail/storming';
import { knowledgeTools, LIST_TEXT_CHARS, stickyIndex, type StickyIndex } from './knowledge-tools.js';
import type { McpTool } from './protocol.js';

const made = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
};

const DTES = `storming Ordering "受注" {
  event OrderConfirmed "注文が確定した" {
    ref Sales.OrderConfirmed
  }
  aggregate Order "注文" {
    ref Sales.Order
  }
  command ConfirmOrder "注文を確定する" {
    ref Sales.Order.confirm
    target Order
    emits OrderConfirmed
  }
  event Shipped "出荷した"
}
`;

const project = made(Knowledge.makeProjectName('shop'));
const ref = (s: string): Knowledge.StickyRef => made(Knowledge.makeStickyRef(s));

let root: string;
let store: KnowledgeStore;
let stickies: StickyIndex;
let tools: Record<string, McpTool>;

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
    return tools[name].call(args);
}

const add = (
    id: string,
    text: string,
    about: string[],
    labels: Knowledge.Labels,
    message: string,
    at: string,
): Extract<Knowledge.Operation, { kind: 'Add' }> => ({
    kind: 'Add',
    id: made(Knowledge.makeKnowledgeItemId(id)),
    content: { text: made(Knowledge.makeItemText(text)), labels, about: about.map(ref) },
    sources: [
        {
            session: made(Knowledge.makeSessionRef('s1')),
            message: made(Knowledge.makeMessageRef(message)),
            at: new Date(at),
            quote: made(Knowledge.makeQuote(`quote of ${message}`)),
        },
    ],
});

beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'domaintrail-mcp-tools-'));
    let clock = new Date('2026-11-05T09:00:00Z');
    store = createFilesKnowledgeStore({ dir: path.join(root, 'knowledge'), project, stateDir: path.join(root, 'state'), now: () => clock });
    const by = (n: number): Knowledge.ExtractionRef => ({ session: made(Knowledge.makeSessionRef('s1')), number: made(Knowledge.makeExtractionNumber(n)) });
    await store.applyExtraction(project, {
        by: by(1),
        operations: [
            add('kn_00000001', '確定は営業が電話で確かめてから押す。', ['Ordering.ConfirmOrder'], { when: 'as_is', kind: 'flow', origin: 'said', perspective: made(Knowledge.makePerspective('営業')) }, 'm1', '2026-11-05T09:00:00Z'),
            add('kn_00000002', '確定した注文は取り消せない。', ['Ordering.Order', 'Ordering.OrderConfirmed'], { when: 'to_be', kind: 'rule', origin: 'agreed' }, 'm2', '2026-11-05T09:01:00Z'),
        ],
    });
    clock = new Date('2026-11-06T10:00:00Z');
    await store.applyExtraction(project, {
        by: by(2),
        operations: [
            { ...add('kn_00000003', `出荷は月末にまとめる。${'長い説明。'.repeat(200)}`, ['Ordering.Shipped', 'Gone.Sticky'], { when: 'none', kind: 'pain', origin: 'inferred' }, 'm3', '2026-11-06T10:00:00Z') },
        ],
    });
    stickies = stickyIndex((await analyzeStormings([{ path: 'ordering.dtes', text: DTES }], undefined)).stormings);
    tools = Object.fromEntries(knowledgeTools({ access: { store, project }, stickies: async () => stickies }).map((t) => [t.name, t]));
});
afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('stickyIndex', () => {
    test('the node elements by Storming.LocalId, with their label, kind and ref', () => {
        expect(stickies.get('Ordering.ConfirmOrder')).toEqual({ ref: ref('Ordering.ConfirmOrder'), kind: 'command', label: '注文を確定する', dt: 'Sales.Order.confirm' });
        expect(stickies.get('Ordering.Shipped')).toEqual({ ref: ref('Ordering.Shipped'), kind: 'event', label: '出荷した' });
        expect([...stickies.keys()]).toEqual(['Ordering.OrderConfirmed', 'Ordering.Order', 'Ordering.ConfirmOrder', 'Ordering.Shipped']);
    });
});

describe('knowledge_for_element', () => {
    test('a sticky: its items, newest first, with labels, date, ID and the stickies they are about', async () => {
        const r = await call('knowledge_for_element', { element: 'Ordering.ConfirmOrder' });
        expect(r.isError).toBeUndefined();
        expect(r.text).toBe(
            [
                'Ordering.ConfirmOrder "注文を確定する" (command, dt:Sales.Order.confirm).',
                '1 item(s), newest first.',
                '',
                "Labels: kind, when (as_is / to_be), origin (said: one person, unconfirmed; agreed: several agreed; investigated: the AI checked code or documents; inferred: the AI's guess), perspective.",
                '',
                '## kn_00000001 — flow · as_is · said · 営業 (2026-11-05)',
                'about: Ordering.ConfirmOrder "注文を確定する" (command, dt:Sales.Order.confirm)',
                '',
                '確定は営業が電話で確かめてから押す。',
            ].join('\n'),
        );
    });

    test('a .dt element: through the stickies that ref it or an element inside it', async () => {
        const command = await call('knowledge_for_element', { element: 'dt:Sales.Order.confirm' });
        expect(command.text).toStartWith('dt:Sales.Order.confirm is drawn as: Ordering.ConfirmOrder "注文を確定する" (command, dt:Sales.Order.confirm).');
        expect(command.text).toContain('## kn_00000001');
        expect(command.text).not.toContain('## kn_00000002');
        const aggregate = await call('knowledge_for_element', { element: 'dt:Sales.Order' });
        expect(aggregate.text).toContain('Ordering.Order "注文" (aggregate, dt:Sales.Order), Ordering.ConfirmOrder');
        expect(aggregate.text.indexOf('## kn_00000002')).toBeLessThan(aggregate.text.indexOf('## kn_00000001'));
        const event = await call('knowledge_for_element', { element: 'dt:Sales.OrderConfirmed' });
        expect(event.text).toContain('## kn_00000002 — rule · to_be · agreed (2026-11-05)');
    });

    test('a .dt element no sticky refs: says so, not an error', async () => {
        const r = await call('knowledge_for_element', { element: 'dt:Billing.Invoice' });
        expect(r.isError).toBeUndefined();
        expect(r.text).toStartWith("No sticky of the workspace's stormings has `ref Billing.Invoice`");
    });

    test('a long text is cut in a list; a sticky the stormings lack is said', async () => {
        const r = await call('knowledge_for_element', { element: 'Ordering.Shipped' });
        expect(r.text).toContain('## kn_00000003 — pain · inferred (2026-11-06)');
        expect(r.text).toContain('about: Ordering.Shipped "出荷した" (event), Gone.Sticky (no such sticky in the stormings now)');
        expect(r.text).toContain('… (cut; knowledge_get has all of it)');
        expect(r.text.length).toBeLessThan(LIST_TEXT_CHARS + 1000);
        const gone = await call('knowledge_for_element', { element: 'Gone.Sticky' });
        expect(gone.text).toStartWith("Gone.Sticky is no sticky of the workspace's stormings now (items about it may remain).");
        expect(gone.text).toContain('## kn_00000003');
    });

    test('a .dt path without dt: is suggested; a malformed element is an error of the tool', async () => {
        const r = await call('knowledge_for_element', { element: 'Sales.Order' });
        expect(r.text).toContain('Did you mean dt:Sales.Order? Stickies ref it: Ordering.Order, Ordering.ConfirmOrder.');
        expect(await call('knowledge_for_element', { element: 'Order' })).toEqual({
            text: "'Order' is not a sticky as '<Storming>.<LocalId>' (e.g. 'Ordering.CreateSpecification'), or a .dt element as 'dt:<Context>.<Aggregate>[.<command>]' or 'dt:<Context>.<Event>'.",
            isError: true,
        });
        expect(await call('knowledge_for_element', {})).toEqual({ text: "'element' is required.", isError: true });
    });
});

describe('knowledge_search', () => {
    test('without filters: the newest items', async () => {
        const r = await call('knowledge_search', {});
        expect(r.text).toStartWith('3 item(s), newest first.');
        expect(r.text.indexOf('kn_00000003')).toBeLessThan(r.text.indexOf('kn_00000001'));
    });

    test('filters: query, about (a .dt element too), when, kind, origin, perspective, limit', async () => {
        const ids = async (args: Record<string, unknown>): Promise<string[]> =>
            [...(await call('knowledge_search', args)).text.matchAll(/^## (kn_\w+)/gm)].map((m) => m[1]);
        expect(await ids({ query: '取り消せない' })).toEqual(['kn_00000002']);
        expect(await ids({ about: 'Ordering.ConfirmOrder' })).toEqual(['kn_00000001']);
        expect(await ids({ about: ['dt:Sales.OrderConfirmed', 'Ordering.Shipped'] })).toEqual(['kn_00000003', 'kn_00000002']);
        expect(await ids({ when: 'as_is' })).toEqual(['kn_00000001']);
        expect(await ids({ kind: ['rule', 'pain'] })).toEqual(['kn_00000003', 'kn_00000002']);
        expect(await ids({ origin: 'agreed' })).toEqual(['kn_00000002']);
        expect(await ids({ perspective: '営業' })).toEqual(['kn_00000001']);
        const limited = await call('knowledge_search', { limit: 1 });
        expect(limited.text).toStartWith('1 item(s), newest first; more match: narrow the search or raise limit (at most 50).');
        expect(await call('knowledge_search', { query: 'nothing like this' })).toEqual({ text: 'No item matches.' });
    });

    test('a wrong filter is an error of the tool', async () => {
        expect(await call('knowledge_search', { kind: 'story' })).toEqual({
            text: '\'kind\' must be one or more of rule, flow, example, term, pain, want, decision; got "story".',
            isError: true,
        });
        expect((await call('knowledge_search', { limit: 0 })).isError).toBe(true);
        expect((await call('knowledge_search', { about: 'nope' })).isError).toBe(true);
    });
});

describe('knowledge_get', () => {
    test('the whole item with its sources; with history, its earlier versions (none kept by files)', async () => {
        const r = await call('knowledge_get', { id: 'kn_00000001', history: true });
        expect(r.text).toBe(
            [
                '## kn_00000001',
                'kind: flow (流れ) · when: as_is (AS-IS) · origin: said (発言) · perspective: 営業',
                'version 1 · created 2026-11-05 09:00Z in session s1 · updated 2026-11-05 09:00Z',
                'about: Ordering.ConfirmOrder "注文を確定する" (command, dt:Sales.Order.confirm)',
                '',
                '確定は営業が電話で確かめてから押す。',
                '',
                '### Sources',
                '- 2026-11-05 09:00Z, session s1, message m1: "quote of m1"',
                '',
                '### Earlier versions',
                '- (none: this is the first version)',
            ].join('\n'),
        );
        const long = await call('knowledge_get', { id: 'kn_00000003' });
        expect(long.text).toContain('長い説明。'.repeat(200));
        expect(long.text).not.toContain('### Earlier versions');
    });

    test('a missing item, or a wrong ID, is an error of the tool', async () => {
        expect(await call('knowledge_get', { id: 'kn_99999999' })).toEqual({
            text: 'No knowledge item kn_99999999: the ID is wrong, or the item was deleted.',
            isError: true,
        });
        expect((await call('knowledge_get', { id: 'K1' })).isError).toBe(true);
        expect((await call('knowledge_get', { id: 'kn_00000001', history: 'yes' })).isError).toBe(true);
    });
});

describe('without a store', () => {
    test('every tool says why, as an error of the tool', async () => {
        const [first] = knowledgeTools({ access: { unavailable: "the knowledge store 'cloudflare' is not available" }, stickies: async () => stickies });
        expect(await first.call({ element: 'Ordering.Order' })).toEqual({
            text: "No knowledge can be read: the knowledge store 'cloudflare' is not available.",
            isError: true,
        });
    });
});
