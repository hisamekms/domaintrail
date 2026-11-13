import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps, runCli } from '@domaintrail/dt';

const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'dt-knowledge-cli-'));
    roots.push(root);
    await mkdir(path.join(root, 'knowledge'));
    await writeFile(
        path.join(root, 'knowledge', 'kn_00000001.md'),
        [
            '---',
            'id: kn_00000001',
            'version: 1',
            'title: First finding',
            'when: as_is',
            'kind: rule',
            'origin: said',
            'about:',
            '  - Issue.Requested',
            'conflictsWith: []',
            'createdAt: 2026-11-05T09:00:00.000Z',
            'updatedAt: 2026-11-05T09:00:00.000Z',
            'sources: []',
            '---',
            '',
            'A finding about delivery.',
            '',
        ].join('\n'),
    );
    return root;
}

async function run(root: string, args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['-r', root, 'knowledge', ...args], { out: (line) => out.push(line), err: (line) => err.push(line) }, cliDeps());
    return { code, out, err };
}

test('list filters, JSON page, and human output', async () => {
    const root = await workspace();
    const page = await run(root, ['list', '--query', 'delivery', '--about', 'Issue.Requested', '--limit', '1', '--json']);
    expect(page.code).toBe(0);
    expect(page.err).toEqual([]);
    expect(JSON.parse(page.out.join('\n')).items[0].id).toBe('kn_00000001');
    expect((await run(root, ['list', '--about', 'Issue.Other'])).out).toEqual(['No knowledge items found.']);
    expect((await run(root, ['list'])).out.join('\n')).toContain('First finding');
    expect(JSON.parse((await run(root, ['list', '--when', 'as_is', '--kind', 'rule', '--origin', 'said', '--json'])).out.join('\n')).items).toHaveLength(1);
    expect(JSON.parse((await run(root, ['list', '--when', 'to_be', '--json'])).out.join('\n')).items).toHaveLength(0);
    expect(JSON.parse((await run(root, ['list', '--retired', 'only', '--json'])).out.join('\n')).items).toHaveLength(0);
});

test('list returns a cursor for the next page', async () => {
    const root = await workspace();
    const first = await Bun.file(path.join(root, 'knowledge', 'kn_00000001.md')).text();
    await writeFile(path.join(root, 'knowledge', 'kn_00000002.md'), first.replaceAll('kn_00000001', 'kn_00000002').replace('First finding', 'Second finding'));
    const page = JSON.parse((await run(root, ['list', '--limit', '1', '--json'])).out.join('\n'));
    expect(page.items).toHaveLength(1);
    expect(page.next).toBeString();
    const next = JSON.parse((await run(root, ['list', '--limit', '1', '--cursor', page.next, '--json'])).out.join('\n'));
    expect(next.items).toHaveLength(1);
    expect(next.items[0].id).not.toBe(page.items[0].id);
});

test('show item and requested history', async () => {
    const root = await workspace();
    const shown = await run(root, ['show', 'kn_00000001', '--history', '--json']);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.out.join('\n')).item.content.text).toBe('A finding about delivery.');
    expect((await run(root, ['show', 'kn_00000001', '--history'])).out.join('\n')).toContain('History: 0 previous version(s)');
    expect((await run(root, ['show', 'kn_00000001'])).out.join('\n')).toContain('Sources: 0');
});

test('invalid inputs and missing items return errors', async () => {
    const root = await workspace();
    for (const args of [
        ['list', '--limit', '0', '--json'],
        ['list', '--about', 'bad', '--json'],
        ['list', '--when', 'later', '--json'],
        ['list', '--perspective', '', '--json'],
        ['show', 'bad', '--json'],
        ['show', 'kn_00000002', '--json'],
    ]) {
        const result = await run(root, args);
        expect(result.code).toBe(1);
        expect(JSON.parse(result.out.join('\n')).error).toBeString();
        expect(result.err).toEqual([]);
    }
});

test('invalid input is rejected before the store opens', async () => {
    const root = await workspace();
    let opened = false;
    const deps = {
        ...cliDeps(),
        openKnowledgeStore: async () => {
            opened = true;
            throw new Error('store should stay closed');
        },
    };
    const out: string[] = [];
    const code = await runCli(['-r', root, 'knowledge', 'list', '--limit', '0', '--json'], { out: (line) => out.push(line), err: () => {} }, deps);
    expect(code).toBe(1);
    expect(JSON.parse(out.join('\n')).error).toContain('--limit');
    expect(opened).toBe(false);
});

test('unapproved cloudflare settings do not send the service token', async () => {
    const root = await workspace();
    await writeFile(
        path.join(root, 'domaintrail.jsonc'),
        JSON.stringify({ knowledge: { store: 'cloudflare', project: 'shop', url: 'https://unapproved.example.test' } }),
    );
    const deps = {
        ...cliDeps(),
        trust: { approved: async () => undefined, approve: async () => {} },
    };
    const out: string[] = [];
    const code = await runCli(['-r', root, 'knowledge', 'list', '--json'], { out: (line) => out.push(line), err: () => {} }, deps);
    expect(code).toBe(1);
    expect(JSON.parse(out.join('\n')).error).toContain('not approved');
});
