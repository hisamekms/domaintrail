// The agent's settings in `session.agent` of domaintrail.jsonc (composed with the others and read from a file:
// apps/dt/src/config/config.test.ts; that `dt` lies outside the workspace: ./dt-shim.test.ts).
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { DEFAULT_AGENT_TOOLS, resolveAgentConfig, resolveCommand, validateAgentConfig } from './config.js';

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

describe("the agent's settings", () => {
    test('defaults: reading, editing and writing files, dt fmt and dt check; the running dt', () => {
        expect(resolveAgentConfig()).toEqual({
            allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(dt fmt:*)', 'Bash(dt check:*)'],
            run: { warm: true, restartAfter: 20, idleTimeout: 30 },
        });
        expect(resolveAgentConfig().allowedTools).not.toBe(DEFAULT_AGENT_TOOLS);
        expect(resolveAgentConfig({ allowedTools: ['Read'] }).allowedTools).toEqual(['Read']);
    });

    test('the runs: a warm Claude Code by default, replaced after 20 runs, ended after 30 idle minutes; the model and effort only when given', () => {
        expect(refusal({ run: { warm: false, restartAfter: 5, idleTimeout: 10, model: 'opus[1m]', effort: 'xhigh' } })).toBeUndefined();
        expect(resolveAgentConfig({ run: { warm: false, model: 'sonnet' } }).run).toEqual({ warm: false, restartAfter: 20, idleTimeout: 30, model: 'sonnet' });
        expect(resolveAgentConfig({ run: { restartAfter: 3, effort: 'low' } }).run).toEqual({ warm: true, restartAfter: 3, idleTimeout: 30, effort: 'low' });
        // 0: never; a part of a minute is taken
        expect(refusal({ run: { idleTimeout: 0 } })).toBeUndefined();
        expect(resolveAgentConfig({ run: { idleTimeout: 0 } }).run.idleTimeout).toBe(0);
        expect(resolveAgentConfig({ run: { idleTimeout: 1.5 } }).run.idleTimeout).toBe(1.5);
    });

    test("the agent's dt: a runtime and a script relative to the config file, or one executable", () => {
        const dir = path.resolve('/work/project');
        expect(refusal({ dt: ['bun', '../clone/bin/dt.ts'] })).toBeUndefined();
        expect(resolveAgentConfig({ dt: ['bun', '../clone/bin/dt.ts'] }, dir).dt).toEqual(['bun', path.resolve(dir, '../clone/bin/dt.ts')]);
        expect(resolveAgentConfig({ dt: ['../bin/dt'] }, dir).dt).toEqual([path.resolve(dir, '../bin/dt')]);
        expect(resolveAgentConfig({ dt: ['../bin/dt'] }).dt).toEqual(['../bin/dt']);
        // a runtime given by its path is resolved too
        expect(resolveCommand(['./node', 'dt.js'], dir)).toEqual([path.resolve(dir, 'node'), path.resolve(dir, 'dt.js')]);
    });

    test.each([
        [{ allowedTools: [''] }, "'session.agent.allowedTools' must be an array of tool rules"],
        [{ dt: [] }, '\'session.agent.dt\' must be a command as a non-empty array of non-empty strings (e.g. ["node", "../clone/dist/dt.js"])'],
        [{ dt: ['node', ''] }, "'session.agent.dt' must be a command"],
        [{ dt: 'node dist/dt.js' }, "'session.agent.dt' must be a command"],
        [
            { dt: ['npx', 'domaintrail'] },
            '\'session.agent.dt\' must be ["node" | "bun" | "deno", "<script>"] or ["<dt executable>"], with no other word: npx is not one of the runtimes',
        ],
        [{ dt: ['node', '-r'] }, '-r is an option'],
        [{ dt: ['dt'] }, 'a dt executable is given by its path'],
        [{ run: true }, "'session.agent.run' must be an object"],
        [{ run: { hot: true } }, "unknown key 'session.agent.run.hot'"],
        [{ run: { warm: 1 } }, "'session.agent.run.warm' must be true or false"],
        [{ run: { restartAfter: 0 } }, "'session.agent.run.restartAfter' must be a positive integer (runs)"],
        [{ run: { restartAfter: 2.5 } }, "'session.agent.run.restartAfter' must be a positive integer"],
        [{ run: { idleTimeout: -1 } }, "'session.agent.run.idleTimeout' must be a number of minutes, 0 or more (0: never)"],
        [{ run: { idleTimeout: '30m' } }, "'session.agent.run.idleTimeout' must be a number of minutes"],
        [{ run: { model: '--dangerously-skip-permissions' } }, "'session.agent.run.model' must be a Claude Code model name or alias"],
        [{ run: { model: 'a b' } }, "'session.agent.run.model'"],
        [{ run: { effort: 'huge' } }, '\'session.agent.run.effort\' must be one of "low", "medium", "high", "xhigh", "max"'],
        [{ dt: ['bun', 'x', 'dt'] }, '\'session.agent.dt\' must be ["node" | "bun" | "deno", "<script>"] or ["<dt executable>"], with no other word'],
    ])('%j is refused', (agent, message) => {
        expect(refusal(agent)).toContain(message);
    });
});
