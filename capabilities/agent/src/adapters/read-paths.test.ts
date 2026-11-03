// What the AI reads outside the workspace (`agent.read.paths`): the configuration's check (inside the workspace, holding
// it, in `.git` or `.domaintrail`: links followed), the paths as the agent takes them when it starts, and the arguments
// of `claude` that enforce them (the directories added, the files allowed one by one, nothing of them edited, `.git` and
// `.domaintrail` denied below them, what is denied there denied as a whole). As wired with git:
// apps/dt/src/wiring/read-scope.test.ts.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CONFIG_EDIT_DENIED, claudeArguments, deniedRules, extraReadRules, READ_DENIED, UnexpressiblePath } from './claude-code.js';
import { checkReadPaths, checkTarget, readTargets, shownReadPath } from './read-paths.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A scratch directory holding `ws/` (the workspace), `specs/notes.md` and `glossary.md` beside it, by its real path. */
async function scratch(): Promise<string> {
    const d = await realpath(await mkdtemp(path.join(tmpdir(), 'domaintrail-read-paths-')));
    dirs.push(d);
    await mkdir(path.join(d, 'ws', 'docs'), { recursive: true });
    await mkdir(path.join(d, 'specs'), { recursive: true });
    await writeFile(path.join(d, 'specs', 'notes.md'), 'n');
    await writeFile(path.join(d, 'glossary.md'), 'g');
    return d;
}

