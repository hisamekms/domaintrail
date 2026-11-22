// The date and time types of the DSL (ADR 0038): their canonical text, which every target writes and reads, and the
// check of a literal written for one of them. A literal is canonical text, or a form the type accepts and normalizes
// (`HH:MM` for a `Time`, a `Timestamp` without milliseconds, a time zone in any case).
import type { PrimitiveName } from './model.js';

/**
 * The date and time types: values on a calendar or clock (no time zone), the instant, a date and time in a time zone,
 * and the time zone.
 */
export const TEMPORAL_TYPES = ['Date', 'Time', 'YearMonth', 'Timestamp', 'DateTime', 'ZonedDateTime', 'TimeZone'] as const satisfies readonly PrimitiveName[];
export type TemporalName = (typeof TEMPORAL_TYPES)[number];

export const isTemporal = (name: string | undefined): name is TemporalName => (TEMPORAL_TYPES as readonly string[]).includes(name ?? '');

/** The date and time types with an order: all but `TimeZone`; `ZonedDateTime` orders by instant. */
export const isOrderedTemporal = (name: string | undefined): boolean => isTemporal(name) && name !== 'TimeZone';

/** The canonical form of each type, in words (for messages). */
export const TEMPORAL_FORM: Readonly<Record<TemporalName, string>> = {
    Date: 'YYYY-MM-DD',
    Time: 'HH:MM:SS (or HH:MM)',
    YearMonth: 'YYYY-MM',
    Timestamp: 'YYYY-MM-DDTHH:MM:SS.sssZ (UTC; milliseconds may be left out)',
    DateTime: 'YYYY-MM-DDTHH:MM:SS (or YYYY-MM-DDTHH:MM)',
    ZonedDateTime: 'YYYY-MM-DDTHH:MM:SS±HH:MM[Zone], with the offset the zone has then',
    TimeZone: 'an IANA time zone ID such as Asia/Tokyo',
};

const daysIn = (year: number, month: number): number =>
    month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

const validDate = (y: number, m: number, d: number): boolean => y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
const validTime = (h: number, mi: number, s: number): boolean => h <= 23 && mi <= 59 && s <= 59;

/** The IANA ID of a time zone as the time zone data spells it (`asia/tokyo` is `Asia/Tokyo`), or `undefined`. */
export function canonicalZone(text: string): string | undefined {
    if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(text)) return undefined;
    try {
        return new Intl.DateTimeFormat('en-US', { timeZone: text }).resolvedOptions().timeZone;
    } catch {
        return undefined;
    }
}

/** The offset of a time zone at an instant, as `±HH:MM` (from the time zone data). */
export function zoneOffset(zone: string, epochMs: number): string {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
        .formatToParts(new Date(epochMs))
        .find((p) => p.type === 'timeZoneName')?.value;
    const m = /^GMT(?:([+-]\d{2}):(\d{2}))?$/.exec(part ?? '');
    return m?.[1] ? `${m[1]}:${m[2]}` : '+00:00';
}

/** Milliseconds since the epoch of a local date and time at an offset (`+09:00`). */
const epochAt = (date: string, time: string, offset: string): number => Date.parse(`${date}T${time}${offset}`);

/**
 * The canonical text of a value of `type` written as `text`, or `undefined` when it is not one: `2026-02-30` is not a
 * date, `24:00` not a time, `2026-07-01T10:00:00+09:00[America/New_York]` not a time in New York. Years are 0001–9999.
 */
export function canonicalTemporal(type: TemporalName, text: string): string | undefined {
    switch (type) {
        case 'Date': {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
            return m && validDate(+m[1]!, +m[2]!, +m[3]!) ? text : undefined;
        }
        case 'YearMonth': {
            const m = /^(\d{4})-(\d{2})$/.exec(text);
            return m && +m[1]! >= 1 && +m[2]! >= 1 && +m[2]! <= 12 ? text : undefined;
        }
        case 'Time': {
            const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
            if (!m || !validTime(+m[1]!, +m[2]!, +(m[3] ?? 0))) return undefined;
            return `${m[1]}:${m[2]}:${m[3] ?? '00'}`;
        }
        case 'Timestamp': {
            const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(text);
            if (!m || !validDate(+m[1]!, +m[2]!, +m[3]!) || !validTime(+m[4]!, +m[5]!, +m[6]!)) return undefined;
            return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${(m[7] ?? '').padEnd(3, '0')}Z`;
        }
        case 'DateTime': {
            const m = /^(\d{4}-\d{2}-\d{2})T(.+)$/.exec(text);
            const date = m && canonicalTemporal('Date', m[1]!);
            const time = m && canonicalTemporal('Time', m[2]!);
            return date && time ? `${date}T${time}` : undefined;
        }
        case 'ZonedDateTime': {
            const m = /^(.+?)(Z|[+-]\d{2}:\d{2})\[([^\]]+)\]$/.exec(text);
            const local = m && canonicalTemporal('DateTime', m[1]!);
            const zone = m && canonicalZone(m[3]!);
            if (!m || !local || !zone) return undefined;
            const offset = m[2] === 'Z' ? '+00:00' : m[2]!;
            const [date = '', time = ''] = local.split('T');
            const at = epochAt(date, time, offset);
            // the offset must be the zone's at that instant: it tells the two times of a repeated hour apart
            return Number.isNaN(at) || zoneOffset(zone, at) !== offset ? undefined : `${local}${offset}[${zone}]`;
        }
        case 'TimeZone':
            return canonicalZone(text);
    }
}

/** An example value of each type, for hints. */
export const TEMPORAL_EXAMPLE: Readonly<Record<TemporalName, string>> = {
    Date: '2026-11-22',
    Time: '18:00:00',
    YearMonth: '2026-11',
    Timestamp: '2026-11-22T09:30:00.000Z',
    DateTime: '2026-11-22T18:00:00',
    ZonedDateTime: '2026-11-22T18:00:00+09:00[Asia/Tokyo]',
    TimeZone: 'Asia/Tokyo',
};
