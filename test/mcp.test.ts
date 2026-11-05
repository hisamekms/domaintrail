// `dt mcp` as a child process over stdio (ADR 0031, section 9): initialize, the tools, and one call against a workspace
// with an item in its `files` store; nothing but the protocol on stdout.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

const BIN = path.join(import.meta.dir, '..', 'bin', 'dt.ts');

setDefaultTimeout(30_000);

const DT = 'context Sales {\n  id OrderId: UUID\n\n  aggregate Order {\n    id: OrderId\n\n    create command place() -> Placed\n\n    state Placed\n  }\n}\n';
const DTES = 'storming Ordering "受注" {\n  command PlaceOrder "注文する" {\n    ref Sales.Order.place\n  }\n}\n';
const ITEM = [
    '---',
    'id: kn_00000001',
    'version: 1',
    'when: as_is',
    'kind: rule',
    'origin: agreed',
    'about:',
    '  - Ordering.PlaceOrder',
    'conflictsWith: []',
    'createdAt: 2026-11-05T09:00:00.000Z',
    'updatedAt: 2026-11-05T09:00:00.000Z',
    'sources: []',
    '---',
    '',
    '注文は在庫を確かめてから受ける。',
    '',
].join('\n');

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('dt mcp', () => {
    test('answers initialize, tools/list and tools/call over stdio, and exits when stdin closes', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-mcp-'));
        const state = await mkdtemp(path.join(tmpdir(), 'domaintrail-mcp-state-'));
        dirs.push(root, state);
        await mkdir(path.join(root, 'knowledge'));
        await writeFile(path.join(root, 'sales.dt'), DT);
        await writeFile(path.join(root, 'ordering.dtes'), DTES);
        await writeFile(path.join(root, 'knowledge', 'kn_00000001.md'), ITEM);

        const child = spawn(process.execPath, [BIN, '-r', root, 'mcp'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, DOMAINTRAIL_STATE_DIR: state },
        });
        const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
        const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
        const ask = async (id: number, method: string, params: object = {}): Promise<Record<string, unknown>> => {
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
            const line = await lines.next();
            const message: unknown = JSON.parse(String(line.value));
            expect(message).toMatchObject({ jsonrpc: '2.0', id });
            return message as Record<string, unknown>;
        };

        const init = await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
        expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'domaintrail' }, capabilities: { tools: {} } });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

        const list = await ask(2, 'tools/list');
        expect((list.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(['knowledge_for_element', 'knowledge_search', 'knowledge_get']);

        const call = await ask(3, 'tools/call', { name: 'knowledge_for_element', arguments: { element: 'dt:Sales.Order.place' } });
        const result = call.result as { content: { type: string; text: string }[]; isError?: boolean };
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain('dt:Sales.Order.place is drawn as: Ordering.PlaceOrder "注文する"');
        expect(result.content[0].text).toContain('## kn_00000001 — rule · as_is · agreed (2026-11-05)');
        expect(result.content[0].text).toContain('注文は在庫を確かめてから受ける。');

        child.stdin.end();
        expect(await exited).toBe(0);
        expect((await lines.next()).done).toBe(true);
    });
});
