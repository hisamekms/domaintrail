// What the AI reads outside the workspace is checked by real paths, and the CLI runs on Node, whose
// `fs.realpathSync` keeps the case a path was written in (`realpathSync.native` gives the file system's): on a
// case-insensitive file system (macOS by default), `…/WS/secrets` is `…/ws/secrets`, inside the workspace. This
// bundles the check for Node and runs it there (the security review's case variant).
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const ROOT = path.join(import.meta.dir, '..');

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const ENTRY = `
import { checkReadPaths, readTargets } from ${JSON.stringify(path.join(ROOT, 'capabilities/agent/src/adapters/read-paths.ts'))};
import { inside } from ${JSON.stringify(path.join(ROOT, 'capabilities/agent/src/adapters/dt-shim.ts'))};
const [ws, variant] = process.argv.slice(2);
let refused = '';
try {
    checkReadPaths({ read: { paths: [variant] } }, ws, (m) => { throw new Error(m); });
} catch (e) {
    refused = e.message;
}
const { targets, skipped } = readTargets([variant], ws);
console.log(JSON.stringify({ refused, targets, skipped, inside: inside(ws, variant) }));
`;

describe('read paths on Node', () => {
    test('a case variant of a path inside the workspace is inside it (real paths as the file system has them)', async () => {
        const base = await realpath(await mkdtemp(path.join(tmpdir(), 'domaintrail-read-node-')));
        dirs.push(base);
        const ws = path.join(base, 'ws');
        await mkdir(path.join(ws, 'secrets'), { recursive: true });
        await writeFile(path.join(ws, 'secrets', 'key'), 'WS_SECRET');
        const variant = path.join(base, 'WS', 'secrets');
        // a case-sensitive file system has no such path: nothing to bypass there
        if (!existsSync(variant)) return;
        const dir = path.join(base, 'bundle');
        await mkdir(dir);
        await writeFile(path.join(dir, 'entry.ts'), ENTRY);
        const built = await Bun.build({ entrypoints: [path.join(dir, 'entry.ts')], outdir: dir, naming: '[name].mjs', target: 'node', format: 'esm' });
        expect(built.logs.map(String)).toEqual([]);
        const r = Bun.spawnSync(['node', path.join(dir, 'entry.mjs'), ws, variant]);
        expect(r.stderr.toString()).toBe('');
        const out = JSON.parse(r.stdout.toString()) as { refused: string; targets: unknown[]; skipped: string[]; inside: boolean };
        expect(out.inside).toBe(true);
        expect(out.refused).toContain('it is inside the workspace');
        expect(out.targets).toEqual([]);
        expect(out.skipped).toEqual([`${variant} (it is inside the workspace, which the AI reads already (what git ignores there stays out))`]);
    }, 30_000);
});
