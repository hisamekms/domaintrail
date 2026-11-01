import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createClaudeCodeRunner } from './claude-code.js';
import { agentDtArguments, checkDtOutsideWorkspace, dtShim, findProgram, inside, launcherScript, pinDt, withPathFirst, writeDtShim } from './dt-shim.js';
import { createDtTools } from './dt-tools.js';

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
    const dir = realpathSync(await mkdtemp(path.join(tmpdir(), 'domaintrail-agent-dt-')));
    dirs.push(dir);
    return dir;
};
const failure = (p: Promise<unknown>): Promise<string> =>
    p.then(
        () => 'succeeded',
        (e: unknown) => String(e),
    );
const run = { prompt: 'p', allowedTools: ['Bash(dt fmt:*)'], requests: 1 };
const node = realpathSync(findProgram('node') ?? process.execPath);

describe("the agent's dt (session.agent.dt)", () => {
    test('the shim only starts the runtime on the launcher; the pinned dt is JSON in the launcher, spawned without a shell in a private directory', () => {
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
        const launcher = launcherScript({ runtime: '/usr/bin/node', script: '/opt/a&b %x%/dt.js' }, '/ws', '/tmp/shim');
        expect(launcher).toContain(JSON.stringify(['/usr/bin/node', '/opt/a&b %x%/dt.js']));
        expect(launcher).toContain('shell: false');
        expect(launcher).toContain('cwd: "/tmp/shim"');
    });

    test('first on the PATH, keeping the rest; a program found on the PATH (with PATHEXT on Windows)', async () => {
        expect(withPathFirst({ PATH: `/usr/bin${path.delimiter}/bin`, HOME: '/h' }, '/shim')).toEqual({
            PATH: `/shim${path.delimiter}/usr/bin${path.delimiter}/bin`,
            HOME: '/h',
        });
        expect(withPathFirst({ Path: 'C:\\bin' }, 'D:\\shim')).toEqual({ Path: `D:\\shim${path.delimiter}C:\\bin` });
        const bin = await scratch();
        await writeFile(path.join(bin, 'node.EXE'), '');
        expect(findProgram('node', { PATH: bin, PATHEXT: '.EXE' }, 'win32')).toBe(path.join(bin, 'node.EXE'));
        expect(findProgram('node', { PATH: bin }, 'linux')).toBeUndefined();
    });

    test('inside the workspace by path segments: `<root>/..evil` is inside, a sibling `<root>-other` is not', async () => {
        const base = await scratch();
        const root = path.join(base, 'ws');
        await mkdir(path.join(root, '..evil'), { recursive: true });
        await mkdir(`${root}-other`);
        expect(inside(root, path.join(root, '..evil', 'x.js'))).toBe(true);
        expect(inside(root, path.join(`${root}-other`, 'x.js'))).toBe(false);
        expect(inside(root, root)).toBe(true);
        expect(inside(root, base)).toBe(false);
    });

    test('the configured dt (relative to the config file) runs nothing inside the workspace, symbolic links followed', async () => {
        const root = await scratch();
        const outside = await scratch();
        await mkdir(path.join(root, 'tools'));
        await symlink(path.join(root, 'tools'), path.join(outside, 'link'));
        const refusal = (dt: readonly string[] | undefined): string | undefined => {
            try {
                checkDtOutsideWorkspace(dt, root, (msg) => {
                    throw new Error(msg);
                });
                return undefined;
            } catch (e) {
                return e instanceof Error ? e.message : String(e);
            }
        };
        expect(refusal(undefined)).toBeUndefined();
        expect(refusal(['node', `../${path.basename(outside)}/dt.js`])).toBeUndefined();
        expect(refusal([path.join(outside, 'dt')])).toBeUndefined();
        expect(refusal(['node', './tools/dt.js'])).toBe(
            `'session.agent.dt' may not run anything inside the workspace (${path.join(root, 'tools', 'dt.js')}): the agent can write there during a run. Use a dt outside the workspace (e.g. a clone next to it).`,
        );
        for (const dt of [['node', `${path.join(outside, 'link')}/dt.js`], ['node', '..evil/dt.js'], ['./tools/dt.js']])
            expect(refusal(dt)).toContain("'session.agent.dt' may not run anything inside the workspace");
    });

    test("the agent's arguments: fmt or check, then .dt / .dtes files of the workspace; no option; -r is the launcher's", async () => {
        const root = await scratch();
        expect(agentDtArguments(['fmt'], root, root)).toEqual({ ok: true, args: ['-r', root, 'fmt'] });
        expect(agentDtArguments(['check', 'sales/order.dt', 'es.dtes'], path.join(root, 'x'), root)).toEqual({
            ok: true,
            args: ['-r', root, 'check', path.join(root, 'x', 'sales', 'order.dt'), path.join(root, 'x', 'es.dtes')],
        });
        for (const given of [
            ['generate', 'ts'],
            [],
            ['fmt', '--prefix', '/'],
            ['fmt', '-r', '/'],
            ['fmt', '--config=/x'],
            ['fmt', '-C', '/'],
            ['fmt', 'x.ts'],
            ['fmt', '../out.dt'],
            ['fmt', '/etc/x.dt'],
        ])
            expect(agentDtArguments(given, root, root).ok).toBe(false);
    });

    test.skipIf(process.platform === 'win32')(
        '`dt …` on that PATH runs the pinned dt on the workspace from a private directory, or refuses what the agent may not ask',
        async () => {
            const tools = await scratch();
            const echo = path.join(tools, 'echo dt.mjs');
            await writeFile(echo, 'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n');
            const root = await scratch();
            const shim = await writeDtShim(pinDt({ command: 'node', args: [echo] }, root), root);
            const dt = (args: string[]): ReturnType<typeof spawnSync> =>
                spawnSync('dt', args, { cwd: root, env: withPathFirst(process.env, shim.dir), encoding: 'utf8' });
            try {
                expect((await stat(shim.dir)).mode & 0o777).toBe(0o700);
                expect((await stat(path.join(shim.dir, 'dt'))).mode & 0o777).toBe(0o700);
                const ran = JSON.parse(String(dt(['check', 'a.dt']).stdout)) as { cwd: string; args: string[] };
                expect(ran.args).toEqual(['-r', root, 'check', path.join(root, 'a.dt')]);
                expect(realpathSync(ran.cwd)).toBe(realpathSync(shim.dir));
                for (const bad of [['fmt', '--cwd', '/'], ['generate'], ['fmt', '../x.dt']]) {
                    const r = dt(bad);
                    expect(r.status).toBe(2);
                    expect(String(r.stdout)).toBe('');
                    expect(String(r.stderr)).toContain('Use `dt fmt` or `dt check`');
                }
            } finally {
                await shim.dispose();
            }
            expect(await gone(shim.dir)).toBe(true);
        },
    );

    test.skipIf(process.platform === 'win32')(
        'the agent runs `dt` from its PATH: the shim, removed once the run ends; refused once what it runs changed',
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
            const runner = await createClaudeCodeRunner({
                root,
                command: { command: 'node', args: [agent] },
                dt: pinDt({ command: 'node', args: [echo] }, root),
            });
            const outcome = await runner.run({ ...run, signal: new AbortController().signal });
            expect(outcome.exitCode).toBe(0);
            const [line, shimDir] = (await readFile(path.join(root, 'ran.txt'), 'utf8')).split('\n');
            expect(line).toBe(`dt -r ${root} fmt`);
            expect(path.basename(shimDir)).toStartWith('domaintrail-dt-');
            expect(await gone(shimDir)).toBe(true);
            await writeFile(echo, 'console.log("something else");\n');
            expect(await failure(runner.run({ ...run, signal: new AbortController().signal }))).toContain('changed since the subscriber started');
            await writeFile(path.join(root, 'dt.js'), '');
            expect(await failure(createClaudeCodeRunner({ root, dt: { runtime: node, script: path.join(root, 'dt.js') } }))).toContain('inside the workspace');
        },
    );

    test('dt fmt / dt check after the agent run on the workspace from a fresh private directory, removed afterwards', async () => {
        const root = await scratch();
        const tools = await scratch();
        const record = path.join(tools, 'record.mjs');
        const out = path.join(tools, 'out.json');
        await writeFile(
            record,
            `import { statSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify({ cwd: process.cwd(), mode: statSync('.').mode & 0o777, args: process.argv.slice(2) }));\n`,
        );
        const dtTools = createDtTools({ dt: { command: node, args: [record] }, root, log: () => {} });
        expect(await dtTools.check()).toBe(true);
        const ran = JSON.parse(await readFile(out, 'utf8')) as { cwd: string; mode: number; args: string[] };
        expect(inside(root, ran.cwd)).toBe(false);
        expect(path.basename(ran.cwd)).toStartWith('domaintrail-dt-run-');
        expect(ran.mode).toBe(0o700);
        expect(await gone(ran.cwd)).toBe(true);
        expect(ran.args).toEqual(['-r', root, 'check']);
    });
});
