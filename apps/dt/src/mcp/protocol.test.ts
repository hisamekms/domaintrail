// The MCP server over a pair of streams: one JSON-RPC message per line in, one per line out.
import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { PROTOCOL_VERSIONS, serveMcp, type McpTool } from './protocol.js';

const echo: McpTool = {
    name: 'echo',
    description: 'Says what it is given.',
    inputSchema: { type: 'object', properties: { say: { type: 'string' } } },
    call: async (args) =>
        args.say === 'boom' ? Promise.reject(new Error('it broke')) : { text: String(args.say), ...(args.say === 'no' && { isError: true }) },
};

/** Sends `lines` to a server and returns what it wrote, one parsed message per line, once the input ended. */
async function exchange(lines: readonly (string | object)[]): Promise<unknown[]> {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on('data', (chunk: Buffer) => written.push(chunk.toString()));
    const served = serveMcp({ name: 'domaintrail', version: '9.9.9', instructions: 'Read it.', tools: [echo], input, output });
    for (const l of lines) input.write(`${typeof l === 'string' ? l : JSON.stringify(l)}\n`);
    input.end();
    await served;
    return written
        .join('')
        .split('\n')
        .filter((l) => l !== '')
        .map((l): unknown => JSON.parse(l));
}

const request = (id: number, method: string, params?: object): object => ({ jsonrpc: '2.0', id, method, ...(params && { params }) });

describe('serveMcp', () => {
    test('initialize: the client protocol version when known, else the newest; the tools capability and the instructions', async () => {
        const [known, unknown] = await exchange([
            request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } }),
            request(2, 'initialize', { protocolVersion: '1999-01-01' }),
        ]);
        expect(known).toEqual({
            jsonrpc: '2.0',
            id: 1,
            result: {
                protocolVersion: '2025-06-18',
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'domaintrail', version: '9.9.9' },
                instructions: 'Read it.',
            },
        });
        expect(unknown).toMatchObject({ id: 2, result: { protocolVersion: PROTOCOL_VERSIONS[0] } });
    });

    test('notifications get no answer; ping, tools/list and tools/call do', async () => {
        const out = await exchange([
            { jsonrpc: '2.0', method: 'notifications/initialized' },
            request(1, 'ping'),
            request(2, 'tools/list'),
            request(3, 'tools/call', { name: 'echo', arguments: { say: 'hi' } }),
        ]);
        expect(out).toEqual([
            { jsonrpc: '2.0', id: 1, result: {} },
            { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'echo', description: 'Says what it is given.', inputSchema: echo.inputSchema }] } },
            { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'hi' }] } },
        ]);
    });

    test('an error of a tool and a failing tool are tool results with isError; an unknown tool or method a JSON-RPC error', async () => {
        const out = await exchange([
            request(1, 'tools/call', { name: 'echo', arguments: { say: 'no' } }),
            request(2, 'tools/call', { name: 'echo', arguments: { say: 'boom' } }),
            request(3, 'tools/call', { name: 'nope' }),
            request(4, 'resources/list'),
        ]);
        expect(out).toEqual([
            { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'no' }], isError: true } },
            { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'echo failed: it broke' }], isError: true } },
            { jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'Unknown tool: nope' } },
            { jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'Method not found: resources/list' } },
        ]);
    });

    test('a line that is not JSON, and a message that is no request, are errors; a batch is answered together', async () => {
        const out = await exchange(['{not json', { id: 7, method: 'ping' }, [request(1, 'ping'), { jsonrpc: '2.0', method: 'notifications/cancelled' }]]);
        expect(out).toEqual([
            { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
            { jsonrpc: '2.0', id: 7, error: { code: -32600, message: 'Invalid request' } },
            [{ jsonrpc: '2.0', id: 1, result: {} }],
        ]);
    });
});
