// Cold Codex CLI turns for the runner, answerer, and extractor. Each turn receives dt's schema and prompt;
// the CLI starts without user configuration or rules, treats the project as untrusted, and disables apps and search.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { answererJsonSchema, commandJsonSchema, interviewerJsonSchema, replyJsonSchema, triageJsonSchema, type RunActivity } from '@domaintrail/collaboration';
import { extractorJsonSchema, gateJsonSchema, hotspotNameJsonSchema } from '@domaintrail/knowledge';
import type { AgentInvocation, AgentOutcome, AgentRunner, AnswerAgent, AnswerTurn, AnswerTurnResult, ExtractAgent, ExtractTurn } from '../core/ports.js';
import { parseReply } from '../core/prompt.js';
import { extractorInstructions, gateInstructions, hotspotNameInstructions } from '../core/extract-prompt.js';
import { type AgentCommand, KILL_GRACE_MS, killTree, type ExtraRead, type KnowledgeMcp } from './claude-code.js';
import { dtCommandOf, fingerprintDt, pinDt, withPathFirst, writeDtShim, type PinnedDt } from './dt-shim.js';
import { createCodexHook, type CodexHookRole } from './codex-hook.js';

export const CODEX: AgentCommand = { command: 'codex', args: [] };
const MAX_OUTPUT = 8 * 1024 * 1024;

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Codex's JSONL events, reduced to the same safe phases the Live View shows for Claude. */
export function codexActivity(event: Record<string, unknown>): RunActivity | undefined {
    if (event.type === 'turn.completed') return { phase: 'finishing' };
    if (event.type !== 'item.started' && event.type !== 'item.completed') return undefined;
    const item = event.item;
    if (!record(item)) return undefined;
    if (item.type === 'file_change') return { phase: 'editing' };
    if (item.type !== 'command_execution' || typeof item.command !== 'string') return undefined;
    if (/^dt (check|fmt)(?:\s|$)/.test(item.command)) return { phase: 'checking', subject: item.command.startsWith('dt check') ? 'dt check' : 'dt fmt' };
    return { phase: 'reading' };
}

/** Structured output requires all object properties, including the optional ones. */
export function codexSchema(schema: Record<string, unknown>): Record<string, unknown> {
    if (schema.type === 'object' && record(schema.properties)) {
        const required = new Set(Array.isArray(schema.required) ? schema.required : []);
        return {
            type: 'object',
            properties: Object.fromEntries(
                Object.entries(schema.properties).map(([key, value]) => {
                    const child = codexSchema(record(value) ? value : {});
                    return [key, required.has(key) ? child : { anyOf: [child, { type: 'null' }] }];
                }),
            ),
            required: Object.keys(schema.properties),
            additionalProperties: false,
        };
    }
    if (schema.type === 'array') return { type: 'array', items: codexSchema(record(schema.items) ? schema.items : {}) };
    if (Array.isArray(schema.anyOf)) return { anyOf: schema.anyOf.map((item: unknown) => codexSchema(record(item) ? item : {})) };
    if ('const' in schema) return { type: typeof schema.const, enum: [schema.const] };
    // The model's strict schema accepts a smaller subset than the shared validator. Validation still runs after output.
    return Object.fromEntries(Object.entries(schema).filter(([key]) => ['type', 'enum'].includes(key)));
}

/** Shared readers treat optional fields as absent; Codex's strict schema represents them as null. */
export function withoutCodexNulls(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutCodexNulls);
    if (record(value))
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, child]) => child !== null)
                .map(([key, child]) => [key, withoutCodexNulls(child)]),
        );
    return value;
}

export interface CodexTurnOptions {
    root: string;
    prompt: string;
    schema: Record<string, unknown>;
    signal: AbortSignal;
    sandbox: 'read-only' | 'workspace-write';
    hookRole: CodexHookRole;
    command?: AgentCommand;
    model?: string;
    effort?: string;
    dt?: PinnedDt;
    knowledge?: KnowledgeMcp;
    extraRead?: ExtraRead;
    onEvent?: (event: Record<string, unknown>) => void;
}

