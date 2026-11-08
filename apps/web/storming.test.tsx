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
    chooseStorming,
    chooseTimeline,
    clearStormingFilter,
    drawnRender,
    exceptionLayer,
    filterableIn,
    focusOn,
    mainFlowsOf,
    revealIn,
    scopeView,
    shownFocus,
    stormingDrawing,
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
    type StormingFocus,
    withExceptions,
} from './storming';
import { beginActions, problemText } from './storming-detail';
import { shownRow } from './storming-navigator';
import { Inspector, type InspectorProps } from './inspector';
import { check } from './test-helpers';
import type { DisplayMode, ViewLevel } from '@domaintrail/visualization';

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
        // `<level>|<main flow>`: the view shown, one main flow on its canvas
        const [level, main] = (opts.key ?? 'design-level|').split('|') as [ViewLevel, string];
        const render = drawnRender(stormings, { stormingId: undefined, level, timelines: main ? { [stormings[0]!.id]: main } : {} })!;
        return renderToStaticMarkup(
            <I18nProvider lang={opts.lang ?? 'en'}>
                <StormingDetails
                    stormings={stormings}
                    selected={`es/DeliveryCancellation/${id}`}
                    render={render}
                    level={level}
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

describe('the timeline and the exceptions’ layer (ADR 0032 §11)', () => {
    // 配車: two stages (the trunk 通常 through both, 回収 in the second), three exceptions; 注文: two main flows, no
    // stages nor exceptions; 返品: one flow
    const TEXT = `storming D "配車" {
  event Req "依頼を受け付けた"
  event Rej "取込に失敗した"
  event Cancel "依頼が取り消された"
  event Alloc "配車を組んだ"
  event AllocFail "自動配車できなかった"
  event Assign "担当を割り当てた"
  event Route "ルートを計算した"
  event Collect "回収した"
  stage Intake "受付" {
    timeline IntakeMain "通常" { Req }
    exception IntakeErr "取込エラー" { Req Rej }
    exception IntakeCancel "取消" { Req Cancel }
  }
  stage Allocation "配車" after Intake {
    timeline AllocMain "通常" { Alloc Assign Route }
    timeline AllocCollect "回収" { Assign Collect }
    exception AllocFailed "失敗" { Alloc AllocFail then Assign }
  }
}
storming O "注文" {
  event Ordered "注文を受けた"
  event Paid "支払を受けた"
  event Shipped "出荷した"
  timeline Normal "通常" { Ordered Paid Shipped }
  timeline Quick "即時" { Ordered Shipped }
}
storming N "返品" {
  event Asked "返品を受け付けた"
  timeline Only "通常" { Asked }
}`;
    const start: StormingChoice = { stormingId: 'D', level: 'big-picture', timelines: {} };
    const render = (node: ReactNode): string => renderToStaticMarkup(<I18nProvider lang="ja">{node}</I18nProvider>);
    const toolbar = (stormings: Parameters<typeof shownStorming>[0], c: StormingChoice, focus: StormingFocus | null = null): string =>
        render(<StormingToolbar stormings={stormings} choice={c} focus={focus} mode="label" onView={() => {}} />);

    test('the breadcrumb: the storming › すべて or a main flow (the trunk through every stage is one); none with one main flow', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        expect(mainFlowsOf(stormings.find((s) => s.id === 'D')!).map((f) => f.id)).toEqual(['IntakeMain', 'AllocCollect']);
        expect(toolbar(stormings, start)).toContain('aria-label="タイムライン: すべて"');
        expect(toolbar(stormings, chooseTimeline(start, 'D', 'AllocCollect'))).toContain('aria-label="タイムライン: 回収"');
        expect(toolbar(stormings, chooseStorming(start, 'O'))).toContain('aria-label="タイムライン: すべて"');
        expect(toolbar(stormings, chooseStorming(start, 'N'))).not.toContain('aria-label="タイムライン');
        // no stage to show on its own, no exception among the timelines
        expect(toolbar(stormings, start)).not.toContain('受付');
        // one main flow: the same layout as every flow
        const collect = chooseTimeline(start, 'D', 'AllocCollect');
        expect(shownStorming(stormings, collect)?.options).toEqual({ level: 'big-picture' });
        expect(stormingGraph(stormings, collect)!.graph).toBe(stormingGraph(stormings, start)!.graph);
        const drawn = stormingDrawing(stormings, collect, null)!;
        const events = drawn.nodes
            .filter((n) => n.kind === 'esEvent')
            .map((n) => n.elementId.split('/')[2])
            .sort();
        // the trunk before it, 回収, and the exception branching off the trunk before it; not 通常's Route
        expect(events).toEqual(['Alloc', 'AllocFail', 'Assign', 'Cancel', 'Collect', 'Rej', 'Req']);
        const all = stormingGraph(stormings, start)!.graph;
        for (const n of drawn.nodes) expect(drawn.nodeLayout[n.id]).toEqual(all.nodeLayout[n.id]!);
    });

    test('the toggle: ↳ 例外 and how many it lays over the canvas; included or not; none without exceptions', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        expect(exceptionLayer(stormings, start)).toEqual({ included: true, exceptions: ['IntakeErr', 'IntakeCancel', 'AllocFailed'] });
        const bar = toolbar(stormings, start);
        expect(bar).toContain('class="exception-layer on"');
        expect(bar).toContain('aria-pressed="true"');
        expect(bar).toContain('<span class="exception-layer-count">3</span>');
        const off = withExceptions(start, false);
        expect(toolbar(stormings, off)).toContain('class="exception-layer"');
        expect(shownStorming(stormings, off)?.options).toEqual({ level: 'big-picture', hidden: ['exceptions'] });
        // the count of one main flow: those branching off it (and the trunk before it)
        expect(exceptionLayer(stormings, chooseTimeline(start, 'D', 'AllocCollect'))?.exceptions).toEqual(['IntakeErr', 'IntakeCancel', 'AllocFailed']);
        expect(toolbar(stormings, chooseStorming(start, 'O'))).not.toContain('exception-layer');
        // not in the 絞り込み
        expect(render(<StormingFilter stormings={stormings} choice={off} onChange={() => {}} />)).toBe('');
    });

    test('emphasizing an exception: included first; すべて when the main flow shown has it not; its toggle names it with ×', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        const off = withExceptions(chooseTimeline(start, 'D', 'AllocCollect'), false);
        const { choice, focus } = focusOn(stormings, off, 'D', 'IntakeCancel');
        expect(exceptionLayer(stormings, choice)?.included).toBe(true);
        expect(shownStorming(stormings, choice)?.main?.id).toBe('AllocCollect');
        expect(shownFocus(stormings, choice, focus)).toBe('IntakeCancel');
        const bar = toolbar(stormings, choice, focus);
        expect(bar).toContain('class="exception-layer focus"');
        expect(bar).toContain('例外: 取消');
        expect(bar).toContain('aria-label="強調をやめる"');
        // drawn faint off its path; nothing moves, nothing more left out
        const drawn = stormingDrawing(stormings, choice, focus)!;
        const plain = stormingDrawing(stormings, choice, null)!;
        expect(drawn.nodes.map((n) => n.id)).toEqual(plain.nodes.map((n) => n.id));
        expect(drawn.nodes.filter((n) => n.dimmed).length).toBeGreaterThan(0);
        // the emphasis is not kept with the choice, and another storming or excluding ends it
        expect(JSON.stringify(choice)).not.toContain('IntakeCancel');
        expect(shownFocus(stormings, withExceptions(choice, false), focus)).toBeUndefined();
        expect(shownFocus(stormings, chooseStorming(choice, 'O'), focus)).toBeUndefined();
    });

    test('a row or a link (`scopeView`): a storming all its timelines; a stage its frame; a main flow on the canvas; an exception emphasized', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        const collect = chooseTimeline(start, 'D', 'AllocCollect');
        const focus: StormingFocus = { stormingId: 'D', exceptionId: 'AllocFailed' };
        expect(scopeView(stormings, collect, focus, 'D', '')).toEqual({ choice: chooseStorming(collect, 'D'), focus: null });
        // a stage: the same canvas, the camera to its frame
        expect(scopeView(stormings, collect, focus, 'D', stageChoice('Intake'))).toEqual({ choice: collect, focus, frame: { stage: 'Intake' } });
        // a main flow's timeline: its main flow (the trunk's of any stage)
        expect(shownStorming(stormings, scopeView(stormings, start, null, 'D', 'AllocMain').choice)?.main?.id).toBe('IntakeMain');
        // an exception: emphasized, the camera to its path
        const exception = scopeView(stormings, withExceptions(start, false), null, 'D', 'IntakeErr');
        expect(exception.focus).toEqual({ stormingId: 'D', exceptionId: 'IntakeErr' });
        expect(exception.frame).toEqual({ exception: 'IntakeErr' });
        expect(exceptionLayer(stormings, exception.choice)?.included).toBe(true);
    });

    test('the navigator’s rows of what the canvas shows: the trunk’s of every stage while the trunk is on it', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        const row = (c: StormingChoice, id: string, kind: 'timeline' | 'storming' = 'timeline', exception?: true): boolean =>
            shownRow(stormings, c, null, { key: id, kind, stormingId: 'D', id, ...(exception && { exception }) }, undefined);
        const trunk = chooseTimeline(start, 'D', 'IntakeMain');
        expect(row(trunk, 'IntakeMain')).toBe(true);
        expect(row(trunk, 'AllocMain')).toBe(true);
        expect(row(trunk, 'AllocCollect')).toBe(false);
        expect(row(trunk, 'D', 'storming')).toBe(false);
        expect(row(start, 'D', 'storming')).toBe(true);
        expect(row(start, 'IntakeErr', 'timeline', true)).toBe(false);
    });

    test('an earlier version’s state: a stage is すべて; an exception すべて with its exceptions; a main flow’s timeline its main flow; 「例外を表示」 off is excluded', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        const old = (scope: string, extra: Partial<StormingChoice> = {}): StormingChoice => ({ ...start, timelines: { D: scope }, ...extra });
        expect(shownStorming(stormings, old('@Allocation'))?.main).toBeUndefined();
        expect(shownStorming(stormings, old('AllocCollect'))?.main?.id).toBe('AllocCollect');
        expect(shownStorming(stormings, old('AllocMain'))?.main?.id).toBe('IntakeMain');
        expect(shownStorming(stormings, old('AllocFailed', { hidden: ['exceptions'] }))).toMatchObject({ main: undefined, options: { level: 'big-picture' } });
        expect(shownStorming(stormings, { ...start, exceptions: false })?.options).toEqual({ level: 'big-picture', hidden: ['exceptions'] });
        expect(shownStorming(stormings, { ...start, hidden: ['exceptions'] })?.options).toEqual({ level: 'big-picture', hidden: ['exceptions'] });
        // a trial of this version's flow
        expect(shownStorming(stormings, { ...start, flow: 'main' })?.options).toEqual({ level: 'big-picture', hidden: ['exceptions'] });
        expect(shownStorming(stormings, { ...start, flow: { main: 'AllocCollect' } })?.main?.id).toBe('AllocCollect');
        // written again in this version's words
        expect(withExceptions({ ...start, exceptions: false, flow: 'main' }, true)).toEqual(start);
    });
});

