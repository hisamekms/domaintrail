// The date and time types in generated TypeScript (ADR 0038): branded canonical text, the runtime's parsers, and the
// generated checks comparing values and literals.
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { check } from '../test-helpers.js';
import { generateTypeScript } from './typescript.js';

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const SOURCE = `context Booking {
  id BookingId: UUID
  aggregate Booking {
    id: BookingId
    visitDate: Date
    startTime: Time
    endTime: Time
    billingMonth: YearMonth
    requestedAt: Timestamp
    invariant ordered { startTime < endTime }
    invariant opensAtSix { startTime >= "06:00" }
    invariant recentMonth { billingMonth in "2020-01".."2030-12" }
    invariant sameDay { visitDate != "2026-02-28" }
  }
}`;

async function generated(): Promise<{ dir: string; code: string }> {
    const a = await check({ 'booking.dt': SOURCE });
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-temporal-'));
    dirs.push(dir);
    const files = generateTypeScript(a.model!);
    for (const f of files) await writeFile(path.join(dir, f.path), f.content);
    return { dir, code: files.find((f) => f.path === 'Booking.ts')!.content };
}

test('fields are branded canonical text, and checks compare them as text, literals in canonical form', async () => {
    const { dir, code } = await generated();
    expect(code).toContain('readonly visitDate: PlainDate;');
    expect(code).toContain('readonly startTime: PlainTime;');
    expect(code).toContain('readonly billingMonth: PlainYearMonth;');
    expect(code).toContain('readonly requestedAt: Timestamp;');
    expect(code).toContain("booking.startTime >= '06:00:00'");
    const booking = await import(path.join(dir, 'Booking.ts'));
    const valid = {
        id: 'b',
        visitDate: '2026-03-01',
        startTime: '09:00:00',
        endTime: '10:00:00',
        billingMonth: '2026-03',
        requestedAt: '2026-02-01T00:00:00.000Z',
    };
    expect(booking.checkBooking(valid)).toEqual([]);
    expect(booking.checkBooking({ ...valid, startTime: '10:00:00', endTime: '09:30:00' })).toEqual(['ordered']);
    expect(booking.checkBooking({ ...valid, startTime: '05:59:59', endTime: '09:00:00' })).toEqual(['opensAtSix']);
    expect(booking.checkBooking({ ...valid, billingMonth: '2031-01' })).toEqual(['recentMonth']);
    expect(booking.checkBooking({ ...valid, visitDate: '2026-02-28' })).toEqual(['sameDay']);
});

test('the runtime parses and normalizes, and rejects what is not a value', async () => {
    const { dir } = await generated();
    const rt = await import(path.join(dir, '_runtime.ts'));
    expect(rt.parseDate('2024-02-29')).toBe('2024-02-29');
    expect(rt.parseDate('2026-02-30')).toBeUndefined();
    expect(rt.parseTime('18:00')).toBe('18:00:00');
    expect(rt.parseTime('18:00:00.000000')).toBe('18:00:00'); // Temporal.PlainTime's text
    expect(rt.parseTime('18:00:00.5')).toBeUndefined();
    expect(rt.parseTime('18:00:00x0')).toBeUndefined(); // only a dot starts a fraction
    expect(rt.parseTimestamp('2026-11-22T09:30:00x5Z')).toBeUndefined();
    expect(rt.parseTime('24:00')).toBeUndefined();
    expect(rt.parseYearMonth('2026-12')).toBe('2026-12');
    expect(rt.parseYearMonth('2026-13')).toBeUndefined();
    expect(rt.parseTimestamp('2026-11-22T18:30:00+09:00')).toBe('2026-11-22T09:30:00.000Z');
    expect(rt.parseTimestamp('2026-11-22T09:30:00.123456789Z')).toBe('2026-11-22T09:30:00.123Z'); // Temporal.Instant's text
    expect(rt.parseTimestamp('2026-11-22 09:30:00')).toBeUndefined();
    expect(rt.timestampOf(new Date('2026-11-22T09:30:00Z'))).toBe('2026-11-22T09:30:00.000Z');
    // canonical text orders as instants do
    expect(rt.parseTimestamp('2026-11-22T08:00:00-02:00')! > rt.parseTimestamp('2026-11-22T09:30:00Z')!).toBe(true);
});

test('a domain type is made only by its parser: a plain string is not one', async () => {
    const { dir } = await generated();
    await writeFile(
        path.join(dir, 'usage.ts'),
        `import { parseDate, type PlainDate, type Timestamp } from './_runtime.js';
const d: PlainDate | undefined = parseDate('2026-11-22');
// @ts-expect-error a string is not a PlainDate
const e: PlainDate = '2026-11-22';
// @ts-expect-error a PlainDate is not a Timestamp
const t: Timestamp = d!;
void e; void t;
`,
    );
    const tsc = path.join(import.meta.dir, '..', '..', '..', '..', 'node_modules', '.bin', 'tsc');
    const r = Bun.spawnSync(
        [process.execPath, tsc, '--noEmit', '--strict', '--target', 'ES2023', '--module', 'preserve', '--moduleResolution', 'bundler', 'index.ts', 'usage.ts'],
        { cwd: dir },
    );
    expect(r.stdout.toString() + r.stderr.toString()).toBe('');
});
