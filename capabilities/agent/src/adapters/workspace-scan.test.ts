// The runner's scan of the workspace: the directories and files it is told to skip (those only dt writes) are not
// scanned, but something else in their place (a file or a link for a directory, a directory or a link for a file) is
// still seen.
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
    await writeFile(path.join(root, 'domaintrail.journey.json'), '{}');
    await writeFile(path.join(root, 'docs', 'domaintrail.journey.json'), '{}');
    return root;
}

describe('scanWorkspace', () => {
    test('a skipped directory is not walked; one of the same name elsewhere is', async () => {
        const root = await workspace();
        expect([...(await scanWorkspace(root)).keys()].sort()).toEqual([
            'a.dt',
            'docs/domaintrail.journey.json',
            'docs/knowledge/notes.md',
            'domaintrail.journey.json',
            'knowledge/kn_1.md',
        ]);
        expect([...(await scanWorkspace(root, { skip: ['knowledge'] })).keys()].sort()).toEqual([
            'a.dt',
            'docs/domaintrail.journey.json',
            'docs/knowledge/notes.md',
            'domaintrail.journey.json',
        ]);
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

    test('a skipped file is not scanned; one of the same name elsewhere is', async () => {
        const root = await workspace();
        expect([...(await scanWorkspace(root, { skipFiles: ['domaintrail.journey.json'] })).keys()].sort()).toEqual([
            'a.dt',
            'docs/domaintrail.journey.json',
            'docs/knowledge/notes.md',
            'knowledge/kn_1.md',
        ]);
    });

    test('a directory or a link in place of a skipped file is still seen', async () => {
        const root = await workspace();
        const file = path.join(root, 'domaintrail.journey.json');
        await rm(file);
        await symlink(path.join(root, 'a.dt'), file);
        expect([...(await scanWorkspace(root, { skipFiles: ['domaintrail.journey.json'] })).keys()]).toContain('domaintrail.journey.json');
        await rm(file);
        await mkdir(file);
        await writeFile(path.join(file, 'x'), '');
        expect([...(await scanWorkspace(root, { skipFiles: ['domaintrail.journey.json'] })).keys()]).toContain('domaintrail.journey.json/x');
    });
});