const refusal = (agent: Parameters<typeof checkReadPaths>[0], dir: string): string | undefined => {
    try {
        checkReadPaths(agent, dir, (msg) => {
            throw new Error(msg);
        });
        return undefined;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
};

describe('the configuration: what may be read outside the workspace', () => {
    test('beside the workspace, a directory or a file, existing or not: accepted', async () => {
        const d = await scratch();
        const ws = path.join(d, 'ws');
        expect(
            refusal({ read: { paths: ['../specs', '../glossary.md', '../missing'] }, run: { read: { paths: [path.join(d, 'specs')] } } }, ws),
        ).toBeUndefined();
    });

    test('inside the workspace, holding it, or in .git / .domaintrail (any case), links followed: refused, naming the key', async () => {
        const d = await scratch();
        const ws = path.join(d, 'ws');
        await mkdir(path.join(d, 'other', '.Git'), { recursive: true });
        await symlink(path.join(ws, 'docs'), path.join(d, 'docs-link'));
        await symlink(d, path.join(d, 'up-link'));
        expect(refusal({ read: { paths: ['docs'] } }, ws)).toBe(
            `'agent.read.paths' names "docs": it is inside the workspace, which the AI reads already (what git ignores there stays out)`,
        );
        expect(refusal({ answer: { read: { paths: ['.'] } } }, ws)).toStartWith(`'agent.answer.read.paths' names ".": it is inside the workspace`);
        expect(refusal({ run: { read: { paths: ['..'] } } }, ws)).toBe(
            `'agent.run.read.paths' names "..": it holds the workspace: name the directories or files beside it instead`,
        );
        // a link: by what it is
        expect(refusal({ read: { paths: ['../docs-link'] } }, ws)).toContain('inside the workspace');
        expect(refusal({ read: { paths: ['../up-link'] } }, ws)).toContain('holds the workspace');
        expect(refusal({ read: { paths: ['../other/.Git'] } }, ws)).toContain('in a .git or .domaintrail directory');
        expect(refusal({ read: { paths: ['../other/.domaintrail/x'] } }, ws)).toContain('in a .git or .domaintrail directory');
    });
});

describe('where secrets live: never read', () => {
    test('/, the home directory, a place of secrets or one holding it (or inside one, but /var and ~/Library): refused', async () => {
        const d = await scratch();
        const home = path.join(d, 'home');
        await mkdir(path.join(home, '.ssh'), { recursive: true });
        await mkdir(path.join(home, 'Library', 'Mobile Documents'), { recursive: true });
        await mkdir(path.join(home, 'notes'), { recursive: true });
        const ws = path.join(d, 'ws');
        const why = (p: string): string | undefined => {
            try {
                checkReadPaths(
                    { read: { paths: [p] } },
                    ws,
                    (m) => {
                        throw new Error(m);
                    },
                    home,
                );
                return undefined;
            } catch (e) {
                return e instanceof Error ? e.message : String(e);
            }
        };
        expect(why('/')).toBe(`'agent.read.paths' names "/": it is the root of the file system`);
        expect(why('~')).toContain('it is your home directory');
        expect(why('~/.ssh')).toContain('it is or holds ~/.ssh, where secrets live');
        expect(why('~/.ssh/id_ed25519')).toContain('it is inside ~/.ssh');
        expect(why('~/.config/gh')).toContain('it is inside ~/.config');
        expect(why('~/.netrc')).toContain('~/.netrc');
        expect(why('~/Library')).toContain('it is or holds ~/Library');
        expect(why('/etc')).toContain('it is or holds /etc');
        expect(why('/etc/hosts')).toContain('it is inside /etc');
        expect(why('/private')).toContain('it is or holds');
        // here the scratch home is below /var: either way, refused
        expect(why('/var')).toContain('it is or holds');
        // inside ~/Library and /var (the temporary directories): allowed
        expect(why('~/Library/Mobile Documents')).toBeUndefined();
        expect(why('~/notes')).toBeUndefined();
        expect(why(path.join(d, 'other'))).toBeUndefined();
        // holding the (scratch) home
        expect(why(d)).toContain('it is or holds ~/');
        // by a link: by what it is
        await symlink(path.join(home, '.ssh'), path.join(d, 'keys'));
        expect(why(path.join(d, 'keys'))).toContain('~/.ssh');
        expect(readTargets([path.join(d, 'keys')], ws, home).skipped).toEqual([`${path.join(d, 'keys')} (it is or holds ~/.ssh, where secrets live)`]);
    });
});

describe('the paths when the agent starts', () => {
    test('by their real paths, each once; a missing one, or one now inside the workspace, skipped and said', async () => {
        const d = await scratch();
        const ws = path.join(d, 'ws');
        await symlink(path.join(d, 'specs'), path.join(d, 'specs-link'));
        await symlink(path.join(ws, 'docs'), path.join(d, 'docs-link'));
        const { targets, skipped } = readTargets(
            [path.join(d, 'specs'), path.join(d, 'specs-link'), path.join(d, 'glossary.md'), path.join(d, 'missing'), path.join(d, 'docs-link')],
            ws,
        );
        expect(targets).toEqual([
            { configured: path.join(d, 'specs'), real: path.join(d, 'specs'), directory: true, id: expect.stringMatching(/^\d+:\d+$/) },
            { configured: path.join(d, 'glossary.md'), real: path.join(d, 'glossary.md'), directory: false, id: expect.any(String) },
        ]);
        expect(skipped).toEqual([
            `${path.join(d, 'missing')} (not found)`,
            `${path.join(d, 'docs-link')} (it is inside the workspace, which the AI reads already (what git ignores there stays out))`,
        ]);
        expect(shownReadPath('/home/me/notes/a.md', '/home/me')).toBe('~/notes/a.md');
        expect(shownReadPath('/srv/specs', '/home/me')).toBe('/srv/specs');
    });
});

describe('each path checked again before each turn and run', () => {
    test('the same real path and the same directory or file: fine; replaced, retargeted or gone: refused', async () => {
        const d = await scratch();
        const ws = path.join(d, 'ws');
        await mkdir(path.join(d, 'other'));
        await symlink(path.join(d, 'specs'), path.join(d, 'link'));
        const { targets } = readTargets([path.join(d, 'specs'), path.join(d, 'link'), path.join(d, 'glossary.md')], ws);
        // the link names the same directory: one target
        expect(targets).toHaveLength(2);
        const [specs, glossary] = targets;
        expect(() => checkTarget(specs)).not.toThrow();
        // the directory replaced by another under its name
        await rename(path.join(d, 'specs'), path.join(d, 'specs-old'));
        await mkdir(path.join(d, 'specs'));
        expect(() => checkTarget(specs)).toThrow(
            `${path.join(d, 'specs')} changed since the agent started (it was ${path.join(d, 'specs')}, now another file or directory)`,
        );
        // a link retargeted
        const [viaLink] = readTargets([path.join(d, 'link')], ws).targets;
        await unlink(path.join(d, 'link'));
        await symlink(path.join(d, 'other'), path.join(d, 'link'));
        expect(() => checkTarget(viaLink)).toThrow(`now ${path.join(d, 'other')}`);
        // gone
        await rm(path.join(d, 'glossary.md'));
        expect(() => checkTarget(glossary)).toThrow('now missing');
    });
});

describe('the arguments of claude for what it reads outside its working directory', () => {
    const extra = { dirs: ['/srv/specs'], files: ['/home/me/glossary.md'], denied: ['/srv/specs/.env', '/srv/specs/vendor[1]'], note: 'read-only' };

    test('the directories added, the files allowed one by one, nothing of them edited, .git / .domaintrail and the denied entries denied', () => {
        expect(extraReadRules(extra)).toEqual({
            allowed: ['Read(//home/me/glossary.md)'],
            denied: [
                'Edit(//srv/specs)',
                'Edit(//srv/specs/**)',
                'Read(//srv/specs/**/.git/**)',
                'Read(//srv/specs/**/.git)',
                'Read(//srv/specs/**/.domaintrail/**)',
                'Read(//srv/specs/**/.domaintrail)',
                'Edit(//home/me/glossary.md)',
                'Read(//srv/specs/.env)',
                'Read(//srv/specs/.env/**)',
                'Read(//srv/specs/vendor\\[1\\])',
                'Read(//srv/specs/vendor\\[1\\]/**)',
            ],
        });
        // a path no rule can name refuses them all, never left out
        for (const wrong of [{ dirs: ['specs'] }, { files: ['a.md'] }, { denied: ['/srv/specs/a\nb'] }, { denied: ['/srv/specs/a\0b'] }, { note: 'a\rb' }]) {
            expect(() => extraReadRules({ dirs: [], files: [], denied: [], ...wrong })).toThrow(UnexpressiblePath);
            expect(() => claudeArguments(['Read'], 1, { extraRead: { dirs: [], files: [], denied: [], ...wrong } })).toThrow(UnexpressiblePath);
        }
        for (const wrong of ['', '/abs', '../up', 'a/../b', 'a\nb', 'a\rb', 'a\0b']) expect(() => deniedRules([wrong])).toThrow(UnexpressiblePath);
        expect(() => claudeArguments(['Read'], 1, { deniedPaths: ['ok', 'bad\nname'] })).toThrow(UnexpressiblePath);
    });

    test("the runner's: its own tools and rules kept, edits scoped to the working directory, the extra rules after", () => {
        const args = claudeArguments(['Read', 'Edit', 'Bash(dt fmt:*)'], 1, { deniedPaths: ['dist'], extraRead: extra });
        expect(args.filter((_, i) => args[i - 1] === '--add-dir')).toEqual(['/srv/specs']);
        expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('read-only');
        const denied = args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--allowedTools'));
        expect(denied).toEqual([
            ...READ_DENIED,
            ...CONFIG_EDIT_DENIED,
            'Read(./dist)',
            'Edit(./dist)',
            'Read(./dist/**)',
            'Edit(./dist/**)',
            ...extraReadRules(extra).denied,
        ]);
        expect(args.slice(args.indexOf('--allowedTools') + 1)).toEqual(['Edit(./**)', 'Bash(dt fmt:*)', 'Read(//home/me/glossary.md)']);
        // without: no flag of it
        const none = claudeArguments(['Read'], 1, {});
        expect(none).not.toContain('--add-dir');
        expect(none).not.toContain('--append-system-prompt');
    });
});
