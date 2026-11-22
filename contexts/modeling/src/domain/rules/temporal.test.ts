import { describe, expect, test } from 'bun:test';
import { checkSales } from '../../test-helpers.js';
import { canonicalTemporal } from '../temporal.js';

const M009 = (a: Awaited<ReturnType<typeof checkSales>>) => a.diagnostics.filter((d) => d.code === 'M009').map((d) => d.message);

const model = (rule: string, extra = '') => `
  id BookingId: UUID
  primitive BirthDate: Date { value >= "1900-01-01" }
  ${extra}
  aggregate Booking {
    id: BookingId
    visitDate: Date
    startTime: Time
    endTime: Time
    billingMonth: YearMonth
    requestedAt: Timestamp
    born: BirthDate
    invariant rule { ${rule} }
  }
`;

describe('dates and times (ADR 0038)', () => {
    test('values of one type compare, with each other and with literals of the type', async () => {
        for (const rule of [
            'startTime < endTime',
            'visitDate >= "2026-01-01"',
            'startTime >= "06:00"',
            'billingMonth in "2020-01".."2030-12"',
            'requestedAt > "2026-01-01T00:00:00Z"',
            'born < "2010-01-01"',
            'visitDate == visitDate',
        ]) {
            const a = await checkSales(model(rule));
            expect({ rule, errors: a.diagnostics.filter((d) => d.severity === 'error') }).toEqual({ rule, errors: [] });
        }
    });

    test('values of different date and time types never compare: convert where the time zone is known', async () => {
        const a = await checkSales(model('visitDate < requestedAt'));
        expect(M009(a)).toEqual(["Operator '<' compares 'Date' with 'Timestamp'; values of different date and time types are not comparable."]);
        expect(a.diagnostics.find((d) => d.code === 'M009')?.hint).toContain('pass the result as a parameter of the same type');
    });

    test('a literal that is not a value of its type is M009, with the form to write', async () => {
        expect(M009(await checkSales(model('visitDate < "2026-02-30"')))).toEqual(['"2026-02-30" is not a Date: write YYYY-MM-DD.']);
        expect(M009(await checkSales(model('startTime < "24:00"')))).toEqual(['"24:00" is not a Time: write HH:MM:SS (or HH:MM).']);
        expect(M009(await checkSales(model('billingMonth == "2026-13"')))).toEqual(['"2026-13" is not a YearMonth: write YYYY-MM.']);
        expect(M009(await checkSales(model('requestedAt < "2026-01-01 09:00"')))).toHaveLength(1);
    });

    test('the types resolve as built-in types, also in a domain primitive and in parameters', async () => {
        const a = await checkSales(
            model('true', 'error Late\n  aggregate Slot { id: BookingId  create command make(id: BookingId, on: Date, at: Time, month: YearMonth) }'),
        );
        expect(a.diagnostics.filter((d) => d.code === 'M001')).toEqual([]);
        const booking = a.model!.elements.find((e) => e.name === 'Booking');
        if (booking?.kind !== 'aggregate') throw new Error('Booking missing');
        expect(booking.fields.map((f) => String(f.type.kind === 'primitive' ? f.type.name : f.type.ref))).toEqual([
            'Sales.BookingId',
            'Date',
            'Time',
            'Time',
            'YearMonth',
            'Timestamp',
            'Sales.BirthDate',
        ]);
    });
});

describe('canonical text', () => {
    test('accepts values and normalizes the forms a type allows', () => {
        expect(canonicalTemporal('Date', '2024-02-29')).toBe('2024-02-29');
        expect(canonicalTemporal('Date', '2025-02-29')).toBeUndefined();
        expect(canonicalTemporal('Time', '18:00')).toBe('18:00:00');
        expect(canonicalTemporal('Time', '23:59:59')).toBe('23:59:59');
        expect(canonicalTemporal('Time', '24:00:00')).toBeUndefined();
        expect(canonicalTemporal('YearMonth', '2026-11')).toBe('2026-11');
        expect(canonicalTemporal('YearMonth', '2026-00')).toBeUndefined();
        expect(canonicalTemporal('Timestamp', '2026-11-22T09:30:00Z')).toBe('2026-11-22T09:30:00.000Z');
        expect(canonicalTemporal('Timestamp', '2026-11-22T09:30:00.5Z')).toBe('2026-11-22T09:30:00.500Z');
        expect(canonicalTemporal('Timestamp', '2026-11-22T09:30:00+09:00')).toBeUndefined();
    });
});
<<<<<<< HEAD

