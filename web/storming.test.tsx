import { afterAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createViewService, ElkLayoutEngine, type ViewService } from '@domaintrail/visualization';
import { I18nProvider } from './i18n';
import { StormingDetails } from './storming';

const SAMPLE = await readFile(path.join(import.meta.dir, '..', 'test', 'fixtures', 'dtes', 'delivery-cancellation.dtes'), 'utf8');

/** The view service of a workspace holding `delivery.dtes`, without git or saved layouts. */
const viewService = (): ViewService =>
    createViewService({
        root: '/workspace',
        engine,
        workspace: { readSources: async () => [{ path: 'delivery.dtes', text: SAMPLE }] },
        layoutStore: { load: async () => new Map(), save: async () => {} },
        git: {
            resolveCommit: (ref) => Promise.reject(new Error(`no git: ${ref}`)),
            sourcesAt: async () => [],
            listRefs: async () => ({ branches: [], tags: [], commits: [] }),
            gitDirs: async () => undefined,
        },
    });

const engine = new ElkLayoutEngine();
afterAll(() => engine.dispose());

describe('the inspector of a storming element', () => {
    test('shows the .dt ref, the relations, and the timelines a shared note stands for (§6, §8.4)', async () => {
        const { stormings, diagnostics } = await viewService().refresh();
        const html = (id: string, key = 'design-level|') =>
            renderToStaticMarkup(
                <I18nProvider lang="en">
                    <StormingDetails
                        stormings={stormings}
                        selected={`es/DeliveryCancellation/${id}`}
                        render={stormings[0].views[key].render}
                        model={null}
                        mode="name"
                        diagnostics={diagnostics}
                        history={null}
                        onSelect={() => {}}
                    />
                </I18nProvider>,
            );
        const event = html('ShipmentCancelled');
        expect(event).toContain('Delivery.ShipmentCancelled');
        expect(event).toContain('Normal · step 1');
        expect(event).toContain('Failure · step 1');
        expect(event).toContain('Notes in this view (1)');
        expect(event).toContain('Failure · step 1 / Normal · step 1');
        expect(event).toContain('they are not necessarily the same happening');
        // in the Failure timeline, the note stands for that timeline's occurrence only
        const filtered = html('ShipmentCancelled', 'big-picture|Failure');
        expect(filtered).toContain(
            '<li>Failure · step 1</li></ul></section><section><h3>Notes in this view (1)</h3><ul class="es-list"><li>Failure · step 1</li>',
        );
        expect(filtered).not.toContain('they are not necessarily the same happening');
        expect(html('BikeReleased')).toContain('Normal · step 2 · group CleanupResults');
        const policy = html('CleanupAfterCancel');
        expect(policy).toContain('ShipmentCancelled</a> → <a>CleanupAfterCancel');
        expect(policy).not.toContain('In .dt');
        expect(html('Compensation')).toContain('<div>open</div>');
        expect(html('Nope')).toContain('Nope is not in the storming');
    });
});
