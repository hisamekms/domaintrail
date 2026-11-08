// The layout file `layout.json` in the workspace's cache directory: private to the user, never written through a link.
import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { LaidOutGraph } from '../core/graph/ir.js';
import { LAYOUT_FILE, createFileLayoutStore } from './file-layout-store.js';

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-layout-'));
    dirs.push(dir);
    return dir;
}

const modeOf = async (p: string): Promise<number> => (await lstat(p)).mode & 0o777;
const engine = { name: 'test', version: 1 };
const layouts = new Map<string, LaidOutGraph>([['g', { id: 'g', nodes: [], edges: [], signature: 's', nodeLayout: {}, edgeLayout: {} }]]);

describe('the layout file', () => {
    test.skipIf(process.platform === 'win32')('is 0600 in a directory of 0700 (made), whatever the umask', async () => {
        const dir = path.join(await tempDir(), 'cache', 'shop-01234567');
        const umask = process.umask(0o000);
        try {
            await createFileLayoutStore(dir).save(engine, layouts);
        } finally {
            process.umask(umask);
        }
        expect(await modeOf(dir)).toBe(0o700);
        expect(await modeOf(path.join(dir, LAYOUT_FILE))).toBe(0o600);
        expect([...(await createFileLayoutStore(dir).load(engine)).keys()]).toEqual(['g']);
    });

    test.skipIf(process.platform === 'win32')('tightens a directory readable by others', async () => {
        const dir = await tempDir();
        await chmod(dir, 0o755);
        await createFileLayoutStore(dir).save(engine, layouts);
        expect(await modeOf(dir)).toBe(0o700);
        expect(await modeOf(path.join(dir, LAYOUT_FILE))).toBe(0o600);
    });

    test.skipIf(process.platform === 'win32')('never through a link: a linked directory is not written, a linked file is replaced', async () => {
        const base = await tempDir();
        const outside = path.join(base, 'outside');
        await mkdir(outside);
        await writeFile(path.join(outside, 'victim.txt'), 'keep');
        await symlink(outside, path.join(base, 'linked'));
        await createFileLayoutStore(path.join(base, 'linked')).save(engine, layouts);
        expect(await lstat(path.join(outside, LAYOUT_FILE)).catch(() => 'absent')).toBe('absent');
        const dir = path.join(base, 'plain');
        await mkdir(dir);
        await symlink(path.join(outside, 'victim.txt'), path.join(dir, LAYOUT_FILE));
        await createFileLayoutStore(dir).save(engine, layouts);
        expect(await readlink(path.join(dir, LAYOUT_FILE)).catch(() => 'replaced')).toBe('replaced');
        expect(await readFile(path.join(outside, 'victim.txt'), 'utf8')).toBe('keep');
    });
});
