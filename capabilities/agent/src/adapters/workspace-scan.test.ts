// The runner's scan of the workspace: the directories it is told to skip (those only dt writes) are not walked, but a
// file or a link in their place is still seen.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { scanWorkspace } from './workspace-scan.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-scan-'));
    dirs.push(root);
    await writeFile(path.join(root, 'a.dt'), '');
    await mkdir(path.join(root, 'knowledge'));
    await writeFile(path.join(root, 'knowledge', 'kn_1.md'), '');
    await mkdir(path.join(root, 'docs', 'knowledge'), { recursive: true });
    await writeFile(path.join(root, 'docs', 'knowledge', 'notes.md'), '');
    return root;
}

describe('scanWorkspace', () => {
    test('a skipped directory is not walked; one of the same name elsewhere is', async () => {
        const root = await workspace();
        expect([...(await scanWorkspace(root)).keys()].sort()).toEqual(['a.dt', 'docs/knowledge/notes.md', 'knowledge/kn_1.md']);
        expect([...(await scanWorkspace(root, { skip: ['knowledge'] })).keys()].sort()).toEqual(['a.dt', 'docs/knowledge/notes.md']);
    });

    test('a file or a link in place of a skipped directory is still seen', async () => {
        const root = await workspace();
        await rm(path.join(root, 'knowledge'), { recursive: true });
        await symlink(path.join(root, 'docs'), path.join(root, 'knowledge'));
        expect([...(await scanWorkspace(root, { skip: ['knowledge'] })).keys()]).toContain('knowledge');
        await rm(path.join(root, 'knowledge'));
        await writeFile(path.join(root, 'knowledge'), '');
        expect([...(await scanWorkspace(root, { skip: ['knowledge'] })).keys()]).toContain('knowledge');
    });
});
