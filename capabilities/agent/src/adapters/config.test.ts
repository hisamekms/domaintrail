// The agent's settings in `agent` of domaintrail.jsonc (`run`, `answer`, `triage`) (composed with the others and read from a file:
// apps/dt/src/config/config.test.ts; that `dt` lies outside the workspace: ./dt-shim.test.ts).
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_AGENT_TOOLS, resolveAgentConfig, resolveCommand, resolveReadPath, resolveReadPaths, validateAgentConfig } from './config.js';

const refusal = (agent: Record<string, unknown>): string | undefined => {
    try {
        validateAgentConfig(agent, (msg) => {
            throw new Error(msg);
        });
        return undefined;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
};

const RUN_DEFAULTS = {
    allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(dt fmt:*)', 'Bash(dt check:*)', 'Bash(dt guide:*)'],
    warm: true,
    restartAfter: 20,
    idleTimeout: 30,
};

describe("the agent's settings", () => {
    test('defaults: the runner reads, edits and writes files, dt fmt and dt check, warm; the answerer warm; the triage on haiku, cold', () => {
        expect(resolveAgentConfig()).toEqual({
            run: RUN_DEFAULTS,
            answer: { warm: true, restartAfter: 50, idleTimeout: 30, timeout: 120 },
            triage: { model: 'haiku', warm: false },
            read: { answer: [], run: [] },
        });
        expect(resolveAgentConfig().run.allowedTools).not.toBe(DEFAULT_AGENT_TOOLS);
        expect(resolveAgentConfig({ run: { allowedTools: ['Read'] } }).run.allowedTools).toEqual(['Read']);
    });

    test('the runs: a warm Claude Code by default, replaced after 20 runs, ended after 30 idle minutes; the model and effort only when given', () => {
        expect(refusal({ run: { warm: false, restartAfter: 5, idleTimeout: 10, model: 'opus[1m]', effort: 'xhigh' } })).toBeUndefined();
        expect(resolveAgentConfig({ run: { warm: false, model: 'sonnet' } }).run).toEqual({ ...RUN_DEFAULTS, warm: false, model: 'sonnet' });
        expect(resolveAgentConfig({ run: { restartAfter: 3, effort: 'low' } }).run).toEqual({ ...RUN_DEFAULTS, restartAfter: 3, effort: 'low' });
        // 0: never; a part of a minute is taken
        expect(refusal({ run: { idleTimeout: 0 } })).toBeUndefined();
        expect(resolveAgentConfig({ run: { idleTimeout: 0 } }).run.idleTimeout).toBe(0);
        expect(resolveAgentConfig({ run: { idleTimeout: 1.5 } }).run.idleTimeout).toBe(1.5);
    });

    test("each role's model is its own: an unset one is Claude Code's, never another role's", () => {
        const c = resolveAgentConfig({ run: { model: 'opus' }, answer: { effort: 'low', timeout: 30 }, triage: { warm: true } });
        expect(c.run.model).toBe('opus');
        expect(c.answer).toEqual({ warm: true, restartAfter: 50, idleTimeout: 30, timeout: 30, effort: 'low' });
        expect(c.answer.model).toBeUndefined();
        expect(c.triage).toEqual({ model: 'haiku', warm: true });
        expect(resolveAgentConfig({ answer: { model: 'sonnet', warm: false, restartAfter: 5, idleTimeout: 0 } }).answer).toEqual({
            warm: false,
            restartAfter: 5,
            idleTimeout: 0,
            timeout: 120,
            model: 'sonnet',
        });
        expect(resolveAgentConfig({ triage: { model: 'sonnet' } }).triage.model).toBe('sonnet');
    });

    test("the agent's dt: a runtime and a script relative to the config file, or one executable", () => {
        const dir = path.resolve('/work/project');
        expect(refusal({ run: { dt: ['bun', '../clone/bin/dt.ts'] } })).toBeUndefined();
        expect(resolveAgentConfig({ run: { dt: ['bun', '../clone/bin/dt.ts'] } }, dir).run.dt).toEqual(['bun', path.resolve(dir, '../clone/bin/dt.ts')]);
        expect(resolveAgentConfig({ run: { dt: ['../bin/dt'] } }, dir).run.dt).toEqual([path.resolve(dir, '../bin/dt')]);
        expect(resolveAgentConfig({ run: { dt: ['../bin/dt'] } }).run.dt).toEqual(['../bin/dt']);
        // a runtime given by its path is resolved too
        expect(resolveCommand(['./node', 'dt.js'], dir)).toEqual([path.resolve(dir, 'node'), path.resolve(dir, 'dt.js')]);
    });

    test.each([
        [{ run: { allowedTools: [''] } }, "'agent.run.allowedTools' must be an array of tool rules"],
        [{ run: { dt: [] } }, '\'agent.run.dt\' must be a command as a non-empty array of non-empty strings (e.g. ["node", "../clone/dist/dt.js"])'],
        [{ run: { dt: ['node', ''] } }, "'agent.run.dt' must be a command"],
        [{ run: { dt: 'node dist/dt.js' } }, "'agent.run.dt' must be a command"],
        [
            { run: { dt: ['npx', 'domaintrail'] } },
            '\'agent.run.dt\' must be ["node" | "bun" | "deno", "<script>"] or ["<dt executable>"], with no other word: npx is not one of the runtimes',
        ],
        [{ run: { dt: ['node', '-r'] } }, '-r is an option'],
        [{ run: { dt: ['dt'] } }, 'a dt executable is given by its path'],
        [{ run: true }, "'agent.run' must be an object"],
        [{ run: { warm: 1 } }, "'agent.run.warm' must be true or false"],
        [{ run: { restartAfter: 0 } }, "'agent.run.restartAfter' must be a positive integer (runs)"],
        [{ run: { restartAfter: 2.5 } }, "'agent.run.restartAfter' must be a positive integer"],
        [{ run: { idleTimeout: -1 } }, "'agent.run.idleTimeout' must be a number of minutes, 0 or more (0: never)"],
        [{ run: { idleTimeout: '30m' } }, "'agent.run.idleTimeout' must be a number of minutes"],
        [{ run: { model: '--dangerously-skip-permissions' } }, "'agent.run.model' must be a Claude Code model name or alias"],
        [{ run: { model: 'a b' } }, "'agent.run.model'"],
        [{ run: { effort: 'huge' } }, '\'agent.run.effort\' must be one of "low", "medium", "high", "xhigh", "max"'],
        [{ run: { dt: ['bun', 'x', 'dt'] } }, '\'agent.run.dt\' must be ["node" | "bun" | "deno", "<script>"] or ["<dt executable>"], with no other word'],
        [{ answer: [] }, "'agent.answer' must be an object"],
        [{ answer: { warm: 'yes' } }, "'agent.answer.warm' must be true or false"],
        [{ answer: { restartAfter: 0 } }, "'agent.answer.restartAfter' must be a positive integer (answers)"],
        [{ answer: { idleTimeout: -1 } }, "'agent.answer.idleTimeout' must be a number of minutes"],
        [{ answer: { model: '-x' } }, "'agent.answer.model' must be a Claude Code model name or alias"],
        [{ answer: { effort: 'huge' } }, "'agent.answer.effort' must be one of"],
        [{ answer: { timeout: 0 } }, "'agent.answer.timeout' must be a positive number of seconds"],
        [{ triage: 1 }, "'agent.triage' must be an object"],
        [{ triage: { model: '' } }, "'agent.triage.model' must be a Claude Code model name or alias"],
        [{ triage: { warm: 1 } }, "'agent.triage.warm' must be true or false"],
        [{ read: [] }, "'agent.read' must be an object"],
        [{ read: { paths: '../specs' } }, "'agent.read.paths' must be an array of paths"],
        [{ read: { paths: [''] } }, "'agent.read.paths' must be an array of paths"],
        [{ answer: { read: { paths: ['a\nb'] } } }, "'agent.answer.read.paths' must be an array of paths"],
        [{ run: { read: 1 } }, "'agent.run.read' must be an object"],
    ])('%j is refused', (agent, message) => {
        expect(refusal(agent)).toContain(message);
    });
});

describe('what the AI reads outside the workspace', () => {
    const dir = path.resolve('/work/project');
    test('agent.read.paths for both roles, then each role its own; absolute, ~/… or relative to the config file; each once', () => {
        expect(refusal({ read: { paths: ['../specs'] }, answer: { read: { paths: ['~/notes'] } }, run: { read: {} } })).toBeUndefined();
        const read = resolveReadPaths(
            { read: { paths: ['../specs', '/abs/glossary.md'] }, answer: { read: { paths: ['~/notes', '../specs/'] } }, run: { read: { paths: ['~'] } } },
            dir,
        );
        expect(read).toEqual({
            answer: [path.resolve('/work/specs'), path.resolve('/abs/glossary.md'), path.join(homedir(), 'notes')],
            run: [path.resolve('/work/specs'), path.resolve('/abs/glossary.md'), homedir()],
        });
        expect(resolveAgentConfig({ read: { paths: ['x'] } }, dir).read).toEqual({ answer: [path.join(dir, 'x')], run: [path.join(dir, 'x')] });
        expect(resolveReadPath('~user/x', dir, '/home/me')).toBe(path.join(dir, '~user/x'));
        expect(resolveReadPath('~/x', dir, '/home/me')).toBe(path.resolve('/home/me/x'));
    });
});
