// The viewer's options of exporting and printing: whether an export has the heading line, and whether an export or a
// print has the view's legend. Remembered per browser.
import { useCallback, useState } from 'react';

/** What an export (and a print, for the legend) includes besides the diagram: the viewer's choice, remembered. */
export interface ExportOptions {
    /** The heading line, in a PNG or SVG (a printed sheet always has it). */
    heading: boolean;
    /** The view's legend, under the diagram (printed too). */
    legend: boolean;
}

export const EXPORT_OPTIONS_KEY = 'domaintrail.export';
const DEFAULT_OPTIONS: ExportOptions = { heading: false, legend: false };

/** The options stored in `storage` (the defaults, off, for anything missing or unreadable). */
export function readExportOptions(storage: Pick<Storage, 'getItem'> | undefined): ExportOptions {
    try {
        const raw = storage?.getItem(EXPORT_OPTIONS_KEY);
        const saved: unknown = raw ? JSON.parse(raw) : undefined;
        if (!saved || typeof saved !== 'object') return DEFAULT_OPTIONS;
        const value = (key: keyof ExportOptions): boolean => {
            const v: unknown = Reflect.get(saved, key);
            return typeof v === 'boolean' ? v : DEFAULT_OPTIONS[key];
        };
        return { heading: value('heading'), legend: value('legend') };
    } catch {
        return DEFAULT_OPTIONS;
    }
}

/** Stores the options (nothing when the storage is unavailable). */
export function writeExportOptions(storage: Pick<Storage, 'setItem'> | undefined, options: ExportOptions): void {
    try {
        storage?.setItem(EXPORT_OPTIONS_KEY, JSON.stringify(options));
    } catch {
        // storage unavailable (private mode, etc.)
    }
}

const browserStorage = (): Storage | undefined => (typeof localStorage === 'undefined' ? undefined : localStorage);

/** The export options and their setter, remembered per browser. */
export function useExportOptions(): [ExportOptions, (options: ExportOptions) => void] {
    const [options, setOptions] = useState(() => readExportOptions(browserStorage()));
    const set = useCallback((next: ExportOptions) => {
        setOptions(next);
        writeExportOptions(browserStorage(), next);
    }, []);
    return [options, set];
}
