// The answerer's view of the workspace (ADR 0030, as built in M4): the files git does not ignore, without
// `.domaintrail/` and `.git/`, no link followed, kept up to date (changed and removed files), private, removed at the
// end; and the user's model and effort read from their Claude Code settings (no settings file is loaded by `claude`).
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
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
        expect((await ignoredEntries(root, (p) => ignored.has(path.relative(root, p)))).sort()).toEqual(['.env', 'a*.log', 'dist']);
        expect(deniedRules(['.env', 'a*.log', '../x', '/abs'])).toEqual([
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
