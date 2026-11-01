// The agent's settings in `session.agent` of domaintrail.jsonc (composed with the others and read from a file:
// packages/presentation/src/config/config.test.ts; that `dt` lies outside the workspace: ./dt-shim.test.ts).
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
        expect(resolveAgentConfig()).toEqual({ allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(dt fmt:*)', 'Bash(dt check:*)'] });
        expect(resolveAgentConfig().allowedTools).not.toBe(DEFAULT_AGENT_TOOLS);
        expect(resolveAgentConfig({ allowedTools: ['Read'] })).toEqual({ allowedTools: ['Read'] });
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
        [{ dt: ['bun', 'x', 'dt'] }, '\'session.agent.dt\' must be ["node" | "bun" | "deno", "<script>"] or ["<dt executable>"], with no other word'],
    ])('%j is refused', (agent, message) => {
        expect(refusal(agent)).toContain(message);
    });
});
