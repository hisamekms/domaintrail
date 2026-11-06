import { afterAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createViewService, ElkLayoutEngine, hideInDrawing, type Hideable, type ViewService } from '@domaintrail/visualization';
import { I18nProvider, MESSAGES } from './i18n';
import type { Diagnostic } from '@domaintrail/kernel';
import type { ElementActivity } from './session/element-activity';
import {
    clearStormingFilter,
    hideableIn,
    revealIn,
    shownHidden,
    shownStorming,
    stormingGraph,
    stageChoice,
    StormingDetails,
    StormingFilter,
    StormingToolbar,
    stormingSelectionTitle,
    type StormingChoice,
    type StormingDetailSession,
} from './storming';
import { beginActions, problemText } from './storming-detail';
import { Inspector, type InspectorProps } from './inspector';
import { check } from './test-helpers';
import type { DisplayMode } from '@domaintrail/visualization';

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

/** A session as the detail gets it: `activity` for every element, and what each action began (`begun`). */
function detailSession(activity: ElementActivity = {}): { session: StormingDetailSession; begun: string[] } {
    const begun: string[] = [];
    return {
        begun,
        session: {
            activity: () => activity,
            begin: (id, write) => begun.push(`${id}: ${write('#X')}`),
            openMessage: () => {},
            openRun: () => {},
            openRuns: () => {},
        },
    };
}

