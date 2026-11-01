import { afterAll, describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { agentDtArguments, dtShim, findProgram, inside, launcherScript, withPathFirst } from './dt-shim.js';

const dirs: string[] = [];
afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
const scratch = async (): Promise<string> => {
    const dir = realpathSync(await mkdtemp(path.join(tmpdir(), 'domaintrail-agent-dt-')));
    dirs.push(dir);
    return dir;
};

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
});
