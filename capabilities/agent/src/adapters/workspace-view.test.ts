// The answerer's view of the workspace (ADR 0030, as built in M4): the files git does not ignore, without
// `.domaintrail/` and `.git/`, no link followed, kept up to date (changed and removed files), private, removed at the
// end; and the user's model and effort read from their Claude Code settings (no settings file is loaded by `claude`).
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ReadScopeTooLarge } from '../core/ports.js';
import { userClaudeDefaults } from './claude-settings.js';
import { createWorkspaceView } from './workspace-view.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const scratch = async (): Promise<string> => {
    const d = await mkdtemp(path.join(tmpdir(), 'domaintrail-view-'));
    dirs.push(d);
    return d;
};

const files = async (d: string, rel = ''): Promise<string[]> => {
    const { readdir } = await import('node:fs/promises');
    const out: string[] = [];
    for (const e of await readdir(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...(await files(path.join(d, e.name), r)));
        else out.push(r);
    }
    return out.sort();
};

describe("the answerer's view of the workspace", () => {
    test('the files git does not ignore; never .domaintrail/, .git/, node_modules/, a link or a file too large', async () => {
        const root = await scratch();
        const outside = await scratch();
        await writeFile(path.join(outside, 'secret.txt'), 'CANARY');
        await writeFile(path.join(root, 'shop.dt'), 'context Shop {}\n');
        await writeFile(path.join(root, 'README.md'), 'readme');
        await mkdir(path.join(root, 'docs'));
        await writeFile(path.join(root, 'docs', 'notes.md'), 'notes');
        await writeFile(path.join(root, '.env'), 'TOKEN=1');
        await mkdir(path.join(root, 'dist'));
        await writeFile(path.join(root, 'dist', 'out.js'), 'x');
        await mkdir(path.join(root, '.domaintrail', 'session'), { recursive: true });
        await writeFile(path.join(root, '.domaintrail', 'session', 'agent.json'), '{"token":"t"}');
        await mkdir(path.join(root, '.git'));
        await writeFile(path.join(root, '.git', 'config'), '[core]');
        await mkdir(path.join(root, 'node_modules'));
        await writeFile(path.join(root, 'node_modules', 'm.js'), 'x');
        await writeFile(path.join(root, 'big.txt'), 'x'.repeat(2000));
        await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
        const ignored = new Set(['.env', 'dist']);
        const view = createWorkspaceView({ root, ignores: (p) => ignored.has(path.relative(root, p)), maxFileBytes: 1000, parent: await scratch() });
        const dir = await view.refresh();
        const listed = async (d: string, rel = ''): Promise<string[]> => {
            const { readdir } = await import('node:fs/promises');
            const out: string[] = [];
            for (const e of await readdir(d, { withFileTypes: true })) {
                const r = rel ? `${rel}/${e.name}` : e.name;
                if (e.isDirectory()) out.push(...(await listed(path.join(d, e.name), r)));
                else out.push(r);
            }
            return out.sort();
        };
        expect(await listed(dir)).toEqual(['README.md', 'docs/notes.md', 'shop.dt']);
        expect(dir.startsWith(root)).toBe(false);
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
        // changed, added and removed files follow on the next refresh
        await writeFile(path.join(root, 'shop.dt'), 'context Shop { }\n// changed\n');
        await unlink(path.join(root, 'README.md'));
        await writeFile(path.join(root, 'new.dtes'), 'storming S {}\n');
        expect(await view.refresh()).toBe(dir);
        expect(await listed(dir)).toEqual(['docs/notes.md', 'new.dtes', 'shop.dt']);
        expect(await readFile(path.join(dir, 'shop.dt'), 'utf8')).toContain('// changed');
        await view.dispose();
        expect(existsSync(dir)).toBe(false);
    });

    test("git's allowlist: regular files only, nothing of .git, .domaintrail or node_modules at any depth, no link above a file", async () => {
        const root = await scratch();
        const outside = await scratch();
        await writeFile(path.join(outside, 'secret.txt'), 'CANARY');
        await writeFile(path.join(root, 'README.md'), 'readme');
        await mkdir(path.join(root, 'sub', '.git'), { recursive: true });
        await writeFile(path.join(root, 'sub', '.git', 'config'), '[core]');
        await mkdir(path.join(root, 'sub', '.domaintrail'), { recursive: true });
        await writeFile(path.join(root, 'sub', '.domaintrail', 'x'), 'x');
        await mkdir(path.join(root, 'mod'));
        await writeFile(path.join(root, 'mod', '.git'), 'gitdir: ../.git/modules/mod');
        await writeFile(path.join(root, 'mod', 'a.md'), 'a');
        await writeFile(path.join(root, 'not-listed.env'), 'x');
        await symlink(outside, path.join(root, 'linked'));
        const listed = [
            'README.md',
            'sub/.git/config',
            'sub/.domaintrail/x',
            'mod/.git',
            'mod/a.md',
            'nested/',
            'linked/secret.txt',
            '../outside.txt',
            'gone.md',
        ];
        let calls = 0;
        const view = createWorkspaceView({
            root,
            list: async () => (calls++, listed),
            ignores: () => {
                throw new Error('not walked');
            },
            parent: await scratch(),
        });
        const dir = await view.refresh();
        expect(calls).toBe(1);
        expect(await files(dir)).toEqual(['README.md', 'mod/a.md']);
        await view.dispose();
    });

    test("git's allowlist on a case-insensitive file system: .GIT, .DomainTrail never copied; a name only as readdir gives it", async () => {
        const root = await scratch();
        await writeFile(path.join(root, 'README.md'), 'readme');
        await mkdir(path.join(root, '.git'));
        await writeFile(path.join(root, '.git', 'config'), 'GIT_CANARY');
        await mkdir(path.join(root, 'sub', '.domaintrail'), { recursive: true });
        await writeFile(path.join(root, 'sub', '.domaintrail', 'x'), 'DT_CANARY');
        await mkdir(path.join(root, 'Docs'));
        await writeFile(path.join(root, 'Docs', 'a.md'), 'a');
        // index entries in another case or Unicode form than the disk's (on macOS they open the same files)
        const listed = ['README.md', '.GIT/config', '.Git/config', 'sub/.DomainTrail/x', 'sub/.DOMAINTRAI\u004C/x', 'readme.md', 'docs/a.md', 'Docs/a.md'];
        const view = createWorkspaceView({ root, list: async () => listed, parent: await scratch() });
        expect(await files(await view.refresh())).toEqual(['Docs/a.md', 'README.md']);
        await view.dispose();
    });

    test('walked (git does not speak for the root): a nested .git file or directory and .domaintrail/ are never copied', async () => {
        const root = await scratch();
        await writeFile(path.join(root, 'README.md'), 'readme');
        await mkdir(path.join(root, 'mod'));
        await writeFile(path.join(root, 'mod', '.git'), 'gitdir: x');
        await mkdir(path.join(root, 'sub', '.git'), { recursive: true });
        await writeFile(path.join(root, 'sub', '.git', 'config'), '[core]');
        await mkdir(path.join(root, 'sub', '.domaintrail'), { recursive: true });
        await writeFile(path.join(root, 'sub', '.domaintrail', 'x'), 'x');
        await writeFile(path.join(root, 'sub', 'notes.md'), 'n');
        await mkdir(path.join(root, 'plain', '.DomainTrail'), { recursive: true });
        await writeFile(path.join(root, 'plain', '.DomainTrail', 'x'), 'x');
        await writeFile(path.join(root, 'plain', 'notes.md'), 'n');
        const view = createWorkspaceView({ root, list: async () => undefined, parent: await scratch() });
        // a directory holding a .git (a nested repository, a submodule) is not walked into, as git does not list it
        expect(await files(await view.refresh())).toEqual(['README.md', 'plain/notes.md']);
        await view.dispose();
    });

    test("the user's model and effort from ~/.claude/settings.json; nothing when absent or unfit", async () => {
        const home = await scratch();
        expect(userClaudeDefaults(home)).toEqual({});
        await mkdir(path.join(home, '.claude'));
        await writeFile(
            path.join(home, '.claude', 'settings.json'),
            JSON.stringify({ model: 'opus[1m]', effortLevel: 'medium', permissions: { allow: ['Read'] } }),
        );
        expect(userClaudeDefaults(home)).toEqual({ model: 'opus[1m]', effort: 'medium' });
        await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: '--bare', effortLevel: 'huge' }));
        expect(userClaudeDefaults(home)).toEqual({});
    });
});

