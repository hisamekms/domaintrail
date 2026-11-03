// The layout file `.domaintrail/layout.json`: private to the user, like everything under `.domaintrail`.
import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
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
    test.skipIf(process.platform === 'win32')('is 0600 in a .domaintrail of 0700, whatever the umask', async () => {
        const root = await tempDir();
        const umask = process.umask(0o000);
        try {
            await createFileLayoutStore(root).save(engine, layouts);
        } finally {
            process.umask(umask);
        }
        expect(await modeOf(path.join(root, '.domaintrail'))).toBe(0o700);
        expect(await modeOf(path.join(root, LAYOUT_FILE))).toBe(0o600);
        expect([...(await createFileLayoutStore(root).load(engine)).keys()]).toEqual(['g']);
    });

    test.skipIf(process.platform === 'win32')('tightens a .domaintrail an older version left readable by others', async () => {
        const root = await tempDir();
        await mkdir(path.join(root, '.domaintrail'));
        await chmod(path.join(root, '.domaintrail'), 0o755);
        await createFileLayoutStore(root).save(engine, layouts);
        expect(await modeOf(path.join(root, '.domaintrail'))).toBe(0o700);
        expect(await modeOf(path.join(root, LAYOUT_FILE))).toBe(0o600);
    });
});
