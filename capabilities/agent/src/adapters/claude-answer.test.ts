// The answerer role's Claude Code (ADR 0030, decision 6), against the fake `claude` of the warm runner's tests
// (`test-fixtures/warm-claude.mjs`): stage 3 with no tools at all and the light model, a fresh process per turn by
// default; answers with the reading tools only, enforced by the process's arguments, one warm process across turns
// (the continued prompt on the next), or a process per turn when not warm; the warm triage process when asked.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { answererJsonSchema, triageJsonSchema } from '@domaintrail/collaboration';
import type { AnswerAgent } from '../core/ports.js';
import { createClaudeAnswerer, type ClaudeAnswererOptions } from './claude-answer.js';
import { CONFIG_EDIT_DENIED, READ_DENIED } from './claude-code.js';

const FAKE = path.join(import.meta.dir, '..', '..', 'test-fixtures', 'warm-claude.mjs');

interface Logged {
    pid: number;
    args: string[];
    prompt: string;
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(steps: Record<string, unknown>[], options: Partial<ClaudeAnswererOptions> = {}): Promise<{ agent: AnswerAgent; logged: () => Logged[] }> {
    const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-answerer-'));
    const plan = path.join(root, '..', `${path.basename(root)}.plan.json`);
    await writeFile(plan, JSON.stringify({ runs: steps }));
    const agent = createClaudeAnswerer({
        root,
        command: { command: process.execPath, args: [FAKE, plan] },
        interruptGraceMs: 300,
        closeGraceMs: 100,
        startTimeoutMs: 2_000,
        ...options,
    });
    cleanups.push(async () => {
        await agent.close?.();
        await rm(root, { recursive: true, force: true });
        await rm(plan, { force: true });
        await rm(`${plan}.log`, { force: true });
    });
    const logged = (): Logged[] =>
        existsSync(`${plan}.log`)
            ? readFileSync(`${plan}.log`, 'utf8')
                  .split('\n')
                  .filter(Boolean)
                  .map((l) => JSON.parse(l) as Logged)
            : [];
    return { agent, logged };
}

const turn = (prompt: string, continuedPrompt?: string) => ({ prompt, ...(continuedPrompt && { continuedPrompt }), signal: new AbortController().signal });
const valueOf = (args: string[], flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

describe("the answerer role's Claude Code", () => {
    test('stage 3: no tool at all, the light model, its own schema, a fresh process per turn', async () => {
        const verdict = { kind: 'consultation', confidence: 0.9, reason: 'a question' };
        const { agent, logged } = await setup([{ reply: verdict }, { reply: verdict }]);
        const first = await agent.triage(turn('t1'));
        await agent.triage(turn('t2'));
        expect(first).toEqual({ text: JSON.stringify(verdict), structured: verdict, model: 'haiku' });
        const [a, b] = logged();
        expect(a.pid).not.toBe(b.pid);
        expect([a.prompt, b.prompt]).toEqual(['t1', 't2']);
        expect(valueOf(a.args, '--tools')).toBe('');
        expect(a.args).not.toContain('--allowedTools');
        expect(a.args).not.toContain('--input-format');
        expect(valueOf(a.args, '--model')).toBe('haiku');
        expect(JSON.parse(valueOf(a.args, '--json-schema') ?? '{}')).toEqual(triageJsonSchema());
        expect(valueOf(a.args, '--permission-mode')).toBe('dontAsk');
        // no settings file: the user's allow rules could let it read anywhere
        expect(valueOf(a.args, '--setting-sources')).toBe('');
    });

    test('answers: Read, Grep and Glob only, by the arguments; one warm process, the continued prompt on its next turn', async () => {
        const answer = { kind: 'answer', answer: 'Order は注文です。' };
        const { agent, logged } = await setup([{ reply: answer }, { reply: answer }], { answer: { model: 'sonnet', effort: 'low' } });
        expect((await agent.answer(turn('a1', 'c1'))).structured).toEqual(answer);
        expect((await agent.answer(turn('a2', 'c2'))).structured).toEqual(answer);
        const [a, b] = logged();
        expect(b.pid).toBe(a.pid);
        expect([a.prompt, b.prompt]).toEqual(['a1', 'c2']);
        expect(valueOf(a.args, '--tools')).toBe('Read,Grep,Glob');
        // no allow rule (a bare Read would allow reading anywhere): reading inside the working directory needs none
        expect(a.args).not.toContain('--allowedTools');
        expect(a.args.slice(a.args.indexOf('--disallowedTools') + 1)).toEqual([...READ_DENIED, ...CONFIG_EDIT_DENIED]);
        expect(READ_DENIED).toContain('Read(**/.git/**)');
        expect(valueOf(a.args, '--setting-sources')).toBe('');
        for (const tool of ['Edit', 'Write', 'Bash', 'MultiEdit', 'NotebookEdit']) expect(valueOf(a.args, '--tools')?.split(',')).not.toContain(tool);
        expect(valueOf(a.args, '--input-format')).toBe('stream-json');
        expect([valueOf(a.args, '--model'), valueOf(a.args, '--effort')]).toEqual(['sonnet', 'low']);
        expect(JSON.parse(valueOf(a.args, '--json-schema') ?? '{}')).toEqual(answererJsonSchema());
    });

    test('what it reads outside the workspace: its views added as working directories, the note appended; never for the triage', async () => {
        const answer = { kind: 'answer', answer: 'ok' };
        const verdict = { kind: 'consultation', confidence: 0.9, reason: 'a question' };
        const extraRead = { dirs: ['/tmp/views/specs', '/tmp/views/notes'], files: [], denied: [], note: 'copies of ../specs and ~/notes/a.md' };
        const { agent, logged } = await setup([{ reply: verdict }, { reply: answer }], { extraRead });
        await agent.triage(turn('t'));
        await agent.answer(turn('a'));
        const [t, a] = logged();
        expect(t.args).not.toContain('--add-dir');
        expect(t.args).not.toContain('--append-system-prompt');
        expect(a.args.filter((_, i) => a.args[i - 1] === '--add-dir')).toEqual(['/tmp/views/specs', '/tmp/views/notes']);
        expect(valueOf(a.args, '--append-system-prompt')).toBe('copies of ../specs and ~/notes/a.md');
        // still no allow rule: reading in a working directory needs none, and nothing of them may be edited
        expect(a.args).not.toContain('--allowedTools');
        expect(a.args).toContain('Edit(//tmp/views/specs/**)');
        expect(valueOf(a.args, '--tools')).toBe('Read,Grep,Glob');
    });

    test('not warm: a process per answer; a warm triage when asked; an error result is an error, the process stays', async () => {
        const answer = { kind: 'neither' };
        const cold = await setup([{ reply: answer }, { reply: answer }], { answer: { warm: false } });
        await cold.agent.answer(turn('a1', 'c1'));
        await cold.agent.answer(turn('a2', 'c2'));
        const [x, y] = cold.logged();
        expect(x.pid).not.toBe(y.pid);
        expect([x.prompt, y.prompt]).toEqual(['a1', 'a2']);

        const verdict = { kind: 'neither', confidence: 0.95, reason: 'thanks' };
        const warm = await setup([{ reply: verdict }, { error: true }, { reply: verdict }], { triage: { warm: true, model: 'claude-haiku-4-5' } });
        expect((await warm.agent.triage(turn('t1'))).structured).toEqual(verdict);
        expect(await warm.agent.triage(turn('t2'))).toMatchObject({ error: 'the turn ended with an error' });
        expect((await warm.agent.triage(turn('t3'))).structured).toEqual(verdict);
        const turns = warm.logged();
        expect(new Set(turns.map((t) => t.pid)).size).toBe(1);
        expect(valueOf(turns[0].args, '--model')).toBe('claude-haiku-4-5');
        expect(valueOf(turns[0].args, '--tools')).toBe('');
    });
});