describe('what git ignores, kept from the runner by deny rules', () => {
    test('the topmost ignored entries, never below them, nor .domaintrail/ and .git/; as rules with their characters escaped', async () => {
        const { ignoredEntries } = await import('./workspace-view.js');
        const { deniedRules } = await import('./claude-code.js');
        const root = await scratch();
        await mkdir(path.join(root, 'dist', 'deep'), { recursive: true });
        await writeFile(path.join(root, 'dist', 'deep', 'x.js'), 'x');
        await writeFile(path.join(root, '.env'), 'x');
        await writeFile(path.join(root, 'a*.log'), 'x');
        await writeFile(path.join(root, 'shop.dt'), 'x');
        await mkdir(path.join(root, '.domaintrail'));
        const ignored = new Set(['dist', '.env', 'a*.log', '.domaintrail']);
        expect((await ignoredEntries(root, { ignores: (p) => ignored.has(path.relative(root, p)) })).sort()).toEqual(['.env', 'a*.log', 'dist']);
        // git's list when it speaks for the root (no walk), in its order: its directories without the trailing /, nothing
        // below an exact .git or .domaintrail (the static rules), a case variant kept with a rule of its own
        const { MAX_IGNORED_ENTRIES, TooManyDeniedEntries } = await import('./workspace-view.js');
        const notWalked = (): boolean => {
            throw new Error('not walked');
        };
        const fromGit = await ignoredEntries(root, {
            list: async () => ['.env', 'dist/', 'sub/.git/', 'sub/.domaintrail/', '.GIT/x', 'Sub/.DomainTrail/', 'dist/'],
            ignores: notWalked,
        });
        expect(fromGit).toEqual(['.env', 'dist', '.GIT/x', 'Sub/.DomainTrail']);
        // more than MAX_IGNORED_ENTRIES: refused (fail closed), never a list cut short
        const many = Array.from({ length: MAX_IGNORED_ENTRIES + 1 }, (_, i) => `f${i}`);
        expect(await ignoredEntries(root, { list: async () => many.slice(0, MAX_IGNORED_ENTRIES), ignores: notWalked })).toHaveLength(MAX_IGNORED_ENTRIES);
        const refused = await ignoredEntries(root, { list: async () => many, ignores: notWalked }).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(TooManyDeniedEntries);
        // the subscriber fails the run as ReadScopeTooLarge (the page says why) rather than AgentError
        expect(refused).toBeInstanceOf(ReadScopeTooLarge);
        expect(String(refused)).toContain('ignore whole directories');
        // git does not speak for the root: walked; a directory holding a .git (in any case) denied as a whole
        await mkdir(path.join(root, 'vendor', 'lib', '.GIT'), { recursive: true });
        await writeFile(path.join(root, 'vendor', 'lib', '.env'), 'NESTED_CANARY');
        expect(await ignoredEntries(root, { list: async () => undefined, ignores: (p) => ignored.has(path.relative(root, p)) })).toEqual([
            '.env',
            'a*.log',
            'dist',
            'vendor/lib',
        ]);
        // walked past the bound: refused as well
        const wide = await scratch();
        for (let i = 0; i <= MAX_IGNORED_ENTRIES; i++) await writeFile(path.join(wide, `f${i}.log`), 'x');
        expect(await ignoredEntries(wide, { list: async () => undefined, ignores: (p) => p.endsWith('.log') }).catch((e: unknown) => e)).toBeInstanceOf(
            TooManyDeniedEntries,
        );
        // a path no rule can name refuses the list (fail closed): read-scope.test.ts
        expect(() => deniedRules(['.env', '../x'])).toThrow(ReadScopeTooLarge);
        expect(deniedRules(['.env', 'a*.log'])).toEqual([
            'Read(./.env)',
            'Edit(./.env)',
            'Read(./.env/**)',
            'Edit(./.env/**)',
            'Read(./a\\*.log)',
            'Edit(./a\\*.log)',
            'Read(./a\\*.log/**)',
            'Edit(./a\\*.log/**)',
        ]);
    });
});
