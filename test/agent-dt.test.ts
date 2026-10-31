import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createClaudeCodeRunner } from '@domaintrail/agent/infrastructure/claude-code';
import { dtShim, findProgram, inside, launcherScript, pinDtCommand, withPathFirst, writeDtShim } from '@domaintrail/agent/infrastructure/dt-shim';
import { createDtTools } from '@domaintrail/agent/infrastructure/dt-tools';
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
const failure = (p: Promise<unknown>): Promise<string> =>
    p.then(
        () => 'succeeded',
        (e: unknown) => String(e),
    );
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
        const launcher = launcherScript({ command: 'node', args: ['C:\\a&b %x%\\dt.js', '"quoted"'] }, '/tmp/shim');
        expect(launcher).toContain(JSON.stringify(['node', 'C:\\a&b %x%\\dt.js', '"quoted"']));
        expect(launcher).toContain('shell: false');
        expect(launcher).toContain('cwd: "/tmp/shim"');
        expect(() => launcherScript({ command: 'node', args: ['a\nb'] }, '/tmp/shim')).toThrow();
    });

    test('first on the PATH, keeping the rest; a program found on the PATH (with PATHEXT on Windows)', async () => {
        expect(withPathFirst({ PATH: `/usr/bin${path.delimiter}/bin`, HOME: '/h' }, '/shim')).toEqual({
            PATH: `/shim${path.delimiter}/usr/bin${path.delimiter}/bin`,
            HOME: '/h',
        });
        expect(withPathFirst({ Path: 'C:\\bin' }, 'D:\\shim')).toEqual({ Path: `D:\\shim${path.delimiter}C:\\bin` });
        expect(withPathFirst({}, '/shim')).toEqual({ PATH: '/shim' });
        const bin = await scratch();
        await writeFile(path.join(bin, 'node.EXE'), '');
        expect(findProgram('node', { PATH: bin, PATHEXT: '.EXE' }, 'win32')).toBe(path.join(bin, 'node.EXE'));
        expect(findProgram('node', { PATH: bin }, 'linux')).toBeUndefined();
        await writeFile(path.join(bin, 'dtx'), '');
        expect(findProgram('dtx', { PATH: bin }, 'linux')).toBe(path.join(bin, 'dtx'));
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

    test('pinned: nothing it runs may be inside the workspace — the program, a script, an option value, through a link — nor a package runner', async () => {
        const root = await scratch();
        const outside = await scratch();
        await writeFile(path.join(outside, 'dt.js'), '');
        await mkdir(path.join(root, 'tools'));
        await writeFile(path.join(root, 'tools', 'dt.js'), '');
        await writeFile(path.join(root, 'x.js'), '');
        await mkdir(path.join(root, '..evil'));
        await writeFile(path.join(root, '..evil', 'x.js'), '');
        await symlink(path.join(root, 'tools'), path.join(outside, 'link'));
        const ok = pinDtCommand({ command: 'node', args: [path.join(outside, 'dt.js')] }, root);
        expect(path.isAbsolute(ok.program)).toBe(true);
        expect(ok.files).toContain(path.join(realpathSync(outside), 'dt.js'));
        for (const dt of [
            { command: 'node', args: [path.join(root, 'tools', 'dt.js')] },
            { command: 'node', args: ['tools/dt.js'] },
            { command: 'node', args: ['x.js'] },
            { command: 'node', args: [path.join(root, '..evil', 'x.js')] },
            { command: 'node', args: [`--require=${path.join(root, 'x.js')}`, path.join(outside, 'dt.js')] },
            { command: 'node', args: ['--import=./x.js', path.join(outside, 'dt.js')] },
            { command: 'node', args: ['-r', path.join(root, 'x.js'), path.join(outside, 'dt.js')] },
            { command: path.join(outside, 'link', 'dt.js'), args: [] },
        ])
            expect(() => pinDtCommand(dt, root)).toThrow(/inside the workspace/);
        for (const dt of [
            { command: 'npx', args: ['domaintrail'] },
            { command: 'bunx', args: ['domaintrail'] },
            { command: 'bun', args: ['run', 'dt'] },
            { command: 'npm', args: ['exec', 'dt'] },
        ])
            expect(() => pinDtCommand(dt, root)).toThrow(/package runner|not found/);
        expect(() => pinDtCommand({ command: 'no-such-dt-program', args: [] }, root)).toThrow(/not found/);
        // in the config: refused when it is read
        for (const dt of [
            ['node', './tools/dt.js'],
            ['node', `${path.join(outside, 'link')}/dt.js`],
            ['node', '--require=./x.js', path.join(outside, 'dt.js')],
            ['node', '..evil/x.js'],
        ]) {
            await writeFile(path.join(root, 'domaintrail.json'), JSON.stringify({ session: { agent: { dt } } }));
            const e = await loadConfig({ start: root }).then(
                () => undefined,
                (x: unknown) => x,
            );
            expect(e).toBeInstanceOf(ConfigError);
            expect(String(e)).toContain("'session.agent.dt' may not run anything inside the workspace");
        }
        await writeFile(path.join(root, 'domaintrail.json'), JSON.stringify({ session: { agent: { dt: ['npx', 'domaintrail'] } } }));
        expect(await failure(loadConfig({ start: root }))).toContain('package runner');
        await writeFile(path.join(root, 'domaintrail.json'), JSON.stringify({ session: { agent: { dt: ['node', path.join(outside, 'dt.js')] } } }));
        expect((await loadConfig({ start: root })).session.agent.dt).toEqual(['node', path.join(outside, 'dt.js')]);
        // nor may the shim be written there (here: a workspace holding the temporary directory)
        expect(await failure(writeDtShim(ok, path.dirname(tmpdir())))).toContain('inside the workspace');
    });

    test.skipIf(process.platform === 'win32')('`dt …` on that PATH runs the command outside the workspace, on it, from a private directory', async () => {
        const dir = await scratch();
        const echo = path.join(dir, 'echo dt.mjs');
        await writeFile(echo, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
        const root = await scratch();
        await writeFile(path.join(root, 'a.dt'), '');
        const shim = await writeDtShim(pinDtCommand({ command: 'node', args: [echo] }, root), root);
        try {
            expect((await stat(shim.dir)).mode & 0o777).toBe(0o700);
            expect((await stat(path.join(shim.dir, 'dt'))).mode & 0o777).toBe(0o700);
            // called in the workspace: -r names it, and a file of it is made absolute
            const out = spawnSync('dt', ['check', 'a b; $(x)', 'a.dt'], { cwd: root, env: withPathFirst(process.env, shim.dir), encoding: 'utf8' });
            const realRoot = realpathSync(root);
            expect(JSON.parse(out.stdout)).toEqual(['-r', realRoot, 'check', 'a b; $(x)', path.join(realRoot, 'a.dt')]);
        } finally {
            await shim.dispose();
        }
        expect(await gone(shim.dir)).toBe(true);
    });

    test.skipIf(process.platform === 'win32')(
        'the agent runs `dt` from its PATH: the shim, removed once the run ends; refused once a file of it changed',
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
                dt: pinDtCommand({ command: 'node', args: [echo] }, root),
            });
            const outcome = await runner.run({ ...run, signal: new AbortController().signal });
            expect(outcome.exitCode).toBe(0);
            const [line, shimDir] = (await readFile(path.join(root, 'ran.txt'), 'utf8')).split('\n');
            expect(line).toBe(`dt -r ${realpathSync(root)} fmt`);
            expect(path.basename(shimDir)).toStartWith('domaintrail-dt-');
            expect(await gone(shimDir)).toBe(true);
            // the script changed after the runner pinned it: the next run does not start
            await writeFile(echo, 'console.log("something else");\n');
            expect(await failure(runner.run({ ...run, signal: new AbortController().signal }))).toContain('changed since the subscriber started');
            // a command inside the workspace is refused when the runner is made
            await writeFile(path.join(root, 'dt.js'), '');
            expect(await failure(createClaudeCodeRunner({ root, dt: { program: process.execPath, args: [path.join(root, 'dt.js')], files: [] } }))).toContain(
                'inside the workspace',
            );
        },
    );

    test('dt fmt / dt check after the agent run outside the workspace, on it', async () => {
        const root = await scratch();
        const tools = await scratch();
        const record = path.join(tools, 'record.mjs');
        const out = path.join(tools, 'out.json');
        await writeFile(
            record,
            `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n`,
        );
        const dtTools = createDtTools({ dt: { command: process.execPath, args: [record] }, root, log: () => {} });
        expect(await dtTools.check()).toBe(true);
        const ran = JSON.parse(await readFile(out, 'utf8')) as { cwd: string; args: string[] };
        expect(inside(root, ran.cwd)).toBe(false);
        expect(ran.args).toEqual(['-r', root, 'check']);
    });
});
