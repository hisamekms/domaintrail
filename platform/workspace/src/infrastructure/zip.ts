// A small ZIP writer (PKWARE APPNOTE 6.3, no ZIP64): local headers, the central directory and its end record. Every
// name is flagged UTF-8 (general purpose bit 11), so that Japanese names open as written in macOS's Archive Utility,
// Windows and Info-ZIP's `unzip`. Each entry is deflated (`node:zlib`'s raw DEFLATE) unless storing it is smaller.
import { deflateRawSync } from 'node:zlib';

/** One file of an archive. */
export interface ZipEntry {
    /** Its path in the archive, `/`-separated, relative (no leading `/`, no `.` or `..` part). */
    readonly path: string;
    readonly data: Uint8Array;
    /** Its modification time, written as a DOS date and time (local time, 2-second resolution, 1980 to 2107). */
    readonly mtime: Date;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
/** General purpose bit 11: the name (and comment) are UTF-8. */
const UTF8_FLAG = 0x0800;
const STORED = 0;
const DEFLATED = 8;
/** Version made by: Unix (3, so that the external attributes carry a mode), spec 2.0. */
const MADE_BY = (3 << 8) | 20;
/** External attributes: a regular file, rw-r--r--. */
const FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;
/** What an archive without ZIP64 can count and address. */
const MAX_ENTRIES = 0xffff;
const MAX_OFFSET = 0xffffffff;

const CRC_TABLE: Uint32Array = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

/** The CRC-32 (ISO 3309, as ZIP and gzip use it) of `data`. */
export function crc32(data: Uint8Array): number {
    let c = 0xffffffff;
    for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** `date` as a DOS date and time (local time), clamped to what they can hold (1980-01-01 to 2107-12-31). */
export function dosDateTime(date: Date): { date: number; time: number } {
    const year = date.getFullYear();
    if (Number.isNaN(year) || year < 1980) return { date: (1 << 5) | 1, time: 0 };
    if (year > 2107) return { date: (127 << 9) | (12 << 5) | 31, time: (23 << 11) | (59 << 5) | 29 };
    return {
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    };
}

/** Whether `p` is a path an archive may hold: relative, `/`-separated, without empty, `.` or `..` parts. */
const isEntryPath = (p: string): boolean => p !== '' && !p.includes('\\') && !p.split('/').some((s) => s === '' || s === '.' || s === '..');

/**
 * The ZIP archive of `entries`, in their order. Names are written in Unicode NFC (as Windows and most tools expect);
 * a duplicate name, a path that is not relative, or an archive that would need ZIP64 (more than 65,535 entries or 4 GiB)
 * is an error.
 */
export function zip(entries: readonly ZipEntry[]): Buffer {
    if (entries.length > MAX_ENTRIES) throw new Error(`Too many files for a ZIP archive: ${entries.length}`);
    const names = new Set<string>();
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = entry.path.normalize('NFC');
        if (!isEntryPath(name)) throw new Error(`Not a relative path for a ZIP archive: '${entry.path}'`);
        if (names.has(name)) throw new Error(`Duplicate path in a ZIP archive: '${name}'`);
        names.add(name);
        const nameBytes = Buffer.from(name, 'utf8');
        const deflated = deflateRawSync(entry.data);
        const stored = deflated.length >= entry.data.length;
        const body = stored ? Buffer.from(entry.data) : deflated;
        const method = stored ? STORED : DEFLATED;
        const needed = stored ? 10 : 20;
        const crc = crc32(entry.data);
        const { date, time } = dosDateTime(entry.mtime);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(LOCAL_HEADER, 0);
        local.writeUInt16LE(needed, 4);
        local.writeUInt16LE(UTF8_FLAG, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(CENTRAL_HEADER, 0);
        central.writeUInt16LE(MADE_BY, 4);
        central.writeUInt16LE(needed, 6);
        central.writeUInt16LE(UTF8_FLAG, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(entry.data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        // extra field, comment, disk number start and internal attributes: none, 0
        central.writeUInt32LE(FILE_ATTRIBUTES, 38);
        central.writeUInt32LE(offset, 42);

        locals.push(local, nameBytes, body);
        centrals.push(central, nameBytes);
        offset += local.length + nameBytes.length + body.length;
        if (offset > MAX_OFFSET) throw new Error('The files are too large for a ZIP archive (4 GiB)');
    }
    const directory = Buffer.concat(centrals);
    if (offset + directory.length > MAX_OFFSET) throw new Error('The files are too large for a ZIP archive (4 GiB)');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
    // this disk and the directory's disk: 0
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    // comment length: 0
    return Buffer.concat([...locals, directory, end]);
}
