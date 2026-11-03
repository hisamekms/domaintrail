// 「詰めて表示」 (view/compact.ts, view/settings.ts): the toggle remembered per browser, and the compact layouts the page
// keeps by graph and shape.
import { afterEach, describe, expect, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LaidOutGraph } from '@domaintrail/visualization';
import { layoutKeyOf } from '../session/location';
import { cachedCompact, compactCacheKey, keepCompact } from './compact';
import { focusLayoutKey } from './graph';
import { COMPACT_KEY, useViewSettings, type ViewSettings } from './settings';

const graph = (id: string, signature: string, extra: Partial<LaidOutGraph> = {}): LaidOutGraph => ({
    id,
    nodes: [],
    edges: [],
    nodeLayout: { a: { x: 10, y: 20, width: 100, height: 50 } },
    edgeLayout: {
        e: {
            points: [
                { x: 0, y: 0 },
                { x: 200, y: 0 },
            ],
        },
    },
    signature,
    ...extra,
});

/** localStorage of a browser, in memory. */
function storage(saved: Record<string, string> = {}): Map<string, string> {
    const items = new Map(Object.entries(saved));
    Object.assign(globalThis, {
        localStorage: { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) },
    });
    return items;
}

/** The view settings a page starts with. */
function settingsOnLoad(): ViewSettings {
    let settings: ViewSettings | undefined;
    const Probe = (): ReactNode => {
        settings = useViewSettings();
        return null;
    };
    renderToStaticMarkup(createElement(Probe));
    return settings!;
}

describe('「詰めて表示」', () => {
    afterEach(() => {
        Reflect.deleteProperty(globalThis, 'localStorage');
    });

    test('is off at first, and remembered per browser once switched', () => {
        const items = storage();
        const first = settingsOnLoad();
        expect(first.compact).toBe(false);
        first.setCompact(true);
        expect(items.get(COMPACT_KEY)).toBe('true');
        expect(settingsOnLoad().compact).toBe(true);
        storage({ [COMPACT_KEY]: 'false' });
        expect(settingsOnLoad().compact).toBe(false);
    });

    test('the compact layout the page has is found by the graph and its shape; a changed graph has none yet', () => {
        const normal = graph('storming:S:big-picture:*', 'shape-1');
        expect(cachedCompact(normal)).toBeUndefined();
        const compact = graph(normal.id, 'shape-1', { spacing: 'compact' });
        keepCompact(compact);
        expect(cachedCompact(normal)).toBe(compact);
        expect(cachedCompact(graph(normal.id, 'shape-2'))).toBeUndefined();
        // a graph laid out compactly already (a focused view asked for so) is its own
        expect(cachedCompact(compact)).toBe(compact);
        expect(compactCacheKey(normal)).not.toBe(compactCacheKey(graph(normal.id, 'shape-2')));
    });

    test('a focused view is kept apart in each spacing', () => {
        expect(focusLayoutKey('Sales||detail', true)).not.toBe(focusLayoutKey('Sales||detail', false));
        expect(focusLayoutKey('Sales||detail', false)).toBe('Sales||detail');
    });

    test('a compact layout is another location: the others’ cursors are not drawn on it from the normal one', () => {
        const normal = graph('structure', 'shape-1');
        expect(layoutKeyOf(graph('structure', 'shape-1', { spacing: 'compact' }))).not.toBe(layoutKeyOf(normal));
    });
});
