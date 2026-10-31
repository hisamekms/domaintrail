import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createClaudeCodeRunner } from '@domaintrail/agent/infrastructure/claude-code';
import { checkDtCommand, dtShim, launcherScript, resolveProgram, withPathFirst, writeDtShim } from '@domaintrail/agent/infrastructure/dt-shim';
import { ConfigError } from '@domaintrail/modeling/core/config';
import { loadConfig } from '@domaintrail/workspace/infrastructure/config';

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
const run = { prompt: 'p', allowedTools: ['Bash(dt fmt:*)'], requests: 1 };

describe("the agent's dt (session.agent.dt)", () => {
    test("the shim only starts the runtime on the launcher; the command's words are JSON in the launcher, spawned without a shell", () => {
        expect(dtShim('/usr/bin/node', "/tmp/it's/launcher.mjs", 'darwin')).toEqual({
            file: 'dt',
            text: `#!/bin/sh\nexec '/usr/bin/node' '/tmp/it'\\''s/launcher.mjs' "$@"\n`,
        });
        expect(dtShim('C:\\node.exe', 'C:\\Temp\\launcher.mjs', 'win32')).toEqual({
            file: 'dt.cmd',
            text: '@echo off\r\n"C:\\node.exe" "C:\\Temp\\launcher.mjs" %*\r\n',
        });
        // what cmd.exe interprets never reaches a .cmd file
        for (const bad of ['C:\\a&b\\node.exe', 'C:\\%PATH%\\node.exe', 'C:\\a"b\\node.exe', 'C:\\a|b\\node.exe'])
            expect(() => dtShim(bad, 'C:\\Temp\\launcher.mjs', 'win32')).toThrow();
        const launcher = launcherScript({ command: 'node', args: ['C:\\a&b %x%\\dt.js', '"quoted"'] });
        expect(launcher).toContain(JSON.stringify(['node', 'C:\\a&b %x%\\dt.js', '"quoted"']));
        expect(launcher).toContain('shell: false');
        expect(() => launcherScript({ command: 'node', args: ['a\nb'] })).toThrow();
    });

    test('first on the PATH, keeping the rest; a bare program resolved on the PATH on Windows only', async () => {
        expect(withPathFirst({ PATH: `/usr/bin${path.delimiter}/bin`, HOME: '/h' }, '/shim')).toEqual({
            PATH: `/shim${path.delimiter}/usr/bin${path.delimiter}/bin`,
            HOME: '/h',
        });
        expect(withPathFirst({ Path: 'C:\\bin' }, 'D:\\shim')).toEqual({ Path: `D:\\shim${path.delimiter}C:\\bin` });
        expect(withPathFirst({}, '/shim')).toEqual({ PATH: '/shim' });
        const bin = await scratch();
        await writeFile(path.join(bin, 'node.EXE'), '');
        expect(resolveProgram('node', { PATH: bin, PATHEXT: '.EXE' }, 'win32')).toBe(path.join(bin, 'node.EXE'));
        expect(resolveProgram('node', { PATH: bin }, 'linux')).toBe('node');
    });

    test('nothing it runs may be inside the workspace, through a symbolic link either', async () => {
        const root = await scratch();
        const outside = await scratch();
        await writeFile(path.join(outside, 'dt.js'), '');
        await mkdir(path.join(root, 'tools'));
        await writeFile(path.join(root, 'tools', 'dt.js'), '');
        await symlink(path.join(root, 'tools'), path.join(outside, 'link'));
        expect(() => checkDtCommand({ command: 'node', args: [path.join(outside, 'dt.js')] }, root)).not.toThrow();
        expect(() => checkDtCommand({ command: 'node', args: [path.join(root, 'tools', 'dt.js')] }, root)).toThrow(/inside the workspace/);
        expect(() => checkDtCommand({ command: path.join(outside, 'link', 'dt.js'), args: [] }, root)).toThrow(/inside the workspace/);
        // in the config: refused when it is read
        for (const dt of [
            ['node', './tools/dt.js'],
            ['node', `${path.join(outside, 'link')}/dt.js`],
        ]) {
            await writeFile(path.join(root, 'domaintrail.json'), JSON.stringify({ session: { agent: { dt } } }));
            const e = await loadConfig({ start: root }).then(
                () => undefined,
                (x: unknown) => x,
            );
            expect(e).toBeInstanceOf(ConfigError);
            expect(String(e)).toContain("'session.agent.dt' may not run anything inside the workspace");
        }
        await writeFile(path.join(root, 'domaintrail.json'), JSON.stringify({ session: { agent: { dt: ['node', path.join(outside, 'dt.js')] } } }));
        expect((await loadConfig({ start: root })).session.agent.dt).toEqual(['node', path.join(outside, 'dt.js')]);
        // nor may the shim be written there (here: a workspace holding the temporary directory)
        expect(
            await writeDtShim({ command: 'node', args: [] }, path.dirname(tmpdir())).then(
                () => 'written',
                (x: unknown) => String(x),
            ),
        ).toContain('inside the workspace');
    });

    test.skipIf(process.platform === 'win32')('`dt …` on that PATH runs the configured command with the arguments, from a private directory', async () => {
        const dir = await scratch();
        const echo = path.join(dir, 'echo dt.mjs');
        await writeFile(echo, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
        const shim = await writeDtShim({ command: 'node', args: [echo] }, await scratch());
        try {
            expect((await stat(shim.dir)).mode & 0o777).toBe(0o700);
            expect((await stat(path.join(shim.dir, 'dt'))).mode & 0o777).toBe(0o700);
            const out = spawnSync('dt', ['check', 'a b; $(x)'], { env: withPathFirst(process.env, shim.dir), encoding: 'utf8' });
            expect(JSON.parse(out.stdout)).toEqual(['check', 'a b; $(x)']);
        } finally {
            await shim.dispose();
        }
        expect(await gone(shim.dir)).toBe(true);
    });

    test.skipIf(process.platform === 'win32')(
        'the agent runs `dt` from its PATH: the shim, removed once the run ends; taken once, refused once changed',
        async () => {
            const root = await scratch();
            const tools = await scratch();
            const echo = path.join(tools, 'echo.mjs');
            await writeFile(echo, "console.log('dt ' + process.argv.slice(2).join(' '));\n");
            // a fake agent: runs `dt fmt` as the prompt allows, and writes what it printed into the workspace
            const agent = path.join(tools, 'agent.mjs');
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
            const runner = await createClaudeCodeRunner({ root, command: { command: 'node', args: [agent] }, dt: { command: 'node', args: [echo] } });
            const outcome = await runner.run({ ...run, signal: new AbortController().signal });
            expect(outcome.exitCode).toBe(0);
            const [line, shimDir] = (await readFile(path.join(root, 'ran.txt'), 'utf8')).split('\n');
            expect(line).toBe('dt fmt');
            expect(path.basename(shimDir)).toStartWith('domaintrail-dt-');
            expect(await gone(shimDir)).toBe(true);
            // the script changed after the runner took it: the next run does not start
            await writeFile(echo, 'console.log("something else");\n');
            expect(
                await runner.run({ ...run, signal: new AbortController().signal }).then(
                    () => 'ran',
                    (e: unknown) => String(e),
                ),
            ).toContain('changed since the subscriber started');
            // a command inside the workspace is refused when the runner is made
            await writeFile(path.join(root, 'dt.js'), '');
            expect(
                await createClaudeCodeRunner({ root, dt: { command: 'node', args: [path.join(root, 'dt.js')] } }).then(
                    () => 'made',
                    (e: unknown) => String(e),
                ),
            ).toContain('inside the workspace');
        },
    );
});
