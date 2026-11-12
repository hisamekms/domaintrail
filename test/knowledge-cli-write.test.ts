import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps, runCli } from '@domaintrail/dt';
import { Knowledge } from '@domaintrail/knowledge';

const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workspace() {
    const root = await mkdtemp(path.join(tmpdir(), 'dt-knowledge-write-'));
    roots.push(root);
    await mkdir(path.join(root, 'knowledge'));
    const file = path.join(root, 'knowledge', 'kn_00000001.md');
    await writeFile(
        file,
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
    return { root, file };
}

async function run(root: string, args: string[], env?: Record<string, string>) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
        ['-r', root, 'knowledge', ...args],
        { out: (line) => out.push(line), err: (line) => err.push(line) },
        { ...cliDeps(), ...(env && { env }) },
    );
    return { code, out: out.join('\n'), err: err.join('\n') };
}

async function editor(root: string, code: string) {
    const file = path.join(root, 'editor.js');
    await writeFile(file, `#!/usr/bin/env node\nconst fs = require('node:fs');\n${code}\n`);
    await chmod(file, 0o755);
    return file;
}

test('retire, unretire, delete confirmation, and restore', async () => {
    const { root } = await workspace();
    expect((await run(root, ['retire', 'kn_00000001', '--reason', 'obsolete', '--actor', 'alice'])).code).toBe(0);
    expect((await run(root, ['show', 'kn_00000001'])).out).toContain('[retired]');
    expect((await run(root, ['retire', 'kn_00000001', '--json'])).code).toBe(1);
    expect((await run(root, ['unretire', 'kn_00000001'])).code).toBe(0);
    expect((await run(root, ['unretire', 'kn_00000001'])).code).toBe(1);
    const declined = await run(root, ['delete', 'kn_00000001']);
    expect(declined.code).toBe(1);
    expect(declined.err).toContain('--yes');
    expect((await run(root, ['show', 'kn_00000001'])).code).toBe(0);
    const removed = await run(root, ['delete', 'kn_00000001', '--yes']);
    expect(removed.out).toContain('kn_00000001 (First finding)');
    expect((await run(root, ['show', 'kn_00000001'])).code).toBe(1);
    expect((await run(root, ['restore', 'kn_00000001'])).code).toBe(0);
    expect((await run(root, ['show', 'kn_00000001'])).code).toBe(0);
});

test('edit validates content and preserves existing item fields', async () => {
    const { root, file } = await workspace();
    await writeFile(
        file,
        (await readFile(file, 'utf8'))
            .replace('conflictsWith: []', 'conflictsWith:\n  - kn_00000002')
            .replace('sources: []', 'sources:\n  - session: s1\n    message: m1\n    at: 2026-11-05T09:00:00.000Z\n    quote: Original quote'),
    );
    const change = await editor(
        root,
        `const p = process.argv[2]; const item = JSON.parse(fs.readFileSync(p, 'utf8')); item.title = 'Changed finding'; item.text = 'Updated detail'; item.labels.kind = 'decision'; item.about = ['Issue.Requested', 'Issue.Other']; fs.writeFileSync(p, JSON.stringify(item));`,
    );
    const edited = await run(root, ['edit', 'kn_00000001', '--json'], { EDITOR: change });
    expect(edited.code).toBe(0);
    expect(JSON.parse(edited.out).version).toBe(2);
    const saved = await readFile(file, 'utf8');
    expect(saved).toContain('Changed finding');
    expect(saved).toContain('Issue.Other');
    expect(saved).toContain('quote: "Original quote"');
    expect(saved).toContain('kn_00000002');
    const invalid = await editor(
        root,
        `const p = process.argv[2]; const item = JSON.parse(fs.readFileSync(p, 'utf8')); item.title = ' '; fs.writeFileSync(p, JSON.stringify(item));`,
    );
    const failed = await run(root, ['edit', 'kn_00000001', '--json'], { EDITOR: invalid });
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.out).error).toContain('Title');
    expect(await readFile(file, 'utf8')).toBe(saved);
});

