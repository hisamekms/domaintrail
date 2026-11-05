// The extractor role's Claude Code (ADR 0031, section 3), against the fake `claude` of the warm runner's tests: no tool
// at all, the extractor's schema, its instructions appended to the system prompt (the stable part), the talk as the
// prompt, a fresh process per extraction, the model given, and what the turn cost read from its result.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { extractorJsonSchema, gateJsonSchema } from '@domaintrail/knowledge';
import { extractorInstructions, gateInstructions } from '../core/extract-prompt.js';
import { createClaudeExtractor } from './claude-extract.js';

const FAKE = path.join(import.meta.dir, '..', '..', 'test-fixtures', 'warm-claude.mjs');

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const valueOf = (args: string[], flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

describe("the extractor role's Claude Code", () => {
    test('no tool at all, its schema and instructions, a fresh process per extraction, the usage read', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-extractor-'));
        const plan = path.join(root, '..', `${path.basename(root)}.plan.json`);
        const reply = { operations: [] };
        const usage = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 };
        await writeFile(plan, JSON.stringify({ runs: [{ reply, usage, cost: 0.0123 }, { reply }] }));
        cleanups.push(() => Promise.all([rm(root, { recursive: true, force: true }), rm(plan, { force: true }), rm(`${plan}.log`, { force: true })]));
        const agent = createClaudeExtractor({ root, model: 'opus', command: { command: process.execPath, args: [FAKE, plan] } });
        const signal = new AbortController().signal;
        const first = await agent.extract({ prompt: 'the talk', signal });
        await agent.extract({ prompt: 'more talk', signal });
        expect(first).toEqual({
            text: JSON.stringify(reply),
            structured: reply,
            model: 'opus',
            usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 9000, cacheCreationTokens: 0, costUsd: 0.0123 },
        });
        const logged = existsSync(`${plan}.log`)
            ? readFileSync(`${plan}.log`, 'utf8')
                  .split('\n')
                  .filter(Boolean)
                  .map((l) => JSON.parse(l) as { pid: number; args: string[]; prompt: string })
            : [];
        const [a, b] = logged;
        expect(a.pid).not.toBe(b.pid);
        expect([a.prompt, b.prompt]).toEqual(['the talk', 'more talk']);
        expect(valueOf(a.args, '--tools')).toBe('');
        expect(a.args).not.toContain('--allowedTools');
        expect(a.args).not.toContain('--add-dir');
        expect(valueOf(a.args, '--model')).toBe('opus');
        expect(valueOf(a.args, '--setting-sources')).toBe('');
        expect(JSON.parse(valueOf(a.args, '--json-schema') ?? '{}')).toEqual(extractorJsonSchema());
        expect(valueOf(a.args, '--append-system-prompt')).toBe(extractorInstructions());
    });

    test('the light model: no tool at all, its own model (haiku unless given), its schema and instructions, no effort', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-extractor-'));
        const plan = path.join(root, '..', `${path.basename(root)}.plan.json`);
        const verdict = { verdict: 'no', messages: [] };
        await writeFile(plan, JSON.stringify({ runs: [{ reply: verdict }, { reply: verdict }] }));
        cleanups.push(() => Promise.all([rm(root, { recursive: true, force: true }), rm(plan, { force: true }), rm(`${plan}.log`, { force: true })]));
        const command = { command: process.execPath, args: [FAKE, plan] };
        const signal = new AbortController().signal;
        expect(await createClaudeExtractor({ root, model: 'opus', effort: 'high', command }).gate({ prompt: 'the talk', signal })).toMatchObject({
            structured: verdict,
            model: 'haiku',
        });
        await createClaudeExtractor({ root, gateModel: 'claude-haiku-4-5', command }).gate({ prompt: 'the talk', signal });
        const [a, b] = readFileSync(`${plan}.log`, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { args: string[] });
        expect(valueOf(a.args, '--tools')).toBe('');
        expect(valueOf(a.args, '--model')).toBe('haiku');
        expect(a.args).not.toContain('--effort');
        expect(JSON.parse(valueOf(a.args, '--json-schema') ?? '{}')).toEqual(gateJsonSchema());
        expect(valueOf(a.args, '--append-system-prompt')).toBe(gateInstructions());
        expect(valueOf(b.args, '--model')).toBe('claude-haiku-4-5');
    });
});
