// The view and the world across a reload (view/navigation.ts `useNavigation`, `opensOnStormings`; view/worlds.ts): the
// page comes back to the view it showed, whatever the first payload holds.
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { viewPayloads } from '../test-helpers';
import { opensOnStormings, useNavigation } from './navigation';
import { MODEL_VIEW_KEY, rememberedModelView, rememberedView, useWorlds, VIEW_KEY, viewOfWorld } from './worlds';

const STAGES = readFileSync(join(import.meta.dir, '..', '..', '..', 'test', 'fixtures', 'stages', 'convenience-store-stages.dtes'), 'utf8');

/** localStorage of a browser, in memory: what was saved before the reload; returns what the page writes. */
function storage(saved: Record<string, string> = {}): Map<string, string> {
    const items = new Map(Object.entries(saved));
    Object.assign(globalThis, {
        localStorage: { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) },
    });
    return items;
}

afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
});

/** The page's first render after a reload, before any payload: the view and the world it shows. */
function Shown() {
    const nav = useNavigation(null, null, []);
    const worlds = useWorlds(nav.view, nav.setView);
    return (
        <p>
            {nav.view.kind}/{worlds.world}
        </p>
    );
}
const firstRender = (): string => renderToStaticMarkup(<Shown />).replace(/<\/?p>|<!-- -->/g, '');

describe('the view across a reload', () => {
    test('the event storming world comes back, before the stormings arrive', () => {
        storage({ [VIEW_KEY]: JSON.stringify('storming') });
        expect(firstRender()).toBe('storming/storming');
    });

    test('a view of the domain model comes back as it was', () => {
        storage({ [VIEW_KEY]: JSON.stringify('catalog') });
        expect(firstRender()).toBe('catalog/model');
    });

    test('nothing remembered, or a value that is no view: the structure', () => {
        storage();
        expect(firstRender()).toBe('structure/model');
        storage({ [VIEW_KEY]: JSON.stringify('timeline') });
        expect(firstRender()).toBe('structure/model');
        expect(rememberedView(42)).toEqual({ kind: 'structure' });
    });

    test('the first render writes nothing back (no fallback replaces the remembered choice)', () => {
        const items = storage({ [VIEW_KEY]: JSON.stringify('storming'), [MODEL_VIEW_KEY]: JSON.stringify('contextMap') });
        firstRender();
        expect(Object.fromEntries(items)).toEqual({ [VIEW_KEY]: '"storming"', [MODEL_VIEW_KEY]: '"contextMap"' });
    });

    test('switching back to the domain model after a reload returns to its last view', () => {
        storage({ [VIEW_KEY]: JSON.stringify('storming'), [MODEL_VIEW_KEY]: JSON.stringify('catalog') });
        expect(viewOfWorld('model', rememberedModelView(JSON.parse(localStorage.getItem(MODEL_VIEW_KEY) ?? 'null')))).toEqual({ kind: 'catalog' });
        expect(rememberedModelView('storming')).toBe('structure');
    });
});

describe('a workspace of .dtes files only opens on its stormings', () => {
    test('decided from its files: .dtes only opens on them', async () => {
        const [p] = await viewPayloads([{ path: 'stormings/stages.dtes', text: STAGES }]);
        expect(opensOnStormings(p!)).toBe(true);
    });

    test('a .dt that does not parse yet (no contexts in the payload) keeps the domain model', async () => {
        const [p] = await viewPayloads([
            { path: 'sales/sales.dt', text: 'context Sales {\n  aggregate Order {\n' },
            { path: 'stormings/stages.dtes', text: STAGES },
        ]);
        expect(p!.status).toBe('syntax-error');
        expect(p!.focusContexts).toEqual([]);
        expect(opensOnStormings(p!)).toBe(false);
    });

    test('an empty workspace does not', async () => {
        const [p] = await viewPayloads([]);
        expect(opensOnStormings(p!)).toBe(false);
    });
});
