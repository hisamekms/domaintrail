import { afterAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createViewService, ElkLayoutEngine, type ViewService } from '@domaintrail/visualization';
import { I18nProvider } from './i18n';
import { shownStorming, stageChoice, StormingDetails, StormingToolbar, type StormingChoice } from './storming';

const SAMPLE = await readFile(path.join(import.meta.dir, '..', '..', 'test', 'fixtures', 'dtes', 'delivery-cancellation.dtes'), 'utf8');

/** The view service of a workspace holding `delivery.dtes` (the sample by default), without git or saved layouts. */
const viewService = (text = SAMPLE): ViewService =>
    createViewService({
        root: '/workspace',
        engine,
        workspace: { readSources: async () => [{ path: 'delivery.dtes', text }] },
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

    test('says that an event marked `level design` is shown at Design Level only', async () => {
        const text = SAMPLE.replace('event SlotReleased "配送枠が解放された"', 'event SlotReleased "配送枠が解放された" {\n    level design\n  }');
        expect(text).not.toBe(SAMPLE);
        const { stormings, diagnostics } = await viewService(text).refresh();
        const html = (id: string, lang: 'en' | 'ja') =>
            renderToStaticMarkup(
                <I18nProvider lang={lang}>
                    <StormingDetails
                        stormings={stormings}
                        selected={`es/DeliveryCancellation/${id}`}
                        render={stormings[0].views['design-level|'].render}
                        model={null}
                        mode="name"
                        diagnostics={diagnostics}
                        history={null}
                        onSelect={() => {}}
                    />
                </I18nProvider>,
            );
        expect(html('SlotReleased', 'en')).toContain('<span class="level-badge">Design Level only</span>');
        expect(html('SlotReleased', 'ja')).toContain('<span class="level-badge">デザインレベルのみ</span>');
        expect(html('BikeReleased', 'en')).not.toContain('level-badge');
        // hidden at Big Picture
        expect(stormings[0].views['big-picture|'].render.nodes.some((n) => n.type === 'event' && n.eventId === 'SlotReleased')).toBe(false);
    });
});

describe('a storming with stages', () => {
    const STAGED = readFile(path.join(import.meta.dir, '..', '..', 'test', 'fixtures', 'stages', 'convenience-store-stages.dtes'), 'utf8');

    test('a stage is chosen as `@<stage ID>` in the timeline picker; an unknown one is the integrated canvas', async () => {
        const { stormings } = await viewService(await STAGED).refresh();
        const choice = (scope: string) => ({ stormingId: undefined, level: 'big-picture' as const, timelines: { ConvenienceStoreIssuance: scope } });
        expect(shownStorming(stormings, choice(stageChoice('Issuance')))?.options).toEqual({ level: 'big-picture', stageId: 'Issuance' });
        expect(shownStorming(stormings, choice('PinLockedBranch'))?.options).toEqual({ level: 'big-picture', timelineId: 'PinLockedBranch' });
        expect(shownStorming(stormings, choice('@Nowhere'))?.options).toEqual({ level: 'big-picture' });
    });

    test('「例外を表示」 off hides the exceptions of the integrated canvas and a stage, never of a timeline’s view; the toggle is there only with exceptions', async () => {
        const staged = (await viewService(await STAGED).refresh()).stormings;
        const plain = (await viewService().refresh()).stormings;
        const off = (scope?: string): StormingChoice => ({
            stormingId: undefined,
            level: 'big-picture',
            timelines: scope ? { ConvenienceStoreIssuance: scope } : {},
            exceptions: false,
        });
        expect(shownStorming(staged, off())?.options).toEqual({ level: 'big-picture', hideExceptions: true });
        expect(shownStorming(staged, off(stageChoice('Issuance')))?.options).toEqual({ level: 'big-picture', stageId: 'Issuance', hideExceptions: true });
        expect(shownStorming(staged, off('PinLockedBranch'))?.options).toEqual({ level: 'big-picture', timelineId: 'PinLockedBranch' });
        expect(shownStorming(plain, off())?.options).toEqual({ level: 'big-picture' });
        const toolbar = (stormings: typeof staged) =>
            renderToStaticMarkup(
                <I18nProvider lang="ja">
                    <StormingToolbar stormings={stormings} choice={off()} mode="label" onChange={() => {}} />
                </I18nProvider>,
            );
        expect(toolbar(staged)).toContain('aria-label="例外を表示"');
        expect(toolbar(staged)).toContain('aria-pressed="false"');
        expect(toolbar(plain)).not.toContain('例外を表示');
    });

    test('the inspector of a stage: the stage it comes after, its main flow, its exceptions, and the way to its view', async () => {
        const { stormings, diagnostics } = await viewService(await STAGED).refresh();
        const shown: string[] = [];
        const html = renderToStaticMarkup(
            <I18nProvider lang="en">
                <StormingDetails
                    stormings={stormings}
                    selected="es/ConvenienceStoreIssuance/Issuance"
                    render={undefined}
                    model={null}
                    mode="name"
                    diagnostics={diagnostics}
                    history={null}
                    onSelect={() => {}}
                    onShowStage={(storming, stage) => shown.push(`${storming}/${stage}`)}
                />
            </I18nProvider>,
        );
        expect(html).toContain('>Stage<');
        expect(html).toContain('Show this stage');
        expect(html).toContain('<h3>Comes after</h3><div><a>Preparation</a></div>');
        expect(html).toContain('<h3>Main flows</h3><ul class="es-list"><li><a>IssuanceFlow</a></li></ul>');
        expect(html).toContain('<h3>Exceptions (8)</h3>');
    });
});
