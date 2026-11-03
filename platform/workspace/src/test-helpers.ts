// Helpers of the workspace's unit tests (counted as test code by the bundle and the layer rules).
import { expect } from 'bun:test';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { crc32 } from './infrastructure/zip.js';
import type { SourceSelection } from './ports.js';

const IGNORED = new Set(['node_modules', '.git', '.domaintrail']);

/**
 * A selection as the app gives it, without the configuration's globs (the analysis's `sourceSelection`): the files
 * `matches` takes, by `/`-separated path, never under `node_modules`, `.git` or `.domaintrail`. By default every `.dt`
 * and `.dtes` file.
 */
export function selection(matches: (rel: string) => boolean = (rel) => /\.dt(es)?$/.test(rel), respectGitignore = true): SourceSelection {
    return {
        matches: (rel) => {
            const p = rel.split(path.sep).join('/');
            return !p.split('/').some((seg) => IGNORED.has(seg)) && matches(p);
        },
        ignoredDirs: IGNORED,
        respectGitignore,
    };
}

/** One entry as the reader found it in the central directory and its local header. */
interface ReadEntry {
    name: string;
    flags: number;
    method: number;
    date: number;
    time: number;
    data: Buffer;
}

/** Reads `archive` from its central directory, checking the local headers against it and each file's CRC-32. */
export function readZip(archive: Buffer): ReadEntry[] {
    const end = archive.length - 22;
    expect(archive.readUInt32LE(end)).toBe(0x06054b50);
    const count = archive.readUInt16LE(end + 10);
    const size = archive.readUInt32LE(end + 12);
    let at = archive.readUInt32LE(end + 16);
    expect(at + size).toBe(end);
    const entries: ReadEntry[] = [];
    for (let i = 0; i < count; i++) {
        expect(archive.readUInt32LE(at)).toBe(0x02014b50);
        const flags = archive.readUInt16LE(at + 8);
        const method = archive.readUInt16LE(at + 10);
        const time = archive.readUInt16LE(at + 12);
        const date = archive.readUInt16LE(at + 14);
        const crc = archive.readUInt32LE(at + 16);
        const compressed = archive.readUInt32LE(at + 20);
        const uncompressed = archive.readUInt32LE(at + 24);
        const nameLength = archive.readUInt16LE(at + 28);
        const extra = archive.readUInt16LE(at + 30);
        const comment = archive.readUInt16LE(at + 32);
        const offset = archive.readUInt32LE(at + 42);
        const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
        at += 46 + nameLength + extra + comment;

        expect(archive.readUInt32LE(offset)).toBe(0x04034b50);
        expect(archive.readUInt16LE(offset + 6)).toBe(flags);
        expect(archive.readUInt16LE(offset + 8)).toBe(method);
        expect(archive.readUInt32LE(offset + 14)).toBe(crc);
        const localName = archive.readUInt16LE(offset + 26);
        const start = offset + 30 + localName + archive.readUInt16LE(offset + 28);
        expect(archive.subarray(offset + 30, offset + 30 + localName).toString('utf8')).toBe(name);
        const body = archive.subarray(start, start + compressed);
        const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
        expect(data.length).toBe(uncompressed);
        expect(crc32(data)).toBe(crc);
        entries.push({ name, flags, method, date, time, data });
    }
    return entries;
}
