// The agent's dt (session.agent.dt) with real processes: the shim on the PATH, the Claude Code runner with a fake agent,
// dt fmt / dt check after a run, and the setting as the configuration reads it (the shim's pure parts:
// packages/agent/src/infrastructure/dt-shim.test.ts).
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createClaudeCodeRunner, createDtTools, pinDt, writeDtShim } from '@domaintrail/agent';
import { ConfigError } from '@domaintrail/modeling';
import { loadConfig } from '@domaintrail/workspace';

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
const thrown = (f: () => unknown): string => {
    try {
        f();
        return 'succeeded';
    } catch (e) {
        return String(e);
    }
};
const run = { prompt: 'p', allowedTools: ['Bash(dt fmt:*)'], requests: 1 };
const node = realpathSync(Bun.which('node') ?? process.execPath);

describe("the agent's dt (session.agent.dt)", () => {
    test('only two shapes: [node|bun|deno, script] or [dt executable], as absolute real paths outside the workspace', async () => {
        const root = await scratch();
        const outside = await scratch();
        await writeFile(path.join(outside, 'dt.js'), '');
        await writeFile(path.join(outside, 'dt'), '');
        await mkdir(path.join(root, 'tools'));
        await writeFile(path.join(root, 'tools', 'dt.js'), '');
        await mkdir(path.join(root, '..evil'));
        await writeFile(path.join(root, '..evil', 'dt.js'), '');
        await symlink(path.join(root, 'tools'), path.join(outside, 'link'));
        expect(pinDt({ command: 'node', args: [path.join(outside, 'dt.js')] }, root)).toEqual({ runtime: node, script: path.join(outside, 'dt.js') });
        expect(pinDt({ command: path.join(outside, 'dt'), args: [] }, root)).toEqual({ script: path.join(outside, 'dt') });
        const refused: [{ command: string; args: string[] }, RegExp][] = [
            [{ command: 'npx', args: ['domaintrail'] }, /not one of the runtimes/],
            [{ command: 'bunx', args: ['domaintrail'] }, /not one of the runtimes/],
            [{ command: 'bun', args: ['x'] }, /absolute path/],
            [{ command: 'npm', args: ['exec', 'dt'] }, /no other word/],
            [{ command: 'node', args: ['--require=/x.js', path.join(outside, 'dt.js')] }, /no other word/],
            [{ command: 'node', args: ['-r', '/x.js', path.join(outside, 'dt.js')] }, /no other word/],
            [{ command: 'node', args: [path.join(root, 'tools', 'dt.js')] }, /inside the workspace/],
            [{ command: 'node', args: [path.join(root, '..evil', 'dt.js')] }, /inside the workspace/],
            [{ command: 'node', args: [path.join(outside, 'link', 'dt.js')] }, /inside the workspace/],
            [{ command: 'node', args: ['dt.js'] }, /absolute path/],
            [{ command: 'dt', args: [] }, /by its path/],
        ];
        for (const [dt, why] of refused) expect(thrown(() => pinDt(dt, root))).toMatch(why);
        // in the config: the shapes, the script relative to the config file, nothing inside the workspace
        const configured = async (dt: unknown): Promise<string> => {
            await writeFile(path.join(root, 'domaintrail.json'), JSON.stringify({ session: { agent: { dt } } }));
            return loadConfig({ start: root }).then(
                (c) => JSON.stringify(c.session.agent.dt),
                (e: unknown) => (e instanceof ConfigError ? `ConfigError ${String(e)}` : String(e)),
            );
        };
        expect(await configured(['node', `../${path.basename(outside)}/dt.js`])).toBe(JSON.stringify(['node', path.join(outside, 'dt.js')]));
        expect(await configured([path.join(outside, 'dt')])).toBe(JSON.stringify([path.join(outside, 'dt')]));
        for (const dt of [['npx', 'domaintrail'], ['bun', 'x', 'dt'], ['node', '--require=./x.js', 'dt.js'], ['node', '-r'], ['dt'], ['corepack', 'dt']])
            expect(await configured(dt)).toContain('ConfigError Error: ');
        for (const dt of [['node', './tools/dt.js'], ['node', `${path.join(outside, 'link')}/dt.js`], ['node', '..evil/dt.js'], ['./tools/dt.js']])
            expect(await configured(dt)).toContain("'session.agent.dt' may not run anything inside the workspace");
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
                spawnSync('dt', args, { cwd: root, env: { ...process.env, PATH: `${shim.dir}${path.delimiter}${process.env.PATH ?? ''}` }, encoding: 'utf8' });
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
        expect(path.relative(root, ran.cwd).startsWith('..')).toBe(true);
        expect(path.basename(ran.cwd)).toStartWith('domaintrail-dt-run-');
        expect(ran.mode).toBe(0o700);
        expect(await gone(ran.cwd)).toBe(true);
        expect(ran.args).toEqual(['-r', root, 'check']);
    });
});