test('edit rejects a stale version without overwriting the concurrent write', async () => {
    const { root, file } = await workspace();
    const change = await editor(
        root,
        `const p = process.argv[2]; const item = JSON.parse(fs.readFileSync(p, 'utf8')); item.title = 'Stale edit'; fs.writeFileSync(p, JSON.stringify(item)); const store = process.env.KNOWLEDGE_FILE; const body = fs.readFileSync(store, 'utf8').replace('version: 1', 'version: 2').replace('First finding', 'Concurrent finding'); fs.writeFileSync(store, body);`,
    );
    const edited = await run(root, ['edit', 'kn_00000001', '--json'], { EDITOR: change, KNOWLEDGE_FILE: file });
    expect(edited.code).toBe(1);
    expect(JSON.parse(edited.out).error).toContain('changed while editing');
    const saved = await readFile(file, 'utf8');
    expect(saved).toContain('Concurrent finding');
    expect(saved).not.toContain('Stale edit');
});

test('saving identical content creates no version or audit record', async () => {
    const { root, file } = await workspace();
    const unchangedFile = await readFile(file, 'utf8');
    const noop = await editor(root, '// Save without changing the JSON document.');
    const edited = await run(root, ['edit', 'kn_00000001'], { EDITOR: noop });
    expect(edited.code).toBe(0);
    expect(edited.out).toContain('unchanged at version 1');
    expect(await readFile(file, 'utf8')).toBe(unchangedFile);
    const deps = cliDeps();
    const config = await deps.loadConfig({ start: root });
    const opened = await deps.openKnowledgeStore!(config, undefined);
    if (!opened.ok) throw new Error(opened.error.message);
    expect((await opened.value.store.audit(opened.value.project, {})).items).toEqual([]);
});

test('proposal list and input errors', async () => {
    const { root } = await workspace();
    expect((await run(root, ['proposals'])).out).toBe('No open proposals.');
    expect((await run(root, ['approve', 'bad', '--json'])).code).toBe(1);
    const missingProposal = await run(root, ['dismiss', 'rp_00000001', '--json']);
    expect(missingProposal.code).toBe(1);
    expect(JSON.parse(missingProposal.out).error).toBe('Proposal rp_00000001 was not found.');
    expect((await run(root, ['retire', 'kn_00000001', '--replaced-by', 'kn_00000002', '--json'])).code).toBe(1);
    expect((await run(root, ['retire', 'kn_00000002'])).err).toBe('Knowledge item kn_00000002 was not found.');
    expect((await run(root, ['unretire', 'kn_00000001'])).err).toBe('Knowledge item is not retired.');
});

test('Cloudflare writes require an actor and prefix the supplied name', async () => {
    const { root } = await workspace();
    const base = cliDeps();
    const filesConfig = await base.loadConfig({ start: root });
    const opened = await base.openKnowledgeStore!(filesConfig, undefined);
    if (!opened.ok) throw new Error(opened.error.message);
    const cloudConfig = {
        ...filesConfig,
        knowledge: {
            store: 'cloudflare' as const,
            project: filesConfig.knowledge.project,
            projectFrom: 'config' as const,
            url: 'http://127.0.0.1:9876',
            extraction: filesConfig.knowledge.extraction,
        },
    };
    let writes = 0;
    let seenActor = '';
    const store = {
        ...opened.value.store,
        retire: async (...args: Parameters<typeof opened.value.store.retire>) => {
            writes += 1;
            seenActor = args[3];
            return opened.value.store.retire(...args);
        },
    };
    const deps = {
        ...base,
        trust: undefined,
        loadConfig: async () => cloudConfig,
        openKnowledgeStore: async () => ({ ok: true as const, value: { store, project: cloudConfig.knowledge.project } }),
    };
    const invoke = async (args: string[]) => {
        const out: string[] = [];
        const code = await runCli(['-r', root, 'knowledge', 'retire', 'kn_00000001', ...args], { out: (line) => out.push(line), err: () => {} }, deps);
        return { code, output: out.join('\n') };
    };
    const missing = await invoke(['--json']);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.output).error).toContain('--actor');
    expect(writes).toBe(0);
    expect((await invoke(['--actor', 'alice'])).code).toBe(0);
    expect(seenActor).toBe('cli:alice');
});

