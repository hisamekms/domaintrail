import { afterAll, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { answererJsonSchema } from '@domaintrail/collaboration';
import { checkCodex, runCodexOnce } from './codex.js';

const fixture = path.join(import.meta.dir, '..', '..', 'test-fixtures', 'fake-codex.mjs');
const dirs: string[] = [];
afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test.skipIf(process.platform === 'win32')('an invalid Codex executable reports safe startup diagnostics and next steps', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-invalid-codex-'));
    dirs.push(dir);
    const file = path.join(dir, 'codex');
    await writeFile(file, 'secret fixture text, never show this');
    await chmod(file, 0o755);
    const result = await checkCodex({ command: file, args: [] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected an unusable CLI');
    expect(result.reason.includes('stage: --version')).toBe(true);
    expect(result.reason.includes('code: ENOEXEC')).toBe(true);
    expect(result.reason.includes(`command: ${JSON.stringify(file)}`)).toBe(true);
    expect(result.reason).toContain(`OS: ${process.platform}`);
    expect(result.reason.includes('command -v codex')).toBe(true);
    expect(result.reason.includes('dt open --agent claude')).toBe(true);
    expect(result.reason.includes('dt open --no-agent')).toBe(true);
    expect(result.reason.includes('secret fixture text')).toBe(false);
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
    expect(invocation.prompt).toContain('Answer this');
    expect(invocation.prompt).toContain("rg -n '^' -- '<relative file path>'");
    expect(invocation.args).toContain('--ignore-user-config');
    expect(invocation.args).toContain('--ignore-rules');
    expect(invocation.args).toContain('--dangerously-bypass-hook-trust');
    expect(invocation.args).toContain('features.hooks=true');
    expect(invocation.args.some((arg) => arg.startsWith('hooks.PreToolUse='))).toBe(true);
    expect(invocation.args.slice(invocation.args.indexOf('--sandbox') + 1)[0]).toBe('read-only');
    expect(invocation.schema.required).toEqual(['kind', 'answer', 'proposal', 'reason']);
});
