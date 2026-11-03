// The ZIP writer: read back by a reader of the test's own (the end record, the central directory, each local header,
// inflated and checked against its CRC-32), and by Info-ZIP's `unzip -t` and `unzip` where it is installed.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { readZip } from '../test-helpers.js';
import { crc32, dosDateTime, zip } from './zip.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const hasUnzip = spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0;

describe('the ZIP writer', () => {
    const when = new Date(2026, 10, 3, 14, 30, 42);
    const big = Buffer.from('context Sales {\n  id OrderId: UUID\n}\n'.repeat(200));
    const entries = [
        { path: 'shop/domaintrail.jsonc', data: Buffer.from('{ "sources": ["**/*.dt"] }\n'), mtime: when },
        { path: 'shop/sales/order.dt', data: big, mtime: when },
        { path: 'shop/販売/注文.dt', data: Buffer.from('context 販売 {}\n'), mtime: when },
        { path: 'shop/empty.dtes', data: Buffer.alloc(0), mtime: when },
    ];

    test('every file reads back as written, names in UTF-8 with bit 11, large files deflated and tiny ones stored', () => {
        const read = readZip(zip(entries));
        expect(read.map((e) => e.name)).toEqual(entries.map((e) => e.path));
        for (const [i, e] of read.entries()) {
            expect(e.data.equals(Buffer.from(entries[i].data))).toBe(true);
            expect(e.flags & 0x0800).toBe(0x0800);
            expect(e.date).toBe(dosDateTime(when).date);
            expect(e.time).toBe(dosDateTime(when).time);
        }
        expect(read[1].method).toBe(8);
        expect(read[3].method).toBe(0);
    });

    test('an empty archive is the end record alone', () => {
        expect(readZip(zip([]))).toEqual([]);
        expect(zip([]).length).toBe(22);
    });

    test('names are written in NFC', () => {
        const nfd = 'shop/が.dt'.normalize('NFD');
        expect(readZip(zip([{ path: nfd, data: Buffer.from('x'), mtime: when }]))[0].name).toBe('shop/が.dt'.normalize('NFC'));
    });

    test('a path that is not relative, or a duplicate, is refused', () => {
        for (const p of ['/abs.dt', 'a/../b.dt', 'a//b.dt', './a.dt', 'a\\b.dt', '']) {
            expect(() => zip([{ path: p, data: Buffer.from('x'), mtime: when }])).toThrow();
        }
        expect(() => zip([entries[0], entries[0]])).toThrow(/Duplicate/);
    });

    test('CRC-32 and DOS time', () => {
        expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
        expect(crc32(Buffer.alloc(0))).toBe(0);
        expect(dosDateTime(new Date(2026, 10, 3, 14, 30, 42))).toEqual({ date: (46 << 9) | (11 << 5) | 3, time: (14 << 11) | (30 << 5) | 21 });
        expect(dosDateTime(new Date(1970, 0, 1))).toEqual({ date: (1 << 5) | 1, time: 0 });
    });

    test.skipIf(!hasUnzip)("Info-ZIP's unzip tests and extracts it, Japanese names included", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-zip-'));
        dirs.push(dir);
        const file = path.join(dir, 'shop-sources.zip');
        await writeFile(file, zip(entries));
        const tested = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
        expect(tested.status).toBe(0);
        expect(tested.stdout).toContain('No errors detected');
        // what it extracts (Apple's unzip lists some UTF-8 names escaped, but writes them as they are)
        const out = path.join(dir, 'out');
        expect(spawnSync('unzip', ['-q', file, '-d', out]).status).toBe(0);
        const extracted = (await readdir(out, { recursive: true, withFileTypes: true }))
            .filter((e) => e.isFile())
            .map((e) => path.relative(out, path.join(e.parentPath, e.name)).split(path.sep).join('/').normalize('NFC'));
        expect(extracted.sort()).toEqual(entries.map((e) => e.path).sort());
        expect((await readFile(path.join(out, 'shop', '販売', '注文.dt'), 'utf8')).normalize('NFC')).toBe('context 販売 {}\n');
        expect((await readFile(path.join(out, 'shop', 'sales', 'order.dt'))).equals(big)).toBe(true);
    });
});