describe('the detail of a storming element', () => {
    const detail = async (
        id: string,
        opts: { key?: string; session?: StormingDetailSession; diagnostics?: Diagnostic[]; text?: string; lang?: 'en' | 'ja' } = {},
    ): Promise<string> => {
        const { stormings, diagnostics } = await viewService(opts.text).refresh();
        const key = opts.key ?? 'design-level|';
        return renderToStaticMarkup(
            <I18nProvider lang={opts.lang ?? 'en'}>
                <StormingDetails
                    stormings={stormings}
                    selected={`es/DeliveryCancellation/${id}`}
                    render={stormings[0].views[key].render}
                    level={stormings[0].views[key].render.options.level}
                    model={null}
                    mode="name"
                    diagnostics={opts.diagnostics ?? diagnostics}
                    history={null}
                    session={opts.session}
                    onSelect={() => {}}
                    onShowScope={() => {}}
                    onLevel={() => {}}
                />
            </I18nProvider>,
        );
    };
    const row = (label: string): string => `aria-label="${label}"`;

    test('shows only what the canvas does not: no file, no relations, no occurrences, no DSL words', async () => {
        const event = await detail('ShipmentCancelled');
        expect(event).not.toContain('delivery.dtes');
        expect(event).not.toContain('Open the file');
        expect(event).not.toContain('Relations');
        expect(event).not.toContain('step 1');
        expect(event).not.toContain('emits');
        // its .dt counterpart, by an icon only (the model has none here: the ref as written)
        expect(event).toContain(row('In .dt'));
        expect(event).toContain('<code>Delivery.ShipmentCancelled</code>');
        // every timeline of it is on the integrated canvas: no other places; at Design Level nothing is hidden
        expect(event).not.toContain(row('Other places'));
        expect(event).not.toContain(row('Hidden connections'));
        // no ref, no row
        expect(await detail('CleanupAfterCancel')).not.toContain(row('In .dt'));
        expect(await detail('Nope')).toContain('Nope is not in the storming');
    });

    test('an event: its other places outside a timeline’s view, and at Big Picture what Design Level shows', async () => {
        const failure = await detail('ShipmentCancelled', { key: 'big-picture|Failure' });
        expect(failure).toContain(row('Other places'));
        expect(failure).toContain('<a>Normal</a>');
        expect(failure).not.toContain('<a>Failure</a>');
        // at Big Picture: the command causing it with its actor, here, the policy reacting, and the way to Design Level
        expect(failure).toContain(row('Hidden connections'));
        expect(failure).toContain('<a>Customer</a> </span><a>CancelShipment</a></span> → <span class="muted">here</span> → <span><a>CleanupAfterCancel</a>');
        expect(failure).toContain(row('See at Design Level'));
        // only what there is: a cause without reactions
        expect(await detail('ReleaseFailed', { key: 'big-picture|' })).toContain('<span><a>ReleaseBike</a></span> → <span class="muted">here</span></span>');
    });

    test('an event marked `level design`: a grey Microscope badge, named by its tooltip', async () => {
        const text = SAMPLE.replace('event SlotReleased "配送枠が解放された"', 'event SlotReleased "配送枠が解放された" {\n    level design\n  }');
        expect(text).not.toBe(SAMPLE);
        expect(await detail('SlotReleased', { text })).toContain('class="es-badge" role="img" aria-label="Design Level only" data-tooltip="Design Level only"');
        expect(await detail('SlotReleased', { text, lang: 'ja' })).toContain('aria-label="デザインレベルのみ"');
        expect(await detail('BikeReleased', { text })).not.toContain('es-badge');
    });

    test('a hotspot: its conclusion once resolved, and "tell the resolution" while open', async () => {
        const { session, begun } = detailSession();
        const open = await detail('Compensation', { session });
        expect(open).not.toContain(row('Conclusion'));
        expect(open).toContain(row('Tell the resolution'));
        expect(open).not.toContain(row('Add a question'));
        const text = SAMPLE.replace('    status open\n', '    status resolved\n    resolution "窓口で即日"\n');
        expect(text).not.toBe(SAMPLE);
        const resolved = await detail('Compensation', { session, text });
        expect(resolved).toContain(row('Conclusion'));
        expect(resolved).toContain('窓口で即日');
        expect(resolved).not.toContain(row('Tell the resolution'));
        expect(begun).toEqual([]);
    });

    test('the session’s rows: the talk with its latest message, the runs, the change of this session — only when there are some', async () => {
        const none = await detail('ShipmentCancelled', { session: detailSession().session });
        for (const label of ['Talk', 'AI work', 'Added in this session', 'Changed in this session']) expect(none).not.toContain(row(label));
        const busy = await detail('ShipmentCancelled', {
            session: detailSession({
                talk: { count: 3, latest: { request: 'r3', text: '戻り先は入力でいい?' } },
                runs: { count: 1, latest: 'run1' },
                change: { change: 'added', run: 'run1', request: '暗証番号を忘れた場合を足して' },
            }).session,
        });
        expect(busy).toContain(row('Talk'));
        expect(busy).toContain('<a>3</a> <q class="es-quote" data-tooltip="戻り先は入力でいい?">戻り先は入力でいい?</q>');
        expect(busy).toContain(row('AI work'));
        expect(busy).toContain('<a>1</a>');
        expect(busy).toContain(row('Added in this session'));
        expect(busy).toContain('<q>暗証番号を忘れた場合を足して</q>');
        // outside a session: none of them, and no actions
        const solo = await detail('ShipmentCancelled');
        expect(solo).not.toContain(row('Talk'));
        expect(solo).not.toContain(row('Ask the AI'));
    });

    test('the actions: icons in the brand colour, ask the AI first and filled; none without a session that takes messages', async () => {
        const event = await detail('ShipmentCancelled', { session: detailSession().session });
        expect(event).toContain('class="es-action filled" aria-label="Ask the AI"');
        expect(event).toContain('class="es-action" aria-label="Add a question"');
        const policy = await detail('CleanupAfterCancel', { session: detailSession().session });
        expect(policy).toContain(row('Ask the AI'));
        expect(policy).not.toContain(row('Add a question'));
        const { begin: _, ...readOnly } = detailSession().session;
        expect(await detail('ShipmentCancelled', { session: readOnly })).not.toContain('es-action');
        expect(beginActions('event', false)).toEqual(['ask', 'question']);
        expect(beginActions('hotspot', false)).toEqual(['ask', 'resolve']);
        expect(beginActions('hotspot', true)).toEqual(['ask']);
        expect(beginActions('command', false)).toEqual(['ask']);
    });

    test('a problem: on top, in plain words with its code as the tooltip, and a Wrench to have the AI fix it', async () => {
        const problem = (code: string, message: string): Diagnostic => ({
            severity: 'error',
            code,
            message,
            file: 'delivery.dtes',
            start: { line: 1, column: 1 },
            end: { line: 1, column: 2 },
            elementId: 'es/DeliveryCancellation/ShipmentCancelled',
        });
        const html = await detail('ShipmentCancelled', {
            session: detailSession().session,
            diagnostics: [problem('S018', 'Exception X returns to an event of no main flow.'), problem('S999', 'Something new.')],
        });
        expect(html).toContain('<span class="es-problem-text" data-tooltip="S018">It returns to no main flow</span>');
        expect(html).toContain('<span class="es-problem-text" data-tooltip="S999">Something new.</span>');
        expect(html).toContain('class="es-action filled" aria-label="Have the AI fix it"');
        expect(html.indexOf('es-problem')).toBeLessThan(html.indexOf('es-row'));
        expect(problemText({ code: 'S010', message: 'x' }, MESSAGES.ja.esDetail.problems)).toBe('.dt に対応するものがない');
        expect(MESSAGES.en.esDetail.begin.fix('#X[1]', 'No main flow')).toBe('Fix the problem in #X[1] (No main flow)');
    });
});

