// Exporting (view/export.ts): the viewer's options, remembered.
import { describe, expect, test } from 'bun:test';
import { EXPORT_OPTIONS_KEY, readExportOptions, writeExportOptions } from './export';

/** A storage of a map, like the browser's. */
function storage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
    const data = new Map(Object.entries(initial));
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('the export options', () => {
    test('are off until the viewer turns them on, and remembered', () => {
        const s = storage();
        expect(readExportOptions(s)).toEqual({ heading: false, legend: false });
        writeExportOptions(s, { heading: true, legend: false });
        expect(readExportOptions(s)).toEqual({ heading: true, legend: false });
        writeExportOptions(s, { heading: true, legend: true });
        expect(JSON.parse(s.data.get(EXPORT_OPTIONS_KEY)!)).toEqual({ heading: true, legend: true });
    });

    test('anything unreadable is the default, and no storage is no failure', () => {
        expect(readExportOptions(storage({ [EXPORT_OPTIONS_KEY]: '{' }))).toEqual({ heading: false, legend: false });
        expect(readExportOptions(storage({ [EXPORT_OPTIONS_KEY]: '{"heading":"yes","legend":true}' }))).toEqual({ heading: false, legend: true });
        expect(readExportOptions(undefined)).toEqual({ heading: false, legend: false });
        const failing = {
            setItem: () => {
                throw new Error('quota');
            },
        };
        expect(() => writeExportOptions(failing, { heading: true, legend: true })).not.toThrow();
    });
});
