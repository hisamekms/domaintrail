// The workspace adapter of the session's snapshots (packages/workspace/src/infrastructure/snapshot.ts): it reads the
// sources `dt check` reads, reports symbolic links instead of following them, and writes a snapshot back only inside
// the root, never through a link, and only over the sources it expects.
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createWorkspaceSnapshot } from '@domaintrail/workspace/infrastructure/snapshot';

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function workspace(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-snapshot-'));
    dirs.push(root);
    for (const [file, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), text);
    }
    return root;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('workspace snapshots', () => {
    test('read gives the sources dt check reads, with their hashes, and the links it did not follow', async () => {
        const root = await workspace({
            'a.dt': 'context A {}',
            'es/b.dtes': 'storming B {}',
            'notes.md': '# not a source',
            'ignored/c.dt': 'context C {}',
            'node_modules/x/d.dt': 'context D {}',
            '.gitignore': 'ignored/\n',
        });
        await symlink(path.join(root, 'a.dt'), path.join(root, 'link.dt'));
        await symlink(path.join(root, 'es'), path.join(root, 'linked-dir'));
        const scan = await createWorkspaceSnapshot(root).read();
        expect(scan.files.map((f) => [f.path, f.hash])).toEqual([
            ['a.dt', sha('context A {}')],
            ['es/b.dtes', sha('storming B {}')],
        ]);
        expect(scan.symlinks).toEqual(['link.dt', 'linked-dir']);
    });

    test('write makes the sources exactly the snapshot, through temporary files, over the expected sources only', async () => {
        const root = await workspace({ 'a.dt': 'context A {}', 'gone.dt': 'context Gone {}' });
        const snapshots = createWorkspaceSnapshot(root);
        const expected = (await snapshots.read()).files.map((f) => ({ path: f.path, hash: f.hash }));
        const r = await snapshots.write(
            [
                { path: 'a.dt', bytes: bytes('context A2 {}') },
                { path: 'new/deep/b.dtes', bytes: bytes('storming B {}') },
            ],
            expected,
        );
        expect(r).toEqual({ ok: true });
        expect((await snapshots.read()).files.map((f) => f.path)).toEqual(['a.dt', 'new/deep/b.dtes']);
        expect(await readFile(path.join(root, 'a.dt'), 'utf8')).toBe('context A2 {}');
        expect((await readdir(root)).filter((f) => f.endsWith('.tmp'))).toEqual([]);

        // the sources changed since `expected`: nothing is written
        expect(await snapshots.write([{ path: 'a.dt', bytes: bytes('context A3 {}') }], expected)).toEqual({
            ok: false,
            error: { type: 'ExternalChangesSinceSnapshot', paths: ['a.dt', 'gone.dt', 'new/deep/b.dtes'] },
        });
        expect(await readFile(path.join(root, 'a.dt'), 'utf8')).toBe('context A2 {}');
    });

    test('write refuses paths outside the root or not sources, and symbolic links on the way', async () => {
        const outside = await workspace({});
        const root = await workspace({ 'a.dt': 'context A {}' });
        const snapshots = createWorkspaceSnapshot(root);
        const expected = (await snapshots.read()).files.map((f) => ({ path: f.path, hash: f.hash }));
        for (const p of ['../x.dt', '/etc/x.dt', 'a/../../x.dt', 'notes.md', '.domaintrail/x.dt', 'a\\b.dt', '']) {
            expect(await snapshots.write([{ path: p, bytes: bytes('x') }], expected)).toEqual({ ok: false, error: { type: 'PathOutsideRoot', path: p } });
        }
        await symlink(outside, path.join(root, 'out'));
        expect(await snapshots.write([{ path: 'out/x.dt', bytes: bytes('context X {}') }], expected)).toEqual({
            ok: false,
            error: { type: 'SymlinkInWorkspace', path: 'out' },
        });
        expect(await readdir(outside)).toEqual([]);
        await rm(path.join(root, 'out'));
        await symlink(path.join(outside, 'y.dt'), path.join(root, 'y.dt'));
        expect(await snapshots.write([{ path: 'a.dt', bytes: bytes('context B {}') }], expected)).toEqual({
            ok: false,
            error: { type: 'SymlinkInWorkspace', path: 'y.dt' },
        });
        expect((await lstat(path.join(root, 'y.dt'))).isSymbolicLink()).toBe(true);
        expect(await readFile(path.join(root, 'a.dt'), 'utf8')).toBe('context A {}');
    });
});
