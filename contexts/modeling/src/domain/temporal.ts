// The date and time types of the DSL (ADR 0038): their canonical text, which every target writes and reads, and the
// check of a literal written for one of them. A literal is canonical text, or a form the type accepts and normalizes
// (`HH:MM` for a `Time`, a `Timestamp` without milliseconds).
import type { PrimitiveName } from './model.js';

/** The date and time types: values on a calendar or clock (no time zone), and the instant. */
export const TEMPORAL_TYPES = ['Date', 'Time', 'YearMonth', 'Timestamp'] as const satisfies readonly PrimitiveName[];
export type TemporalName = (typeof TEMPORAL_TYPES)[number];

export const isTemporal = (name: string | undefined): name is TemporalName => (TEMPORAL_TYPES as readonly string[]).includes(name ?? '');

/** The canonical form of each type, in words (for messages). */
export const TEMPORAL_FORM: Readonly<Record<TemporalName, string>> = {
    Date: 'YYYY-MM-DD',
    Time: 'HH:MM:SS (or HH:MM)',
    YearMonth: 'YYYY-MM',
    Timestamp: 'YYYY-MM-DDTHH:MM:SS.sssZ (UTC; milliseconds may be left out)',
};

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

const daysIn = (year: number, month: number): number =>
    month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

const validDate = (y: number, m: number, d: number): boolean => y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
const validTime = (h: number, mi: number, s: number): boolean => h <= 23 && mi <= 59 && s <= 59;

/**
 * The canonical text of a value of `type` written as `text`, or `undefined` when it is not one: `2026-02-30` is not a
 * date, `24:00` not a time. Years are 0001–9999.
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
    }
}

/** An example value of each type, for hints. */
export const TEMPORAL_EXAMPLE: Readonly<Record<TemporalName, string>> = {
    Date: `${pad(2026, 4)}-11-22`,
    Time: '18:00:00',
    YearMonth: '2026-11',
    Timestamp: '2026-11-22T09:30:00.000Z',
};
