// dt export sources through the CLI: the archive's default name, -o, -o - and a workspace without sources; and the
// archive of examples/shop unzipped elsewhere, where `dt check` passes. What the archive holds and its ZIP format:
// platform/workspace/src/infrastructure/source-archive.test.ts and zip.test.ts.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps, runCli } from '@domaintrail/dt';
import { tempCopyOfExamples } from './helpers.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const scratch = async (): Promise<string> => {
    const d = await mkdtemp(path.join(tmpdir(), 'domaintrail-export-'));
    dirs.push(d);
    return d;
};

async function run(...args: string[]): Promise<{ code: number; out: string[]; err: string[]; bytes: Uint8Array[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const bytes: Uint8Array[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), bytes: async (b: Uint8Array) => void bytes.push(b) };
    const code = await runCli(args, io, cliDeps());
    return { code, out, err, bytes };
}

/** The names in the central directory of a ZIP archive. */
function zipNames(archive: Buffer): string[] {
    const end = archive.length - 22;
    expect(archive.readUInt32LE(end)).toBe(0x06054b50);
    const names: string[] = [];
    let at = archive.readUInt32LE(end + 16);
    for (let i = 0; i < archive.readUInt16LE(end + 10); i++) {
        const length = archive.readUInt16LE(at + 28);
        names.push(archive.subarray(at + 46, at + 46 + length).toString('utf8'));
        at += 46 + length + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
    }
    return names;
}

const SHOP = [
    'domaintrail.jsonc',
    'billing/context.dt',
    'billing/invoice.dt',
    'common/context.dt',
    'sales/context.dt',
    'sales/customer.dt',
    'sales/order.dt',
    'stormings/order-to-cash.dtes',
    'stormings/returns.dtes',
];

describe('dt export sources', () => {
    test('writes <workspace>-sources.zip in the current directory by default, the sources below the workspace folder', async () => {
        const copy = await tempCopyOfExamples();
        dirs.push(copy);
        const root = path.join(await scratch(), 'shop');
        await cp(copy, root, { recursive: true });
        await writeFile(path.join(root, 'domaintrail.local.jsonc'), '{}\n');
        const cwd = await scratch();
        const before = process.cwd();
        process.chdir(cwd);
        try {
            const r = await run('-r', root, 'export', 'sources');
            expect(r).toMatchObject({ code: 0, out: ['9 file(s) written to shop-sources.zip'], err: [] });
            expect(zipNames(await readFile(path.join(cwd, 'shop-sources.zip')))).toEqual(SHOP.map((f) => `shop/${f}`));
        } finally {
            process.chdir(before);
        }
    });

    test('-o names the file; -o - writes the archive to stdout and the summary to stderr', async () => {
        const root = await tempCopyOfExamples();
        dirs.push(root);
        const file = path.join(await scratch(), 'model.zip');
        const written = await run('-r', root, 'export', 'sources', '-o', file);
        expect(written).toMatchObject({ code: 0, err: [] });
        expect(written.out).toEqual([`9 file(s) written to ${file}`]);
        const piped = await run('-r', root, 'export', 'sources', '-o', '-');
        expect(piped).toMatchObject({ code: 0, out: [], err: ['9 file(s) written to stdout'] });
        expect(Buffer.concat(piped.bytes).equals(await readFile(file))).toBe(true);
        expect(zipNames(await readFile(file)).map((n) => n.slice(n.indexOf('/') + 1))).toEqual(SHOP);
    });

    test('a workspace without sources (a config file alone) is an error, and nothing is written', async () => {
        const root = await scratch();
        await writeFile(path.join(root, 'domaintrail.jsonc'), '{}\n');
        await writeFile(path.join(root, 'README.md'), 'nothing\n');
        const file = path.join(root, 'out.zip');
        const r = await run('-r', root, 'export', 'sources', '-o', file);
        expect(r.code).toBe(1);
        expect(r.err[0]).toMatch(/^No \.dt or \.dtes files found under /);
        expect(await readFile(file).catch(() => undefined)).toBeUndefined();
    });

    test.skipIf(spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status !== 0)('unzipped elsewhere, the sources check as they did', async () => {
        const root = await tempCopyOfExamples();
        dirs.push(root);
        const out = await scratch();
        const file = path.join(out, 'shop.zip');
        expect((await run('-r', root, 'export', 'sources', '-o', file)).code).toBe(0);
        expect(spawnSync('unzip', ['-q', file, '-d', path.join(out, 'x')]).status).toBe(0);
        const top = path.join(out, 'x', path.basename(root));
        expect(await run('-r', top, 'check')).toMatchObject({ code: 0, out: ['8 file(s) checked: 0 error(s), 0 warning(s).'] });
    });
});
