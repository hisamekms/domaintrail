import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createClaudeCodeRunner } from '@domaintrail/agent/infrastructure/claude-code';
import { dtShim, withPathFirst, writeDtShim } from '@domaintrail/agent/infrastructure/dt-shim';

const dirs: string[] = [];
afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
const gone = (p: string): Promise<boolean> =>
    stat(p).then(
        () => false,
        () => true,
    );
const scratch = async (): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-agent-dt-'));
    dirs.push(dir);
    return dir;
};

describe("the agent's dt (session.agent.dt)", () => {
    test('a sh script that execs the command with every word quoted, then the arguments it is given', () => {
        expect(dtShim({ command: '/usr/bin/node', args: ["/my clone/it's/dt.js"] }, 'darwin')).toEqual({
            file: 'dt',
            text: `#!/bin/sh\nexec '/usr/bin/node' '/my clone/it'\\''s/dt.js' "$@"\n`,
        });
        expect(dtShim({ command: 'C:\\node.exe', args: ['C:\\dt\\dt.js'] }, 'win32')).toEqual({
            file: 'dt.cmd',
            text: '@echo off\r\n"C:\\node.exe" "C:\\dt\\dt.js" %*\r\n',
        });
        expect(() => dtShim({ command: 'node', args: ['a\nb'] }, 'linux')).toThrow();
    });

    test('first on the PATH, keeping the rest', () => {
        expect(withPathFirst({ PATH: `/usr/bin${path.delimiter}/bin`, HOME: '/h' }, '/shim')).toEqual({
            PATH: `/shim${path.delimiter}/usr/bin${path.delimiter}/bin`,
            HOME: '/h',
        });
        expect(withPathFirst({ Path: 'C:\\bin' }, 'D:\\shim')).toEqual({ Path: `D:\\shim${path.delimiter}C:\\bin` });
        expect(withPathFirst({}, '/shim')).toEqual({ PATH: '/shim' });
    });

    test.skipIf(process.platform === 'win32')('`dt …` on that PATH runs the configured command with the arguments', async () => {
        const dir = await scratch();
        const echo = path.join(dir, 'echo dt.mjs');
        await writeFile(echo, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
        const shim = await writeDtShim({ command: 'node', args: [echo] });
        try {
            expect((await stat(path.join(shim.dir, 'dt'))).mode & 0o777).toBe(0o700);
            const out = spawnSync('dt', ['check', 'a b'], { env: withPathFirst(process.env, shim.dir), encoding: 'utf8' });
            expect(JSON.parse(out.stdout)).toEqual(['check', 'a b']);
        } finally {
            await shim.dispose();
        }
        expect(await gone(shim.dir)).toBe(true);
    });

    test.skipIf(process.platform === 'win32')('the agent runs `dt` from its PATH: the shim, removed once the run ends', async () => {
        const root = await scratch();
        const echo = path.join(root, 'echo.mjs');
        await writeFile(echo, "console.log('dt ' + process.argv.slice(2).join(' '));\n");
        // a fake agent: runs `dt fmt` as the prompt allows, and writes what it printed into the workspace
        const agent = path.join(root, 'agent.mjs');
        await writeFile(
            agent,
            [
                "import { execFileSync } from 'node:child_process';",
                "import { writeFileSync } from 'node:fs';",
                "const out = execFileSync('dt', ['fmt'], { encoding: 'utf8' });",
                "writeFileSync('ran.txt', out + process.env.PATH.split(':')[0]);",
                "console.log(JSON.stringify({ type: 'result', result: 'ok' }));",
            ].join('\n'),
        );
        const runner = createClaudeCodeRunner({ root, command: { command: 'node', args: [agent] }, dt: { command: 'node', args: [echo] } });
        const outcome = await runner.run({ prompt: 'p', allowedTools: ['Bash(dt fmt:*)'], requests: 1, signal: new AbortController().signal });
        expect(outcome.exitCode).toBe(0);
        const [line, shimDir] = (await readFile(path.join(root, 'ran.txt'), 'utf8')).split('\n');
        expect(line).toBe('dt fmt');
        expect(path.basename(shimDir)).toStartWith('domaintrail-dt-');
        expect(await gone(shimDir)).toBe(true);
    });
});