describe('what the 絞り込み hides, and moving to what is not drawn', () => {
    const TEXT = `storming R "R" {
  event Placed "注文された"
  event Paid "支払われた"
  event Failed "支払いに失敗した"
  event Shipped "出荷した"
  hotspot Currency "通貨は？" { on Paid status resolved resolution "円だけ" }
  hotspot Retry "再試行は？" { on Failed }
  hotspot Notice "失敗の知らせ方は？" { on Failed status resolved resolution "メールで" }
  hotspot Closing "締めは？" { status resolved resolution "毎月末" }
  timeline Main "通常" { Placed Paid }
  timeline Fast "即日" { Placed Shipped }
  exception Failure "失敗" { Placed Failed }
}`;
    const choice = (hidden?: Hideable[], main?: string): StormingChoice => ({
        stormingId: 'R',
        level: 'big-picture',
        timelines: main ? { R: main } : {},
        ...(hidden && { hidden }),
    });
    const render = (node: ReactNode): string => renderToStaticMarkup(<I18nProvider lang="ja">{node}</I18nProvider>);

    test('「解決済みを表示」 is the 絞り込み’s only kind, in every view of a storming with a resolved hotspot', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        const filter = (c: StormingChoice): string => render(<StormingFilter stormings={stormings} choice={c} onChange={() => {}} />);
        const r = stormings.find((x) => x.id === 'R')!;
        expect(filterableIn(r)).toEqual(['resolvedHotspots']);
        expect(filter(choice())).toContain('aria-label="絞り込み"');
        expect(filter(choice())).not.toContain('例外');
        expect(filter(choice(['resolvedHotspots']))).toContain('<span class="filter-count">1</span>');
        // the exceptions excluded count nothing, and すべて解除 leaves them
        expect(filter(choice(['exceptions']))).not.toContain('filter-count');
        expect(clearStormingFilter(choice(['exceptions', 'resolvedHotspots']))).toEqual(choice(['exceptions']));
        const plain = (await viewService().refresh()).stormings[0]!;
        expect(filterableIn(plain)).toEqual([]);
    });

    test('hiding the resolved hotspots is the page’s own: the same view, the same layout, and nothing moves', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        expect(shownStorming(stormings, choice(['resolvedHotspots']))?.options).toEqual({ level: 'big-picture' });
        const graph = stormingGraph(stormings, choice())!.graph;
        expect(stormingGraph(stormings, choice(['resolvedHotspots']))!.graph).toBe(graph);
        const drawn = hideInDrawing(graph, shownHidden(stormings, choice(['resolvedHotspots'])));
        const node = (local: string) => drawn.nodes.find((n) => n.elementId === `es/R/${local}`);
        const id = (local: string) => graph.nodes.find((n) => n.elementId === `es/R/${local}`)!.id;
        expect(node('Currency')?.folded).toEqual([id('Paid')]);
        expect(node('Closing')?.folded).toEqual([]);
        expect(node('Retry')?.folded).toBeUndefined();
        expect(drawn.nodeLayout).toBe(graph.nodeLayout);
    });

    test('moving to a sticky not drawn: the exceptions included, then すべて, then what the 絞り込み hides', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        const reveal = (c: StormingChoice, local: string): StormingChoice => revealIn(stormings, c, `es/R/${local}`);
        const both = choice(['exceptions', 'resolvedHotspots']);
        expect(reveal(both, 'Placed')).toBe(both);
        expect(reveal(both, 'Failed').hidden).toEqual(['resolvedHotspots']);
        expect(reveal(both, 'Currency').hidden).toEqual(['exceptions']);
        expect(reveal(both, 'Notice').hidden).toBeUndefined();
        // one main flow shown: すべて for another's sticky
        const fast = choice(undefined, 'Fast');
        expect(reveal(fast, 'Shipped')).toBe(fast);
        expect(reveal(fast, 'Paid').timelines).toEqual({});
        // an earlier version's choice too
        const { hidden: _, ...legacy } = { ...choice(), exceptions: false };
        expect(reveal(legacy, 'Failed').hidden).toBeUndefined();
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