/** One Codex turn. No shell wraps the prompt, CLI arguments, or model output. */
export async function runCodexOnce(options: CodexTurnOptions): Promise<AnswerTurnResult & { exitCode: number }> {
    if (options.signal.aborted) return { text: '', error: 'stopped', exitCode: -1 };
    const dir = await mkdtemp(path.join(tmpdir(), 'dt-codex-'));
    let shim: Awaited<ReturnType<typeof writeDtShim>> | undefined;
    let hook: Awaited<ReturnType<typeof createCodexHook>> | undefined;
    try {
        hook = await createCodexHook(options.root, options.hookRole, options.extraRead?.dirs);
        const schemaFile = path.join(dir, 'schema.json');
        const outputFile = path.join(dir, 'answer.json');
        await writeFile(schemaFile, JSON.stringify(codexSchema(options.schema)), { mode: 0o600 });
        if (options.dt) shim = await writeDtShim(options.dt, options.root);
        const args = [
            ...(options.command?.args ?? []),
            '-c',
            'approval_policy="never"',
            '-c',
            `projects.${JSON.stringify(options.root)}.trust_level="untrusted"`,
            '-c',
            'web_search="disabled"',
            '-c',
            'features.apps=false',
            '-c',
            'features.plugins=false',
            '-c',
            'features.browser_use=false',
            '-c',
            'features.hooks=true',
            '-c',
            hook.config,
            ...(options.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(options.effort)}`] : []),
            ...(options.knowledge
                ? [
                      '-c',
                      `mcp_servers.domaintrail.command=${JSON.stringify(options.knowledge.command)}`,
                      '-c',
                      `mcp_servers.domaintrail.args=${JSON.stringify(options.knowledge.args)}`,
                      '-c',
                      'mcp_servers.domaintrail.enabled_tools=["knowledge_for_element","knowledge_search","knowledge_get"]',
                  ]
                : ['-c', 'mcp_servers={}']),
            'exec',
            '--skip-git-repo-check',
            '--ephemeral',
            '--ignore-user-config',
            '--ignore-rules',
            '--dangerously-bypass-hook-trust',
            '--sandbox',
            options.sandbox,
            '--output-schema',
            schemaFile,
            '--output-last-message',
            outputFile,
            '--json',
            ...(options.model ? ['--model', options.model] : []),
            '-',
        ];
        const command = options.command ?? CODEX;
        const env = shim ? withPathFirst(process.env, shim.dir) : process.env;
        const exitCode = await new Promise<number>((resolve, reject) => {
            const child = spawn(command.command, args, {
                cwd: options.root,
                env,
                shell: false,
                detached: process.platform !== 'win32',
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
            let buffered = '';
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
                buffered += chunk;
                if (buffered.length > MAX_OUTPUT) buffered = buffered.slice(-MAX_OUTPUT);
                let end: number;
                while ((end = buffered.indexOf('\n')) !== -1) {
                    const line = buffered.slice(0, end);
                    buffered = buffered.slice(end + 1);
                    try {
                        const event: unknown = JSON.parse(line);
                        if (record(event)) options.onEvent?.(event);
                    } catch {
                        /* discard malformed progress */
                    }
                }
            });
            child.stderr.resume(); // may contain prompt or model output
            child.stdin.on('error', (e: Error & { code?: string }) => {
                if (e.code !== 'EPIPE') reject(e);
            });
            let killer: ReturnType<typeof setTimeout> | undefined;
            const stop = (): void => {
                killTree(child.pid, 'SIGTERM');
                killer = setTimeout(() => killTree(child.pid, 'SIGKILL'), KILL_GRACE_MS);
                killer.unref();
            };
            options.signal.addEventListener('abort', stop, { once: true });
            child.once('error', reject);
            child.once('close', (code) => {
                options.signal.removeEventListener('abort', stop);
                if (killer) clearTimeout(killer);
                resolve(code ?? -1);
            });
            child.stdin.end(options.extraRead?.note
                ? `${options.prompt}\n\n${options.extraRead.note}\nUse rg --files --hidden '<copy directory>' to list a copy, and rg -n '^' -- '<copy file>' to read one file. These copies are read-only.`
                : options.prompt);
        });
        if (options.signal.aborted) return { text: '', error: 'stopped', exitCode: -1 };
        const text = await readFile(outputFile, 'utf8').catch(() => '');
        let structured: unknown;
        try {
            structured = withoutCodexNulls(JSON.parse(text));
        } catch {
            /* caller validates absence */
        }
        return {
            text,
            ...(structured !== undefined && { structured }),
            ...(options.model && { model: options.model }),
            ...(exitCode !== 0 && { error: `codex exited with ${exitCode}` }),
            exitCode,
        };
    } finally {
        await shim?.dispose();
        await hook?.dispose();
        await rm(dir, { recursive: true, force: true });
    }
}

export async function checkCodex(command: AgentCommand = CODEX, timeoutMs = 5_000): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
    const probe = (args: string[]): Promise<{ code: number; text: string }> =>
        new Promise((resolve, reject) => {
            const child = spawn(command.command, [...command.args, ...args], { stdio: ['ignore', 'pipe', 'ignore'], shell: false, windowsHide: true });
            let text = '';
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (part: string) => {
                if (text.length < 100_000) text += part;
            });
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error(`did not answer in ${timeoutMs / 1000} seconds`));
            }, timeoutMs);
            child.once('error', (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.once('close', (code) => {
                clearTimeout(timer);
                resolve({ code: code ?? -1, text });
            });
        });
    try {
        const version = await probe(['--version']);
        const help = await probe(['exec', '--help']);
        const needed = ['--output-schema', '--output-last-message', '--ignore-user-config', '--ignore-rules', '--dangerously-bypass-hook-trust', '--sandbox', '--json'];
        if (version.code !== 0 || help.code !== 0 || needed.some((flag) => !help.text.includes(flag)))
            return { ok: false, reason: 'codex CLI lacks the flags required by dt' };
        return { ok: true, version: version.text.trim().replace(/^codex-cli\s+/, '') };
    } catch (e) {
        return { ok: false, reason: `codex ${e instanceof Error ? e.message : String(e)}` };
    }
}

export async function createCodexRunner(options: {
    root: string;
    prepare?: () => Promise<void>;
    extraRead?: ExtraRead;
    command?: AgentCommand;
    dt: PinnedDt;
    model?: string;
    effort?: string;
    knowledge?: KnowledgeMcp;
}): Promise<AgentRunner> {
    const pinned = pinDt(dtCommandOf(options.dt), options.root);
    const fingerprint = await fingerprintDt(pinned);
    return {
        async run(invocation: AgentInvocation): Promise<AgentOutcome> {
            await options.prepare?.();
            if ((await fingerprintDt(pinDt(dtCommandOf(pinned), options.root))) !== fingerprint)
                throw new Error("A file of the agent's dt changed since it started: refusing to run it.");
            const result = await runCodexOnce({
                root: options.root,
                prompt: invocation.prompt,
                schema: replyJsonSchema(invocation.requests),
                signal: invocation.signal,
                sandbox: 'workspace-write',
                hookRole: 'run',
                dt: pinned,
                ...(options.command && { command: options.command }),
                ...(options.model && { model: options.model }),
                ...(options.effort && { effort: options.effort }),
                ...(options.knowledge && { knowledge: options.knowledge }),
                ...(options.extraRead && { extraRead: options.extraRead }),
                onEvent: (event) => {
                    const activity = codexActivity(event);
                    if (activity) invocation.onActivity?.(activity);
                },
            });
            return { exitCode: result.exitCode, ...parseReply(result.structured, result.text, invocation.requests) };
        },
    };
}

export function createCodexAnswerer(options: {
    root: string;
    prepare?: () => Promise<void>;
    extraRead?: ExtraRead;
    command?: AgentCommand;
    model?: string;
    effort?: string;
    triageModel?: string;
    knowledge?: KnowledgeMcp;
}): AnswerAgent {
    const turn = async (request: AnswerTurn, schema: Record<string, unknown>, role: CodexHookRole, model?: string, knowledge?: KnowledgeMcp): Promise<AnswerTurnResult> => {
        try {
            await options.prepare?.();
            return await runCodexOnce({
                root: options.root,
                prompt: request.prompt,
                schema,
                signal: request.signal,
                sandbox: 'read-only',
                hookRole: role,
                ...(options.command && { command: options.command }),
                ...(model && { model }),
                ...(options.effort && { effort: options.effort }),
                ...(knowledge && { knowledge }),
                ...(role === 'read' && options.extraRead && { extraRead: options.extraRead }),
            });
        } catch (e) {
            return { text: '', error: e instanceof Error ? e.message : String(e) };
        }
    };
    return {
        triage: (request) => turn(request, triageJsonSchema(), 'none', options.triageModel),
        answer: (request) => turn(request, answererJsonSchema(), 'read', options.model, options.knowledge),
        interview: (request) => turn(request, interviewerJsonSchema(), 'read', options.model),
        command: (request) => turn(request, commandJsonSchema(request.type), 'read', options.model),
    };
}

export function createCodexExtractor(options: { root: string; command?: AgentCommand; model?: string; effort?: string; gateModel?: string }): ExtractAgent {
    const turn = async (request: ExtractTurn, schema: Record<string, unknown>, instructions: string, model?: string): Promise<AnswerTurnResult> => {
        try {
            return await runCodexOnce({
                root: options.root,
                prompt: `${instructions}\n${request.context ?? ''}\n${request.prompt}`,
                schema,
                signal: request.signal,
                sandbox: 'read-only',
                hookRole: 'none',
                ...(options.command && { command: options.command }),
                ...(model && { model }),
                ...(options.effort && { effort: options.effort }),
            });
        } catch (e) {
            return { text: '', error: e instanceof Error ? e.message : String(e) };
        }
    };
    return {
        extract: (request) => turn(request, extractorJsonSchema(), extractorInstructions(), options.model),
        gate: (request) => turn(request, gateJsonSchema(), gateInstructions(), options.gateModel),
        hotspotName: (request) => turn(request, hotspotNameJsonSchema(), hotspotNameInstructions(), options.gateModel),
    };
}
