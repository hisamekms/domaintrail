// What a source archive holds: the sources `dt check` finds (`.dt` and `.dtes` only) and the project's config file,
// below a folder named after the workspace — never the local override, `.domaintrail`, `.git`, generated output, what
// git ignores or a symlink.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { readZip, selection } from '../test-helpers.js';
import { archiveName, createSourceArchive, sourceArchiveFiles } from './source-archive.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const scratch = async (name = 'shop'): Promise<string> => {
    const d = await mkdtemp(path.join(tmpdir(), 'domaintrail-archive-'));
    dirs.push(d);
    const root = path.join(d, name);
    await mkdir(root);
    return root;
};

async function put(root: string, files: Record<string, string>): Promise<void> {
    for (const [rel, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await writeFile(path.join(root, rel), text);
    }
}

/** A git environment without the user's config or excludes. */
async function gitEnv(): Promise<NodeJS.ProcessEnv> {
    const home = await mkdtemp(path.join(tmpdir(), 'domaintrail-archive-home-'));
    dirs.push(home);
    await writeFile(path.join(home, 'gitconfig'), '');
    return {
        ...process.env,
        HOME: home,
        GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
        XDG_CONFIG_HOME: path.join(home, '.config'),
    };
}

const workspace = {
    'domaintrail.jsonc': '{ "sources": ["**/*.dt", "**/*.dtes"] }\n',
    'domaintrail.local.jsonc': '{ "agent": {} }\n',
    'sales/order.dt': 'context Sales {}\n',
    '販売/注文.dt': 'context 販売 {}\n',
    'stormings/checkout.dtes': 'storming Checkout {}\n',
    'README.md': 'readme',
    'generated/domain/sales/index.ts': '// generated',
    '.domaintrail/session/x.dt': 'context Hidden {}\n',
    'node_modules/pkg/a.dt': 'context Dep {}\n',
};

describe('the files of a source archive', () => {
    test('the config file then the sources; not the local override, .domaintrail, node_modules, generated output or other files', async () => {
        const root = await scratch();
        await put(root, workspace);
        const files = await sourceArchiveFiles({ root, selection: selection(), configFile: path.join(root, 'domaintrail.jsonc') });
        expect(files).toEqual(['domaintrail.jsonc', 'sales/order.dt', 'stormings/checkout.dtes', '販売/注文.dt']);
    });

    test('only .dt and .dtes files, whatever the globs match; a local file given as the config is left out', async () => {
        const root = await scratch();
        await put(root, workspace);
        const everything = selection(() => true);
        expect(await sourceArchiveFiles({ root, selection: everything, configFile: path.join(root, 'domaintrail.local.jsonc') })).toEqual([
            'sales/order.dt',
            'stormings/checkout.dtes',
            '販売/注文.dt',
        ]);
    });

    test('a config file outside the root, or a symlink, is left out', async () => {
        const root = await scratch();
        await put(root, workspace);
        expect(await sourceArchiveFiles({ root, selection: selection(), configFile: path.join(path.dirname(root), 'domaintrail.jsonc') })).not.toContain(
            'domaintrail.jsonc',
        );
        await rm(path.join(root, 'domaintrail.jsonc'));
        await put(path.dirname(root), { 'elsewhere.jsonc': '{}' });
        await symlink(path.join(path.dirname(root), 'elsewhere.jsonc'), path.join(root, 'domaintrail.jsonc'));
        expect(await sourceArchiveFiles({ root, selection: selection(), configFile: path.join(root, 'domaintrail.jsonc') })).not.toContain('domaintrail.jsonc');
    });

    test('symlinks are skipped, to files and to directories, inside the workspace or not', async () => {
        const root = await scratch();
        await put(root, workspace);
        const outside = path.join(path.dirname(root), 'outside');
        await put(outside, { 'secret.dt': 'context Secret {}\n' });
        await symlink(path.join(outside, 'secret.dt'), path.join(root, 'linked.dt'));
        await symlink(path.join(root, 'sales'), path.join(root, 'sales-again'));
        await symlink(outside, path.join(root, 'outside'));
        const files = await sourceArchiveFiles({ root, selection: selection() });
        expect(files).toEqual(['sales/order.dt', 'stormings/checkout.dtes', '販売/注文.dt']);
    });

    test('in a git repository, nothing git ignores (by .gitignore or .git/info/exclude), even with respectGitignore off', async () => {
        const root = await scratch();
        const env = await gitEnv();
        execFileSync('git', ['init', '-q'], { cwd: root, env });
        await put(root, { ...workspace, '.gitignore': 'drafts/\n', 'drafts/wip.dt': 'context Wip {}\n', 'private.dt': 'context Private {}\n' });
        await writeFile(path.join(root, '.git', 'info', 'exclude'), 'private.dt\n');
        const options = { root, configFile: path.join(root, 'domaintrail.jsonc'), git: { env } };
        const expected = ['domaintrail.jsonc', 'sales/order.dt', 'stormings/checkout.dtes', '販売/注文.dt'];
        expect(await sourceArchiveFiles({ ...options, selection: selection() })).toEqual(expected);
        expect(await sourceArchiveFiles({ ...options, selection: selection(undefined, false) })).toEqual(expected);
    });
});

describe('a source archive', () => {
    test('below a folder named after the workspace, with the files as they are on disk', async () => {
        const root = await scratch('ショップ');
        await put(root, workspace);
        const archive = await createSourceArchive({ root, selection: selection(), configFile: path.join(root, 'domaintrail.jsonc') });
        expect(archive.name).toBe('ショップ');
        const read = readZip(archive.zip);
        expect(read.map((e) => e.name)).toEqual([
            'ショップ/domaintrail.jsonc',
            'ショップ/sales/order.dt',
            'ショップ/stormings/checkout.dtes',
            'ショップ/販売/注文.dt',
        ]);
        expect(read[3].data.toString('utf8')).toBe('context 販売 {}\n');
        expect(archive.files).toEqual(['domaintrail.jsonc', 'sales/order.dt', 'stormings/checkout.dtes', '販売/注文.dt']);
        expect(archive.sources).toBe(3);
    });

    test('the name of a workspace, usable as a file name', () => {
        expect(archiveName('/work/shop')).toBe('shop');
        expect(archiveName('/work/a:b')).toBe('a-b');
        expect(archiveName('/')).toBe('workspace');
    });
});
