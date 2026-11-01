// The agent's dt (session.agent.dt) as the configuration reads it, and as the agent pins it (the shim itself:
// packages/agent/src/infrastructure/dt-shim.test.ts).
import { afterAll, describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pinDt } from '@domaintrail/agent';
import { ConfigError } from '@domaintrail/modeling';
import { loadConfig } from '@domaintrail/workspace';

const dirs: string[] = [];
afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
const scratch = async (): Promise<string> => {
    const dir = realpathSync(await mkdtemp(path.join(tmpdir(), 'domaintrail-agent-dt-')));
    dirs.push(dir);
    return dir;
};
const thrown = (f: () => unknown): string => {
    try {
        f();
        return 'succeeded';
    } catch (e) {
        return String(e);
    }
};
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
});