describe('a storming with stages', () => {
    const STAGED = readFile(path.join(import.meta.dir, '..', '..', 'test', 'fixtures', 'stages', 'convenience-store-stages.dtes'), 'utf8');
    /** The choice with the exceptions hidden, on the integrated canvas or a scope of the staged storming. */
    const off = (scope?: string): StormingChoice => ({
        stormingId: undefined,
        level: 'big-picture',
        timelines: scope ? { ConvenienceStoreIssuance: scope } : {},
        hidden: ['exceptions'],
    });

    test('a stage is chosen as `@<stage ID>` in the timeline picker; an unknown one is the integrated canvas', async () => {
        const { stormings } = await viewService(await STAGED).refresh();
        const choice = (scope: string) => ({ stormingId: undefined, level: 'big-picture' as const, timelines: { ConvenienceStoreIssuance: scope } });
        expect(shownStorming(stormings, choice(stageChoice('Issuance')))?.options).toEqual({ level: 'big-picture', stageId: 'Issuance' });
        expect(shownStorming(stormings, choice('PinLockedBranch'))?.options).toEqual({ level: 'big-picture', timelineId: 'PinLockedBranch' });
        expect(shownStorming(stormings, choice('@Nowhere'))?.options).toEqual({ level: 'big-picture' });
    });

    test('「例外を表示」 off hides the exceptions of the integrated canvas and a stage, never of a timeline’s view', async () => {
        const staged = (await viewService(await STAGED).refresh()).stormings;
        const plain = (await viewService().refresh()).stormings;
        expect(shownStorming(staged, off())?.options).toEqual({ level: 'big-picture', hidden: ['exceptions'] });
        expect(shownStorming(staged, off(stageChoice('Issuance')))?.options).toEqual({ level: 'big-picture', stageId: 'Issuance', hidden: ['exceptions'] });
        // as an earlier version kept it
        const { hidden: _, ...legacy } = { ...off(), exceptions: false };
        expect(shownStorming(staged, legacy)?.options).toEqual({ level: 'big-picture', hidden: ['exceptions'] });
        expect(shownStorming(staged, off('PinLockedBranch'))?.options).toEqual({ level: 'big-picture', timelineId: 'PinLockedBranch' });
        expect(shownStorming(plain, off())?.options).toEqual({ level: 'big-picture' });
    });

    test('「例外を表示」 is in the 絞り込み, not the toolbar’s subject: only with exceptions and not on one timeline; hidden, it counts one, and clearing shows them', async () => {
        const staged = (await viewService(await STAGED).refresh()).stormings;
        const plain = (await viewService().refresh()).stormings;
        const render = (node: ReactNode): string => renderToStaticMarkup(<I18nProvider lang="ja">{node}</I18nProvider>);
        const filter = (stormings: typeof staged, choice: StormingChoice): string =>
            render(<StormingFilter stormings={stormings} choice={choice} onChange={() => {}} />);
        expect(render(<StormingToolbar stormings={staged} choice={off()} mode="label" onChange={() => {}} />)).not.toContain('例外を表示');
        expect(filter(staged, off())).toContain('aria-label="絞り込み（1 件適用中）"');
        expect(filter(staged, off())).toContain('<span class="filter-count">1</span>');
        expect(filter(staged, clearStormingFilter(off()))).toContain('aria-label="絞り込み"');
        expect(filter(staged, clearStormingFilter(off()))).not.toContain('filter-count');
        expect(filter(staged, off())).not.toContain('解決済みを表示');
        expect(filter(staged, off('PinLockedBranch'))).toBe('');
        expect(filter(plain, off())).toBe('');
        expect(shownStorming(staged, clearStormingFilter(off()))?.options).toEqual({ level: 'big-picture' });
    });

    test('the detail of a stage: the stage it comes after, its main flow, its exceptions (icons), and the way to its view', async () => {
        const { stormings, diagnostics } = await viewService(await STAGED).refresh();
        const html = renderToStaticMarkup(
            <I18nProvider lang="en">
                <StormingDetails
                    stormings={stormings}
                    selected="es/ConvenienceStoreIssuance/Issuance"
                    render={undefined}
                    level="big-picture"
                    model={null}
                    mode="name"
                    diagnostics={diagnostics}
                    history={null}
                    onSelect={() => {}}
                    onShowScope={() => {}}
                />
            </I18nProvider>,
        );
        expect(html).toContain('>Stage<');
        expect(html).toContain('class="es-action" aria-label="Show this stage"');
        expect(html).toContain('aria-label="Comes after" data-tooltip="Comes after">');
        expect(html).toContain('<a>Preparation</a>');
        expect(html).toContain('aria-label="Main flows"');
        expect(html).toContain('<ul class="es-list"><li><a>IssuanceFlow</a></li></ul>');
        expect(html).toContain('aria-label="Exceptions"');
        // an exception: its steps, where it returns to, and its view
        const exception = renderToStaticMarkup(
            <I18nProvider lang="en">
                <StormingDetails
                    stormings={stormings}
                    selected="es/ConvenienceStoreIssuance/OutsideServiceHoursBranch"
                    render={undefined}
                    level="big-picture"
                    model={null}
                    mode="name"
                    diagnostics={diagnostics}
                    history={null}
                    onSelect={() => {}}
                    onShowScope={() => {}}
                />
            </I18nProvider>,
        );
        expect(exception).toContain('aria-label="Returns to"');
        expect(exception).toContain('aria-label="Show this timeline"');
    });
});

