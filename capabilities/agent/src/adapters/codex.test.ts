import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { answererJsonSchema } from '@domaintrail/collaboration';
import { checkCodex, runCodexOnce } from './codex.js';

const fixture = path.join(import.meta.dir, '..', '..', 'test-fixtures', 'fake-codex.mjs');
const dirs: string[] = [];
afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test('Codex CLI is detected and a read-only turn uses a strict schema and isolated settings', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dt-codex-test-'));
    dirs.push(dir);
    const log = path.join(dir, 'invocation.json');
    const command = { command: process.execPath, args: [fixture, log] };
    expect(await checkCodex(command)).toEqual({ ok: true, version: '0.test' });
    const result = await runCodexOnce({
        root: dir,
        prompt: 'Answer this',
        schema: answererJsonSchema(),
        signal: new AbortController().signal,
        sandbox: 'read-only',
        hookRole: 'read',
        command,
    });
    expect(result).toMatchObject({ exitCode: 0, structured: { kind: 'answer', answer: 'Codex answered' } });
    const invocation = JSON.parse(await readFile(log, 'utf8')) as { args: string[]; prompt: string; schema: { required: string[] } };
    expect(invocation.prompt).toBe('Answer this');
    expect(invocation.args).toContain('--ignore-user-config');
    expect(invocation.args).toContain('--ignore-rules');
    expect(invocation.args).toContain('--dangerously-bypass-hook-trust');
    expect(invocation.args).toContain('features.hooks=true');
    expect(invocation.args.some((arg) => arg.startsWith('hooks.PreToolUse='))).toBe(true);
    expect(invocation.args.slice(invocation.args.indexOf('--sandbox') + 1)[0]).toBe('read-only');
    expect(invocation.schema.required).toEqual(['kind', 'answer', 'proposal', 'reason']);
});
