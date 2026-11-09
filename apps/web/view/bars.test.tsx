// The app bar's world switch and the view bar above the canvas (view/worlds.ts, view/workspace.tsx `ViewBar`,
// view/toolbar.tsx `NameSwitch`), and the canvas controls' legend icon.
import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Blocks, StickyNote } from 'lucide-react';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import { I18nProvider, MESSAGES } from '../i18n';
import { exampleSources, viewPayloads } from '../test-helpers';
import { CanvasControls } from './canvas-controls';
import type { DiagramCanvas } from './diagram';
import type { View } from './navigation';
import { NameSwitch } from './toolbar';
import { ViewBar, type Workspace } from './workspace';
import { lastModelViewAfter, MODEL_VIEWS, viewOfWorld, WORLDS, worldOf, type ModelView } from './worlds';

const render = (node: ReactNode): string => renderToStaticMarkup(<I18nProvider lang="ja">{node}</I18nProvider>);
const styles = readFileSync(join(import.meta.dir, '..', 'styles.css'), 'utf8');
const ja = MESSAGES.ja;
/** The accessible names of the buttons, in order. */
const labels = (html: string): string[] => [...html.matchAll(/<button[^>]* aria-label="([^"]*)"/g)].map((m) => m[1] ?? '');

describe('the worlds', () => {
    test('the domain model and event storming, the latter even without a storming; the world follows the view', () => {
        expect(WORLDS).toEqual(['model', 'storming']);
        expect(MODEL_VIEWS).toEqual(['contextMap', 'structure', 'catalog']);
        for (const v of MODEL_VIEWS) expect(worldOf(v)).toBe('model');
        expect(worldOf('storming')).toBe('storming');
    });

    test('switching worlds returns to the domain model’s last view', () => {
        let last: ModelView = 'structure';
        const show = (v: View['kind']): void => {
            last = lastModelViewAfter(last, v);
        };
        show('catalog');
        expect(viewOfWorld('storming', last)).toEqual({ kind: 'storming' });
        show('storming');
        expect(viewOfWorld('model', last)).toEqual({ kind: 'catalog' });
        show('contextMap');
        show('storming');
        expect(viewOfWorld('model', last)).toEqual({ kind: 'contextMap' });
    });

    test('the switch: an icon and a name each, the name kept as the accessible name when it is hidden', () => {
        const html = render(
            <NameSwitch
                label={ja.worldsLabel}
                className="world-switch"
                choices={WORLDS}
                value="storming"
                icons={{ model: Blocks, storming: StickyNote }}
                names={ja.worlds}
                onChange={() => {}}
            />,
        );
        expect(html).toContain('aria-label="世界"');
        expect(labels(html)).toEqual(['ドメインモデル', 'イベントストーミング']);
        expect(html).toContain('lucide-blocks');
        expect(html).toContain('lucide-sticky-note');
        expect(html.match(/<span class="switch-label">/g)).toHaveLength(2);
        expect(html).toMatch(/aria-pressed="true" aria-label="イベントストーミング"/);
    });
});

