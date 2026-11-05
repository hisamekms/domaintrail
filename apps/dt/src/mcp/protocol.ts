// A Model Context Protocol server over stdio, as small as `dt mcp` needs (ADR 0031, section 9): tools only, no
// resources, prompts, sampling or notifications of its own. The transport is MCP's stdio: one JSON-RPC 2.0 message per
// line on stdin and stdout (nothing else may be written to stdout; logs go to stderr).
//
// Written here rather than taken from `@modelcontextprotocol/sdk`: the SDK's runtime dependencies (express, hono, jose,
// cors, ajv, zod, …, for its HTTP transports and OAuth) would be installed with every `domaintrail`, whose CLI keeps
// its few dependencies external and pinned (scripts/build.ts), for a read-only server of three tools over stdio. What
// is used of the protocol — `initialize`, `ping`, `tools/list`, `tools/call` — is stable across its versions.
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** The protocol versions this server speaks: the client's, when it is one of them; else the newest. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** A tool as `tools/list` describes it. */
export interface McpToolDefinition {
    readonly name: string;
    readonly title?: string;
    readonly description: string;
    /** A JSON Schema of an object. */
    readonly inputSchema: Readonly<Record<string, unknown>>;
    readonly annotations?: Readonly<Record<string, unknown>>;
}

/** What a tool call returns: text, or text that is an error of the tool (`isError`), shown to the model as such. */
export interface McpToolResult {
    readonly text: string;
    readonly isError?: boolean;
}

export interface McpTool extends McpToolDefinition {
    /** Runs the call; a rejection is turned into an error of the tool with its message. */
    call(args: Readonly<Record<string, unknown>>): Promise<McpToolResult>;
}

export interface McpServerOptions {
    readonly name: string;
    readonly version: string;
    /** What the client may tell the model about the server (`instructions` of `initialize`). */
    readonly instructions?: string;
    readonly tools: readonly McpTool[];
    readonly input: Readable;
    readonly output: Writable;
    /** Where problems are said (stderr). */
    readonly log?: (line: string) => void;
}

type Id = string | number | null;

interface JsonRpcError {
    readonly code: number;
    readonly message: string;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The answer to one message: a response, or nothing for a notification. */
async function answer(message: unknown, options: McpServerOptions): Promise<Record<string, unknown> | undefined> {
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        // a response from the client (this server sends no requests) or garbage: an error only when it has an id
        const id = isObject(message) && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null;
        if (isObject(message) && !('method' in message) && ('result' in message || 'error' in message)) return undefined;
        return failure(id, { code: INVALID_REQUEST, message: 'Invalid request' });
    }
    if (!('id' in message)) return undefined; // a notification: initialized, cancelled, …
    const id = message.id;
    if (typeof id !== 'string' && typeof id !== 'number') return failure(null, { code: INVALID_REQUEST, message: 'Invalid request id' });
    const params = isObject(message.params) ? message.params : {};
    const handled = await handle(message.method, params, options);
    return 'error' in handled ? failure(id, handled.error) : { jsonrpc: '2.0', id, result: handled.result };
}

const failure = (id: Id, error: JsonRpcError): Record<string, unknown> => ({ jsonrpc: '2.0', id, error });

type Handled = { readonly result: Record<string, unknown> } | { readonly error: JsonRpcError };

async function handle(method: string, params: Record<string, unknown>, options: McpServerOptions): Promise<Handled> {
    switch (method) {
        case 'initialize': {
            const asked = params.protocolVersion;
            const protocolVersion = (PROTOCOL_VERSIONS as readonly unknown[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
            return {
                result: {
                    protocolVersion,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: options.name, version: options.version },
                    ...(options.instructions !== undefined && { instructions: options.instructions }),
                },
            };
        }
        case 'ping':
            return { result: {} };
        case 'tools/list':
            return { result: { tools: options.tools.map(({ call: _, ...definition }) => definition) } };
        case 'tools/call': {
            const tool = options.tools.find((t) => t.name === params.name);
            if (!tool) return { error: { code: INVALID_PARAMS, message: `Unknown tool: ${String(params.name)}` } };
            const args = isObject(params.arguments) ? params.arguments : {};
            const done = await tool.call(args).catch(
                (e: unknown): McpToolResult => ({ text: `${tool.name} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }),
            );
            return { result: { content: [{ type: 'text', text: done.text }], ...(done.isError && { isError: true }) } };
        }
        default:
            return { error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } };
    }
}

/**
 * Serves `options.tools` on `input` and `output` until `input` ends. Requests are answered in the order they came
 * (a tool call is quick: it reads files or the store).
 */
export async function serveMcp(options: McpServerOptions): Promise<void> {
    const write = (message: unknown): Promise<void> =>
        new Promise<void>((resolve, reject) => void options.output.write(`${JSON.stringify(message)}\n`, (e) => (e ? reject(e) : resolve())));
    const lines = createInterface({ input: options.input, crlfDelay: Infinity });
    for await (const line of lines) {
        if (line.trim() === '') continue;
        let message: unknown;
        try {
            message = JSON.parse(line);
        } catch {
            await write(failure(null, { code: PARSE_ERROR, message: 'Parse error' }));
            continue;
        }
        try {
            if (Array.isArray(message)) {
                // a batch (protocol 2025-03-26): the responses together, none when all were notifications
                const responses = (await Promise.all(message.map((m) => answer(m, options)))).filter((r) => r !== undefined);
                if (responses.length > 0) await write(responses);
            } else {
                const response = await answer(message, options);
                if (response) await write(response);
            }
        } catch (e) {
            options.log?.(`dt mcp: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}
