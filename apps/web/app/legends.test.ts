import { describe, expect, test } from 'bun:test';
import type { LegendView } from '../legend';
import { FORMER_LEGEND_KEY, LEGEND_TOOLBARS, legendKey, legendToolbar, readLegends, toggleLegend } from './legends';

/** A localStorage stand-in. */
function memoryStorage(entries: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { map: Map<string, string> } {
    const map = new Map(Object.entries(entries));
    return {
        map,
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => void map.set(k, v),
        removeItem: (k) => void map.delete(k),
    };
}

describe("the views' legends", () => {
    test('are hidden by default in every view', () => {
        const open = readLegends(memoryStorage());
        for (const toolbar of LEGEND_TOOLBARS) expect(open[toolbar]).toBe(false);
    });

    test('ignore the former page-wide key, and remove it', () => {
        const storage = memoryStorage({ [FORMER_LEGEND_KEY]: 'true' });
        const open = readLegends(storage);
        for (const toolbar of LEGEND_TOOLBARS) expect(open[toolbar]).toBe(false);
        expect(storage.map.has(FORMER_LEGEND_KEY)).toBe(false);
    });

    test("toggling one view's leaves the others as they are", () => {
        const storage = memoryStorage();
        const open = toggleLegend(readLegends(storage), 'contextMap', storage);
        expect(open).toEqual({ contextMap: true, structure: false, states: false, storming: false });
        expect(toggleLegend(open, 'storming', storage)).toEqual({ contextMap: true, structure: false, states: false, storming: true });
    });

    test('are remembered per view', () => {
        const storage = memoryStorage();
        toggleLegend(readLegends(storage), 'states', storage);
        expect(storage.map.get(legendKey('states'))).toBe('true');
        expect(storage.map.has(legendKey('contextMap'))).toBe(false);
        expect(readLegends(storage)).toEqual({ contextMap: false, structure: false, states: true, storming: false });
        // closed again: remembered closed
        toggleLegend(readLegends(storage), 'states', storage);
        expect(readLegends(storage).states).toBe(false);
    });

    test("share the structure's toolbar across its levels and its focus", () => {
        const views: LegendView[] = ['structure', 'structureFocus', 'aggregates', 'aggregatesFocus'];
        for (const view of views) expect(legendToolbar(view)).toBe('structure');
        const storage = memoryStorage();
        const open = toggleLegend(readLegends(storage), 'aggregatesFocus', storage);
        expect(open.structure).toBe(true);
        expect(toggleLegend(open, 'structure', storage).structure).toBe(false);
    });

    test('read a stored value that is not a boolean as closed', () => {
        expect(readLegends(memoryStorage({ [legendKey('storming')]: '"yes"' })).storming).toBe(false);
    });
});