describe('what the 絞り込み hides, and moving to what it hides', () => {
    const TEXT = `storming R "R" {
  event Placed "注文された"
  event Paid "支払われた"
  event Failed "支払いに失敗した"
  hotspot Currency "通貨は？" { on Paid status resolved resolution "円だけ" }
  hotspot Retry "再試行は？" { on Failed }
  hotspot Notice "失敗の知らせ方は？" { on Failed status resolved resolution "メールで" }
  hotspot Closing "締めは？" { status resolved resolution "毎月末" }
  timeline Main "通常" { Placed Paid }
  exception Failure "失敗" { Placed Failed }
}`;
    const choice = (hidden?: Hideable[], timeline?: string): StormingChoice => ({
        stormingId: 'R',
        level: 'big-picture',
        timelines: timeline ? { R: timeline } : {},
        ...(hidden && { hidden }),
    });
    const render = (node: ReactNode): string => renderToStaticMarkup(<I18nProvider lang="ja">{node}</I18nProvider>);

    test('「解決済みを表示」 is in the 絞り込み of every view of a storming with a resolved hotspot, each kind hidden counting one', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        const filter = (c: StormingChoice): string => render(<StormingFilter stormings={stormings} choice={c} onChange={() => {}} />);
        const r = stormings.find((x) => x.id === 'R')!;
        expect(hideableIn(r, {})).toEqual(['exceptions', 'resolvedHotspots']);
        expect(filter(choice())).toContain('aria-label="絞り込み"');
        expect(filter(choice())).not.toContain('filter-count');
        expect(filter(choice(['resolvedHotspots']))).toContain('<span class="filter-count">1</span>');
        expect(filter(choice(['exceptions', 'resolvedHotspots']))).toContain('<span class="filter-count">2</span>');
        // a timeline's view: its exceptions are what it shows; the resolved hotspots can still be hidden
        expect(hideableIn(r, { timelineId: 'Failure' })).toEqual(['resolvedHotspots']);
        expect(filter(choice(['exceptions', 'resolvedHotspots'], 'Failure'))).toContain('<span class="filter-count">1</span>');
        expect(shownHidden(stormings, choice(['exceptions', 'resolvedHotspots'], 'Failure'))).toEqual(new Set(['resolvedHotspots']));
        // without a resolved hotspot, no 「解決済みを表示」 (nor a 絞り込み, without exceptions either)
        const plain = (await viewService().refresh()).stormings[0]!;
        expect(hideableIn(plain, {})).toEqual([]);
    });

    test('hiding the resolved hotspots is the page’s own: the same view, the same layout, and nothing moves', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        expect(shownStorming(stormings, choice(['resolvedHotspots']))?.options).toEqual({ level: 'big-picture' });
        expect(shownStorming(stormings, choice(['exceptions', 'resolvedHotspots']))?.options).toEqual({ level: 'big-picture', hidden: ['exceptions'] });
        const graph = stormingGraph(stormings, choice())!.graph;
        expect(stormingGraph(stormings, choice(['resolvedHotspots']))!.graph).toBe(graph);
        const drawn = hideInDrawing(graph, shownHidden(stormings, choice(['resolvedHotspots'])));
        const node = (local: string) => drawn.nodes.find((n) => n.elementId === `es/R/${local}`);
        // folded: not drawn, its place left empty, its sticky's check standing for it (none for one on nothing)
        const id = (local: string) => graph.nodes.find((n) => n.elementId === `es/R/${local}`)!.id;
        expect(node('Currency')?.folded).toEqual([id('Paid')]);
        expect(node('Closing')?.folded).toEqual([]);
        expect(node('Retry')?.folded).toBeUndefined();
        expect(drawn.edges.some((e) => e.source === id('Currency'))).toBe(false);
        expect(drawn.nodeLayout).toBe(graph.nodeLayout);
    });

    test('moving to a hidden sticky shows what hides it first, whatever the kind: one kind when it is enough, else all', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        const both = choice(['exceptions', 'resolvedHotspots']);
        const reveal = (id: string): StormingChoice => revealIn(stormings, both, `es/R/${id}`);
        expect(reveal('Placed')).toBe(both);
        // an exception's event, an open hotspot on it: the exceptions shown again
        expect(reveal('Failed').hidden).toEqual(['resolvedHotspots']);
        expect(reveal('Retry').hidden).toEqual(['resolvedHotspots']);
        // a resolved hotspot on a sticky drawn, or on none: the resolved hotspots shown again
        expect(reveal('Currency').hidden).toEqual(['exceptions']);
        expect(reveal('Closing').hidden).toEqual(['exceptions']);
        // a resolved hotspot on an exception's event: both
        expect(reveal('Notice').hidden).toBeUndefined();
        // an earlier version's choice too
        const { hidden: _, ...legacy } = { ...choice(), exceptions: false };
        expect(revealIn(stormings, legacy, 'es/R/Failed')).toEqual(choice());
    });
});

