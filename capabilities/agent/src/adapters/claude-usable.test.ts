// Whether Claude Code is usable as the agent, against fake `claude` programs (a node script per behaviour).
import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { checkClaudeCode, NEEDED_FLAGS } from './claude-usable.js';

const dirs: string[] = [];
afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** A fake `claude`: `--version` and `--help` print what is given, or it hangs / fails. */
async function fake(script: string): Promise<{ command: string; args: string[] }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-usable-'));
    dirs.push(dir);
    const file = path.join(dir, 'claude.mjs');
    await writeFile(file, script);
    return { command: process.execPath, args: [file] };
}

const HELP = `Usage: claude [options]\n${NEEDED_FLAGS.map((f) => `  ${f}`).join('\n')}\n`;

describe('whether Claude Code is usable', () => {
    test.skipIf(process.platform === 'win32')('an invalid executable explains ENOEXEC without exposing its output', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-invalid-claude-'));
        dirs.push(dir);
        const file = path.join(dir, 'claude');
        await writeFile(file, 'secret fixture text, never show this');
        await chmod(file, 0o755);
        const result = await checkClaudeCode({ command: file, args: [] });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('Expected an unusable CLI');
        expect(result.reason.includes('stage: --version')).toBe(true);
        expect(result.reason.includes('code: ENOEXEC')).toBe(true);
        expect(result.reason.includes(`command: ${JSON.stringify(file)}`)).toBe(true);
        expect(result.reason).toContain(`OS: ${process.platform}`);
        expect(result.reason.includes('command -v claude')).toBe(true);
        expect(result.reason.includes('dt open --agent codex')).toBe(true);
        expect(result.reason.includes('dt open --no-agent')).toBe(true);
        expect(result.reason.includes('secret fixture text')).toBe(false);
    });

    test('usable: its version', async () => {
        const command = await fake(`process.stdout.write(process.argv[2] === '--version' ? '2.1.316 (Claude Code)\\n' : ${JSON.stringify(HELP)});`);
        expect(await checkClaudeCode(command)).toEqual({ ok: true, version: '2.1.316 (Claude Code)' });
    });

    test('not found, hanging, failing, or without a flag the adapters need', async () => {
        expect(await checkClaudeCode({ command: path.join(tmpdir(), 'no-such-claude-here'), args: [] })).toEqual({
            ok: false,
            reason: `${path.join(tmpdir(), 'no-such-claude-here')} not found on PATH`,
        });
        const hangs = await fake('setInterval(() => {}, 1000);');
        expect(await checkClaudeCode(hangs, 300)).toMatchObject({ ok: false, reason: expect.stringContaining('did not answer within 0.3 s') });
        const fails = await fake('process.exit(2);');
        expect(await checkClaudeCode(fails)).toMatchObject({ ok: false, reason: expect.stringContaining('exited with 2') });
        const old = await fake(`process.stdout.write(process.argv[2] === '--version' ? '1.0.0\\n' : ${JSON.stringify(HELP.replace('--input-format', ''))});`);
        expect(await checkClaudeCode(old)).toMatchObject({ ok: false, reason: expect.stringContaining('does not know --input-format') });
    });
});
