// `dt check` on the knowledge items' files (ADR 0031; the plan's K2): an item about a sticky the workspace's `.dtes` lack
// is a warning (K002: exit 0), a file that does not read an error (K001: exit 1); without `knowledge/` nothing changes,
// nor with the `cloudflare` store (its items are not files of the workspace).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps, runCli } from '@domaintrail/dt';

const DT = 'context Billing {\n  id InvoiceId: UUID\n}\n';
const DTES = 'storming Issue "交付" {\n  event Requested\n}\n';

const item = (id: string, about: string[]): string =>
    [
        '---',
        `id: ${id}`,
        'version: 1',
        'title: A finding',
        'when: as_is',
        'kind: rule',
        'origin: said',
        about.length ? `about:\n${about.map((a) => `  - ${a}`).join('\n')}` : 'about: []',
        'conflictsWith: []',
        'createdAt: 2026-11-05T09:00:00.000Z',
        'updatedAt: 2026-11-05T09:00:00.000Z',
        'sources: []',
        '---',
        '',
        'A finding.',
        '',
    ].join('\n');

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function workspace(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-knowledge-check-'));
    dirs.push(dir);
    await mkdir(path.join(dir, 'knowledge'));
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
    return dir;
}

async function check(root: string): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['-r', root, 'check'], { out: (l) => out.push(l), err: (l) => err.push(l) }, cliDeps());
    return { code, out, err };
}

describe('dt check on knowledge/', () => {
    test('items about existing stickies: nothing to say; about a missing one: K002 (exit 0)', async () => {
        const fine = await check(await workspace({ 'b.dt': DT, 'i.dtes': DTES, 'knowledge/kn_00000001.md': item('kn_00000001', ['Issue.Requested']) }));
        expect(fine.code).toBe(0);
        expect(fine.out.join('\n')).not.toContain('K00');
        const gone = await check(
            await workspace({ 'b.dt': DT, 'i.dtes': DTES, 'knowledge/kn_00000001.md': item('kn_00000001', ['Issue.Requested', 'Issue.Shipped']) }),
        );
        expect(gone.code).toBe(0);
        expect(gone.out).toContainEqual(
            "knowledge/kn_00000001.md:10:1 - warning K002: The knowledge item 'kn_00000001' is about 'Issue.Shipped', which storming 'Issue' does not have.",
        );
    });

    test('a file that does not read: K001 (exit 1)', async () => {
        const r = await check(await workspace({ 'b.dt': DT, 'i.dtes': DTES, 'knowledge/kn_00000001.md': 'just text\n', 'knowledge/README.md': '# notes\n' }));
        expect(r.code).toBe(1);
        expect(r.err).toContainEqual(
            'knowledge/kn_00000001.md:1:1 - error K001: The knowledge item does not read: An item file starts with a front matter: a line "---", the fields, and a line "---".',
        );
    });

    test('an item written before titles: K001 (exit 1)', async () => {
        const untitled = item('kn_00000002', ['Issue.Requested']).replace('title: A finding\n', '');
        const r = await check(await workspace({ 'b.dt': DT, 'i.dtes': DTES, 'knowledge/kn_00000002.md': untitled }));
        expect(r.code).toBe(1);
        expect(r.err).toContainEqual("knowledge/kn_00000002.md:2:1 - error K001: The knowledge item does not read: 'title' is missing.");
    });

    test("with the 'cloudflare' store, the workspace's knowledge/ is not checked", async () => {
        const config = JSON.stringify({ knowledge: { store: 'cloudflare', project: 'shop', url: 'https://knowledge.example.com' } });
        const r = await check(await workspace({ 'domaintrail.jsonc': config, 'b.dt': DT, 'i.dtes': DTES, 'knowledge/kn_00000001.md': 'just text\n' }));
        expect(r.code).toBe(0);
        expect([...r.out, ...r.err].join('\n')).not.toContain('K00');
    });
});
