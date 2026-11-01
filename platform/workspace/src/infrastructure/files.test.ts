import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { selection } from '../test-helpers.js';
import { findDomainFiles } from './files.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-cfg-'));
    dirs.push(dir);
    for (const [p, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(dir, p)), { recursive: true });
        await writeFile(path.join(dir, p), text);
    }
    return dir;
}

const MODEL = 'context S { id AId: UUID aggregate A { id: AId } }';

describe('sources', () => {
    test('the selection decides; ignored directories are never scanned', async () => {
        const dir = await project({
            'domain/sales/order.dt': MODEL,
            'domain/drafts/wip.dt': MODEL,
            'other/x.dt': MODEL,
            'node_modules/pkg/y.dt': MODEL,
        });
        expect(await findDomainFiles(dir, selection())).toEqual(['domain/drafts/wip.dt', 'domain/sales/order.dt', 'other/x.dt']);
        expect(
            await findDomainFiles(
                dir,
                selection((rel) => rel.startsWith('domain/') && !rel.startsWith('domain/drafts/')),
            ),
        ).toEqual(['domain/sales/order.dt']);
        // a directory never scanned is not walked, whatever the selection matches
        expect(await findDomainFiles(dir, { ...selection(), matches: () => true })).toEqual(['domain/drafts/wip.dt', 'domain/sales/order.dt', 'other/x.dt']);
        expect(await findDomainFiles(dir, selection(undefined, false))).toEqual(['domain/drafts/wip.dt', 'domain/sales/order.dt', 'other/x.dt']);
    });
});

describe('.gitignore', () => {
    test("git's rules: negation, directory patterns, anchoring, comments", async () => {
        const dir = await project({
            '.gitignore': '# drafts stay local\ndrafts/*.dt\n!drafts/keep.dt\nbuild/\n/top.dt\n',
            'drafts/wip.dt': MODEL,
            'drafts/keep.dt': MODEL,
            'build/x.dt': MODEL,
            'src/build/y.dt': MODEL,
            'build.dt': MODEL,
            'top.dt': MODEL,
            'sub/top.dt': MODEL,
        });
        expect(await findDomainFiles(dir, selection())).toEqual(['build.dt', 'drafts/keep.dt', 'sub/top.dt']);
    });

    test('a nested .gitignore applies below its directory and wins over the ones above it', async () => {
        const dir = await project({
            '.gitignore': '*.local.dt\na/b/\n',
            'a/.gitignore': '!b/\nscratch.dt\n!keep.local.dt\n',
            'a/b/s.dt': MODEL,
            'a/c/scratch.dt': MODEL,
            'scratch.dt': MODEL,
            'a/keep.local.dt': MODEL,
            'a/other.local.dt': MODEL,
            'x.local.dt': MODEL,
        });
        expect(await findDomainFiles(dir, selection())).toEqual(['a/b/s.dt', 'a/keep.local.dt', 'scratch.dt']);
    });

    test('the .gitignore files above the root up to the top of the git repository apply, and .git/info/exclude', async () => {
        const dir = await project({
            '.git/info/exclude': 'private/\n',
            '.gitignore': 'scratch/\n/domain/top-only.dt\n',
            'domain/s.dt': MODEL,
            'domain/top-only.dt': MODEL,
            'domain/scratch/s.dt': MODEL,
            'domain/private/s.dt': MODEL,
        });
        expect(await findDomainFiles(path.join(dir, 'domain'), selection())).toEqual(['s.dt']);
        // a root inside an ignored directory is checked as it is, with the rules from the root down only
        expect(await findDomainFiles(path.join(dir, 'domain', 'scratch'), selection())).toEqual(['s.dt']);
    });
});