test('approve and dismiss open proposals', async () => {
    const { root, file } = await workspace();
    const other = path.join(root, 'knowledge', 'kn_00000002.md');
    await writeFile(other, (await readFile(file, 'utf8')).replaceAll('kn_00000001', 'kn_00000002').replace('First finding', 'Second finding'));
    const base = cliDeps();
    const config = await base.loadConfig({ start: root });
    const opened = await base.openKnowledgeStore!(config, undefined);
    if (!opened.ok) throw new Error(opened.error.message);
    const valid = <T>(made: { ok: true; value: T } | { ok: false }): T => {
        if (!made.ok) throw new Error('invalid test fixture');
        return made.value;
    };
    const candidate = (id: string, message: string) => ({
        item: valid(Knowledge.makeKnowledgeItemId(id)),
        action: 'retire' as const,
        reason: 'obsolete' as const,
        explanation: valid(Knowledge.makeReason('No longer applies')),
        evidence: [
            {
                kind: 'Said' as const,
                session: valid(Knowledge.makeSessionRef('s1')),
                message: valid(Knowledge.makeMessageRef(message)),
                quote: valid(Knowledge.makeQuote('No longer applies')),
            },
        ] as const,
        proposedBy: { kind: 'Review' as const, review: valid(Knowledge.makeReviewRef('review-1')) },
    });
    const first = await opened.value.store.propose(opened.value.project, candidate('kn_00000001', 'm1'));
    const second = await opened.value.store.propose(opened.value.project, candidate('kn_00000002', 'm2'));
    if (!first.ok || !second.ok) throw new Error('proposals not made');
    expect((await run(root, ['proposals'])).out).toContain(first.value.id);
    expect((await run(root, ['approve', first.value.id, '--actor', 'alice'])).code).toBe(0);
    expect((await run(root, ['show', 'kn_00000001'])).out).toContain('[retired]');
    expect((await run(root, ['dismiss', second.value.id, '--actor', 'bob'])).code).toBe(0);
    expect((await run(root, ['proposals', '--json'])).out).toBe('[]');
});

test('delete confirmation identifies the item before deciding', async () => {
    const { root } = await workspace();
    let question = '';
    const deps = {
        ...cliDeps(),
        confirm: async (prompt: string) => {
            question = prompt;
            return false;
        },
    };
    const code = await runCli(['-r', root, 'knowledge', 'delete', 'kn_00000001'], { out: () => {}, err: () => {} }, deps);
    expect(code).toBe(1);
    expect(question).toContain('kn_00000001 (First finding)');
    expect((await run(root, ['show', 'kn_00000001'])).code).toBe(0);
});

test('the built Node CLI opens an editor and saves an edit', async () => {
    const { root, file } = await workspace();
    const change = await editor(
        root,
        `const p = process.argv[2]; const item = JSON.parse(fs.readFileSync(p, 'utf8')); item.text = 'Edited by Node CLI'; fs.writeFileSync(p, JSON.stringify(item));`,
    );
    const child = Bun.spawn(['node', path.resolve('dist/dt.js'), '-r', root, 'knowledge', 'edit', 'kn_00000001'], {
        cwd: process.cwd(),
        env: { ...process.env, EDITOR: change },
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('updated to version 2');
    expect(await readFile(file, 'utf8')).toContain('Edited by Node CLI');
});