describe('narrow bars show icons', () => {
    test('the app bar, by its own width: the world switch drops its names', () => {
        expect(styles).toMatch(/\.app-bar \{\n\s+container: app-bar \/ inline-size;/);
        expect(styles).toMatch(/@container app-bar \(max-width: [\d.]+rem\) \{\s+\.world-switch \.switch-label \{\s+display: none;/);
    });

    test('the view bar, by its own width: the right end first, then the view switch, then the levels', () => {
        expect(styles).toMatch(/\.view-toolbar \{\n\s+container: view-toolbar \/ inline-size;/);
        const at = (selector: string): number => {
            const re = new RegExp(`@container view-toolbar \\(max-width: ([\\d.]+)rem\\) \\{\\s+${selector.replace(/\./g, '\\.')} \\{\\s+display: none;`);
            const m = styles.match(re);
            expect(m).not.toBeNull();
            return Number(m?.[1]);
        };
        const end = at('.toolbar-end-label');
        const views = at('.view-switch .switch-label');
        const levels = at('.level-label');
        expect(end).toBeGreaterThan(views);
        expect(views).toBeGreaterThan(levels);
    });
});

describe('the view bar', () => {
    let current: ViewPayload;
    beforeAll(async () => {
        const stages = readFileSync(join(import.meta.dir, '..', '..', '..', 'test', 'fixtures', 'stages', 'convenience-store-stages.dtes'), 'utf8');
        [current] = await viewPayloads([...(await exampleSources()), { path: 'stages.dtes', text: stages }]);
    });

    /** A workspace showing `view`, with the structure focused on `checked` (none: every context). */
    const workspace = (view: View, checked: string[] = []): Workspace => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the view bar reads of the workspace
        return {
            stormings: current.stormings,
            nav: { view, setView: () => {} },
            worlds: { world: worldOf(view.kind), setWorld: () => {} },
            settings: {
                structureLevel: 'detail',
                setStructureLevel: () => {},
                setStructureContexts: () => {},
                setHiddenContexts: () => {},
                mapAll: false,
                setMapAll: () => {},
                stormingChoice: { stormingId: 'ConvenienceStoreIssuance', level: 'design-level', timelines: {} },
                setStormingChoice: () => {},
            },
            viewGraph: { checked, hidden: [], focusKey: checked.join(',') },
            catalog: { filter: { query: '', sections: [], contexts: null }, setFilter: () => {} },
            printer: { phase: 'idle', print: () => {} },
            exportOptions: { options: { heading: false, legend: false }, setOptions: () => {} },
        } as unknown as Workspace;
    };
    const bar = (view: View, checked?: string[], empty = false): string =>
        render(<ViewBar workspace={workspace(view, checked)} current={current} mode="label" bar={empty ? undefined : view.kind} />);

    test('the structure: the views, the focused contexts, the levels with their short names and 絞り込み', () => {
        const html = bar({ kind: 'structure' }, ['Sales', 'Billing']);
        expect(labels(html).slice(0, 3)).toEqual(['マップ', '構造', 'カタログ']);
        expect(html).toContain('lucide-network');
        expect(html).toContain('lucide-workflow');
        expect(html).toContain('lucide-book-open');
        expect(html).toMatch(/aria-pressed="true" aria-label="構造"/);
        expect(html).toMatch(/class="subject-picker subject-name" aria-label="表示する BC">[^<]+, [^<]+</);
        for (const level of ['詳細', '概観', '集約']) expect(html).toContain(`<span class="level-label">${level}</span>`);
        expect(html).not.toContain('aria-label="書き出し"');
        expect(html).toContain('filter-button');
        // every context shown: no crumb
        expect(bar({ kind: 'structure' })).not.toContain('subject-name');
    });

    test('the catalog: the views, its search, 絞り込み and 印刷', () => {
        const html = bar({ kind: 'catalog' });
        expect(html).toMatch(/aria-pressed="true" aria-label="カタログ"/);
        expect(html).toContain('view-search');
        expect(html).toContain('印刷');
        expect(html).not.toContain('aria-label="書き出し"');
    });

    test('the context map: the views and 絞り込み', () => {
        const html = bar({ kind: 'contextMap' });
        expect(html).toMatch(/aria-pressed="true" aria-label="マップ"/);
        expect(html).not.toContain('level-switch');
        expect(html).not.toContain('aria-label="書き出し"');
    });

    test('event storming: no view switch; the storming › its timelines, the level and 絞り込み', () => {
        const html = bar({ kind: 'storming' });
        expect(html).not.toContain('view-switch');
        expect(html).toContain('subject-crumbs');
        expect(html).toContain('lucide-telescope');
        expect(html).toContain('lucide-microscope');
        expect(html).not.toContain('aria-label="書き出し"');
    });

    test('an empty view: the domain model keeps its view switch, the storming world shows nothing', () => {
        const model = bar({ kind: 'structure' }, [], true);
        expect(labels(model)).toEqual(['マップ', '構造', 'カタログ']);
        expect(bar({ kind: 'storming' }, [], true)).toBe('<div class="view-toolbar"><div class="toolbar-end"></div></div>');
    });
});

describe("the canvas controls' legend", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the controls read before they are used
    const canvas = { getZoom: () => 1, selectedIds: () => [] } as unknown as DiagramCanvas;

    test('is the shapes icon (the book is the catalog’s)', () => {
        const html = render(
            <CanvasControls
                canvas={canvas}
                fitAll={() => {}}
                legend={{ view: 'contextMap', open: false, onToggle: () => {} }}
                compact={{ on: false, onToggle: () => {} }}
            />,
        );
        expect(html).toMatch(/canvas-legend-button[^>]*><svg[^>]*lucide-shapes/);
        expect(html).not.toContain('lucide-book-open');
    });
});