describe('a storming selection’s name (the folded tree’s head line)', () => {
    test('its label or ID by the display mode, the storming’s own for the storming; its ID when it is not found', async () => {
        const { stormings } = await viewService().refresh();
        expect(stormingSelectionTitle(stormings, 'es/DeliveryCancellation/ShipmentCancelled', 'label')).toBe('配送がキャンセルされた');
        expect(stormingSelectionTitle(stormings, 'es/DeliveryCancellation/ShipmentCancelled', 'name')).toBe('ShipmentCancelled');
        expect(stormingSelectionTitle(stormings, 'es/DeliveryCancellation', 'label')).toBe('配送キャンセル');
        expect(stormingSelectionTitle(stormings, 'es/DeliveryCancellation/Gone', 'label')).toBe('Gone');
    });
});

describe('the detail’s back button', () => {
    /** The text and tooltip of the back button in the detail of `selected`, back to `backTo`, in `mode`. */
    const backButton = async (selected: string, backTo: string, mode: DisplayMode): Promise<{ name: string; tooltip: string }> => {
        const { stormings } = await viewService().refresh();
        const model = (await check({ 'a.dt': 'context Delivery {\n  aggregate Shipment "配送" {}\n  aggregate Route {}\n}\n' })).model!;
        const props: InspectorProps = {
            model,
            mode,
            stormings,
            selected,
            diagnostics: [],
            diff: { added: [], changed: [], removed: [] },
            base: null,
            sources: [],
            sourceFocus: undefined,
            statesView: () => null,
            stormingView: (_id, history) => history,
            tab: 'structure',
            onTab: () => {},
            onSelect: () => {},
            onReveal: () => {},
            onFocusContext: () => {},
            backTo,
            onBack: () => {},
        };
        const html = renderToStaticMarkup(
            <I18nProvider lang="en">
                <Inspector {...props} />
            </I18nProvider>,
        );
        return { name: html.match(/<span class="back-name">([^<]*)<\/span>/)![1], tooltip: html.match(/data-tooltip="([^"]*)"/)![1] };
    };

    test('names a storming element by its label in ラベル, by its ID in 名前', async () => {
        expect(await backButton('Delivery.Shipment', 'es/DeliveryCancellation/ShipmentCancelled', 'label')).toEqual({
            name: '配送がキャンセルされた',
            tooltip: 'Back to 配送がキャンセルされた',
        });
        expect((await backButton('Delivery.Shipment', 'es/DeliveryCancellation/ShipmentCancelled', 'name')).name).toBe('ShipmentCancelled');
        expect((await backButton('Delivery.Shipment', 'es/DeliveryCancellation', 'label')).name).toBe('配送キャンセル');
    });

    test('names a model element by its label in ラベル, by its name in 名前, and by its name when it has no label', async () => {
        expect((await backButton('es/DeliveryCancellation/ShipmentCancelled', 'Delivery.Shipment', 'label')).name).toBe('配送');
        expect((await backButton('es/DeliveryCancellation/ShipmentCancelled', 'Delivery.Shipment', 'name')).name).toBe('Shipment');
        expect((await backButton('es/DeliveryCancellation/ShipmentCancelled', 'Delivery.Route', 'label')).name).toBe('Route');
    });
});