describe('date and time in a time zone, and time zones (ADR 0038, stage 2)', () => {
    const zoned = (rule: string) => `
      id MeetingId: UUID
      aggregate Meeting {
        id: MeetingId
        startsAt: ZonedDateTime
        endsAt: ZonedDateTime
        wakeUpAt: DateTime
        zone: TimeZone
        invariant rule { ${rule} }
      }
    `;

    test('a ZonedDateTime orders by instant, a DateTime by text, a TimeZone only equals', async () => {
        for (const rule of [
            'startsAt < endsAt',
            'startsAt >= "2026-12-01T10:00:00+09:00[Asia/Tokyo]"',
            'wakeUpAt > "2026-12-01T06:30"',
            'zone == "asia/tokyo"',
            'zone != "UTC"',
        ]) {
            const a = await checkSales(zoned(rule));
            expect({ rule, errors: a.diagnostics.filter((d) => d.severity === 'error') }).toEqual({ rule, errors: [] });
        }
    });

    test('a zoned literal needs the offset its zone has then; a zone must exist; zones have no order', async () => {
        expect(M009(await checkSales(zoned('startsAt < "2026-07-01T10:00:00+09:00[America/New_York]"')))).toHaveLength(1);
        expect(M009(await checkSales(zoned('zone == "Mars/Base"')))).toEqual(['"Mars/Base" is not a TimeZone: write an IANA time zone ID such as Asia/Tokyo.']);
        expect(M009(await checkSales(zoned('zone < "Asia/Tokyo"')))).toEqual(["A TimeZone has no order: compare it with '==' or '!='."]);
        expect(M009(await checkSales(zoned('zone < zone')))).toEqual(["Operator '<' cannot be applied to 'TimeZone' and 'TimeZone'."]);
        expect(M009(await checkSales(zoned('startsAt < wakeUpAt')))).toEqual([
            "Operator '<' compares 'ZonedDateTime' with 'DateTime'; values of different date and time types are not comparable.",
        ]);
    });

    test('canonical text of the stage 2 types', () => {
        expect(canonicalTemporal('DateTime', '2026-12-01T06:30')).toBe('2026-12-01T06:30:00');
        expect(canonicalTemporal('ZonedDateTime', '2026-12-01T10:00:00+09:00[asia/tokyo]')).toBe('2026-12-01T10:00:00+09:00[Asia/Tokyo]');
        expect(canonicalTemporal('ZonedDateTime', '2026-07-01T10:00:00-04:00[America/New_York]')).toBe('2026-07-01T10:00:00-04:00[America/New_York]');
        expect(canonicalTemporal('ZonedDateTime', '2026-01-01T10:00:00-04:00[America/New_York]')).toBeUndefined(); // winter: -05:00
        expect(canonicalTemporal('ZonedDateTime', '2026-01-01T10:00:00Z[UTC]')).toBe('2026-01-01T10:00:00+00:00[UTC]');
        // the repeated hour of a daylight saving change: the offset tells the two times apart
        expect(canonicalTemporal('ZonedDateTime', '2026-11-01T01:30:00-04:00[America/New_York]')).toBeDefined();
        expect(canonicalTemporal('ZonedDateTime', '2026-11-01T01:30:00-05:00[America/New_York]')).toBeDefined();
        expect(canonicalTemporal('TimeZone', 'Europe/London')).toBe('Europe/London');
    });
});
=======
>>>>>>> origin/main
