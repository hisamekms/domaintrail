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
    chooseFlow,
    choosePlace,
    chooseScope,
    chooseStorming,
    clearStormingFilter,
    drawnAs,
    FlowSwitch,
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
    withHidden,
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
    /** The choice with the exceptions hidden as an earlier version kept it, on the whole storming or a scope of the staged storming. */
    const off = (scope?: string): StormingChoice => ({
        stormingId: undefined,
        level: 'big-picture',
        timelines: scope ? { ConvenienceStoreIssuance: scope } : {},
        hidden: ['exceptions'],
    });

    test('a stage is a place, `@<stage ID>`; an unknown one is the whole storming', async () => {
        const { stormings } = await viewService(await STAGED).refresh();
        const choice = (scope: string): StormingChoice => ({
            stormingId: undefined,
            level: 'big-picture',
            timelines: { ConvenienceStoreIssuance: scope },
            flow: 'all',
        });
        expect(shownStorming(stormings, choice(stageChoice('Issuance')))?.options).toEqual({ level: 'big-picture', stageId: 'Issuance' });
        expect(shownStorming(stormings, choice('@Nowhere'))?.options).toEqual({ level: 'big-picture' });
    });

    test('an earlier version’s state is read as a place and a flow', async () => {
        const staged = (await viewService(await STAGED).refresh()).stormings;
        const plain = (await viewService().refresh()).stormings;
        // 「例外を表示」 off: the main flows only, on the whole storming and a stage (of a storming with exceptions)
        expect(shownStorming(staged, off())).toMatchObject({ flow: 'main', options: { level: 'big-picture', flow: 'main' } });
        expect(shownStorming(staged, off(stageChoice('Issuance')))?.options).toEqual({ level: 'big-picture', stageId: 'Issuance', flow: 'main' });
        const { hidden: _, ...legacy } = { ...off(), exceptions: false };
        expect(shownStorming(staged, legacy)?.flow).toBe('main');
        expect(shownStorming(plain, off())?.options).toEqual({ level: 'big-picture' });
        // an exception's timeline: its case at its stage; a main flow's: it alone
        const old = (scope: string): StormingChoice => ({ stormingId: undefined, level: 'big-picture', timelines: { ConvenienceStoreIssuance: scope } });
        expect(shownStorming(staged, old('PinLockedBranch'))).toMatchObject({
            stageId: 'Issuance',
            flow: { exception: 'PinLockedBranch' },
            options: { level: 'big-picture', stageId: 'Issuance' },
        });
        expect(shownStorming(staged, old('IssuanceFlow'))).toMatchObject({
            stageId: 'Issuance',
            flow: { main: 'IssuanceFlow' },
            options: { level: 'big-picture', timelineId: 'IssuanceFlow' },
        });
        // a flow written since: the timeline is only the place
        expect(shownStorming(staged, { ...old('PinLockedBranch'), flow: 'main' })).toMatchObject({ stageId: 'Issuance', flow: 'main' });
        // written again, in the new words
        expect(chooseFlow(staged, off(), 'all')).toEqual({ stormingId: 'ConvenienceStoreIssuance', level: 'big-picture', timelines: {}, flow: 'all' });
    });

    test('the 絞り込み has no exceptions: the flow is beside the breadcrumb; 「すべて解除」 leaves the flow', async () => {
        const staged = (await viewService(await STAGED).refresh()).stormings;
        const render = (node: ReactNode): string => renderToStaticMarkup(<I18nProvider lang="ja">{node}</I18nProvider>);
        const filter = (choice: StormingChoice): string => render(<StormingFilter stormings={staged} choice={choice} onChange={() => {}} />);
        // nothing to hide in it (no resolved hotspot): no button at all
        expect(filter(off())).toBe('');
        const bar = render(<StormingToolbar stormings={staged} choice={off()} mode="label" onChange={() => {}} />);
        expect(bar).not.toContain('例外を表示');
        expect(bar).not.toContain('例外を含む');
        expect(bar).toContain('role="group" aria-label="流れ"');
        expect(shownStorming(staged, clearStormingFilter(off()))?.flow).toBe('main');
        expect(clearStormingFilter(withHidden(off(), 'resolvedHotspots', true))).toEqual(off());
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

describe('the place and the flow (ADR 0032 §11)', () => {
    // 配車: two stages, the second with two main flows; 注文: no stages and no exceptions, two main flows; 返品: one flow
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
    const flowOf = (stormings: Parameters<typeof shownStorming>[0], c: StormingChoice): unknown => {
        const shown = shownStorming(stormings, c);
        return { place: shown?.stageId ?? '', flow: shown?.flow };
    };
    /** The flow switch's choices as they read, the chosen ones in brackets. */
    const switchOf = (html: string): string[] =>
        [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(([, attrs, text]) => {
            const words = text!.replace(/<[^>]+>/g, '').trim();
            return /class="[^"]*\bactive\b/.test(attrs!) ? `[${words}]` : words;
        });
    const bar = (stormings: Parameters<typeof shownStorming>[0], c: StormingChoice): string[] =>
        switchOf(render(<FlowSwitch stormings={stormings} choice={c} mode="label" onChange={() => {}} />));

    test('the flow’s changes, as the preview’s: the place kept, one exception or one main flow chosen, a storming again with every flow', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        expect(flowOf(stormings, start)).toEqual({ place: '', flow: 'all' });
        const main = chooseFlow(stormings, start, 'main');
        expect(flowOf(stormings, main)).toEqual({ place: '', flow: 'main' });
        expect(shownStorming(stormings, main)?.options).toEqual({ level: 'big-picture', flow: 'main' });
        // an exception on the whole storming: its case there
        const failed = chooseFlow(stormings, main, { exception: 'AllocFailed' });
        expect(flowOf(stormings, failed)).toEqual({ place: '', flow: { exception: 'AllocFailed' } });
        expect(shownStorming(stormings, failed)?.options).toEqual({ level: 'big-picture' });
        // one main flow: drawn alone, the place its stage
        const collect = chooseFlow(stormings, failed, { main: 'AllocCollect' });
        expect(flowOf(stormings, collect)).toEqual({ place: 'Allocation', flow: { main: 'AllocCollect' } });
        expect(shownStorming(stormings, collect)?.options).toEqual({ level: 'big-picture', timelineId: 'AllocCollect' });
        expect(flowOf(stormings, chooseFlow(stormings, collect, 'all'))).toEqual({ place: 'Allocation', flow: 'all' });
        // another place: the exception kept when it is there, else every flow; one main flow is the main flows
        expect(flowOf(stormings, choosePlace(stormings, failed, stageChoice('Allocation')))).toEqual({
            place: 'Allocation',
            flow: { exception: 'AllocFailed' },
        });
        expect(flowOf(stormings, choosePlace(stormings, failed, stageChoice('Intake')))).toEqual({ place: 'Intake', flow: 'all' });
        expect(flowOf(stormings, choosePlace(stormings, collect, stageChoice('Intake')))).toEqual({ place: 'Intake', flow: 'main' });
        // another storming: every flow
        expect(flowOf(stormings, chooseStorming(main, 'O'))).toEqual({ place: '', flow: 'all' });
        // the level is another axis
        expect(shownStorming(stormings, { ...failed, level: 'design-level' })?.flow).toEqual({ exception: 'AllocFailed' });
    });

    test('the switch: 主な流れ (▾ where there are several), 例外も, 例外 ▾; 主な流れ ▾ alone without exceptions; nothing with one flow', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        expect(bar(stormings, start)).toEqual(['主な流れ', '▾', '[例外も]', '例外▾']);
        expect(bar(stormings, chooseFlow(stormings, start, 'main'))).toEqual(['[主な流れ]', '[▾]', '例外も', '例外▾']);
        expect(bar(stormings, chooseFlow(stormings, start, { exception: 'IntakeCancel' }))).toEqual(['主な流れ', '▾', '例外も', '[例外: 取消▾]']);
        expect(bar(stormings, chooseFlow(stormings, start, { main: 'AllocCollect' }))).toEqual(['[主な流れ: 回収]', '[▾]', '例外も', '例外▾']);
        // a stage with one main flow: no ▾ to choose one
        expect(bar(stormings, choosePlace(stormings, start, stageChoice('Intake')))).toEqual(['主な流れ', '[例外も]', '例外▾']);
        // no exceptions, two main flows: 主な流れ ▾ only
        expect(bar(stormings, chooseStorming(start, 'O'))).toEqual(['主な流れ▾']);
        expect(bar(stormings, chooseFlow(stormings, chooseStorming(start, 'O'), { main: 'Quick' }))).toEqual(['[主な流れ: 即時▾]']);
        expect(bar(stormings, chooseStorming(start, 'N'))).toEqual([]);
        // the place is the breadcrumb: the storming › its stage, すべて the whole; no stage picker without stages
        const crumbs = render(<StormingToolbar stormings={stormings} choice={start} mode="label" onChange={() => {}} />);
        expect(crumbs).toContain('aria-label="ステージ: すべて"');
        expect(crumbs).not.toContain('（例外を含む）');
        expect(render(<StormingToolbar stormings={stormings} choice={chooseStorming(start, 'O')} mode="label" onChange={() => {}} />)).not.toContain(
            'ステージ',
        );
    });

    test('a case is drawn from the layout of every flow: the other exceptions left out where they stood', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        const at = (c: StormingChoice) => stormingGraph(stormings, c)!.graph;
        const cancel = chooseFlow(stormings, start, { exception: 'IntakeCancel' });
        expect(at(cancel)).toBe(at(start));
        const drawn = drawnAs(stormings, cancel, at(cancel));
        const events = (g: typeof drawn): string[] => g.nodes.filter((n) => n.kind === 'esEvent').map((n) => n.elementId.split('/')[2]!);
        expect(events(drawn)).not.toContain('Rej');
        expect(events(drawn)).not.toContain('AllocFail');
        expect(events(drawn)).toContain('Cancel');
        expect(drawn.nodeLayout).toBe(at(start).nodeLayout);
        // every flow: as laid out
        expect(drawnAs(stormings, start, at(start))).toBe(at(start));
    });
});

describe('what the 絞り込み hides, and moving to what it does not draw', () => {
    const TEXT = `storming R "R" {
  event Placed "注文された"
  event Paid "支払われた"
  event Failed "支払いに失敗した"
  event Late "遅れた"
  hotspot Currency "通貨は？" { on Paid status resolved resolution "円だけ" }
  hotspot Retry "再試行は？" { on Failed }
  hotspot Notice "失敗の知らせ方は？" { on Failed status resolved resolution "メールで" }
  hotspot Closing "締めは？" { status resolved resolution "毎月末" }
  timeline Main "通常" { Placed Paid }
  exception Failure "失敗" { Placed Failed }
  exception Delay "遅延" { Placed Late }
}`;
    const choice = (hidden?: Hideable[], flow?: StormingChoice['flow']): StormingChoice => ({
        stormingId: 'R',
        level: 'big-picture',
        timelines: {},
        ...(flow && { flow }),
        ...(hidden && { hidden }),
    });
    const render = (node: ReactNode): string => renderToStaticMarkup(<I18nProvider lang="ja">{node}</I18nProvider>);

    test('「解決済みを表示」 is the 絞り込み’s only kind, in every view of a storming with a resolved hotspot', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        const filter = (c: StormingChoice): string => render(<StormingFilter stormings={stormings} choice={c} onChange={() => {}} />);
        const r = stormings.find((x) => x.id === 'R')!;
        expect(hideableIn(r)).toEqual(['resolvedHotspots']);
        expect(filter(choice())).toContain('aria-label="絞り込み"');
        expect(filter(choice())).not.toContain('filter-count');
        expect(filter(choice())).not.toContain('例外');
        expect(filter(choice(['resolvedHotspots']))).toContain('<span class="filter-count">1</span>');
        expect(filter(choice(['resolvedHotspots'], { exception: 'Failure' }))).toContain('<span class="filter-count">1</span>');
        // the flow is not a narrowing: the main flows only count nothing
        expect(filter(choice(undefined, 'main'))).not.toContain('filter-count');
        // without a resolved hotspot, no 絞り込み
        const plain = (await viewService().refresh()).stormings[0]!;
        expect(hideableIn(plain)).toEqual([]);
    });

    test('hiding the resolved hotspots is the page’s own: the same view, the same layout, and nothing moves', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        expect(shownStorming(stormings, choice(['resolvedHotspots']))?.options).toEqual({ level: 'big-picture' });
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

    test('moving to a sticky not drawn: the flow first (another case, else every flow), then what the 絞り込み hides', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        const main = choice(['resolvedHotspots'], 'main');
        const reveal = (c: StormingChoice, id: string): StormingChoice => revealIn(stormings, c, `es/R/${id}`);
        expect(reveal(main, 'Placed')).toBe(main);
        // an exception's event, an open hotspot on it: every flow
        expect(reveal(main, 'Failed')).toMatchObject({ flow: 'all', hidden: ['resolvedHotspots'] });
        expect(reveal(main, 'Retry')).toMatchObject({ flow: 'all', hidden: ['resolvedHotspots'] });
        // a resolved hotspot on a sticky drawn, or on none: the resolved hotspots shown again, the flow kept
        expect(reveal(main, 'Currency')).toMatchObject({ flow: 'main' });
        expect(reveal(main, 'Currency').hidden).toBeUndefined();
        expect(reveal(main, 'Closing').flow).toBe('main');
        // a resolved hotspot on an exception's event: both
        expect(reveal(main, 'Notice')).toMatchObject({ flow: 'all' });
        expect(reveal(main, 'Notice').hidden).toBeUndefined();
        // in a case, another exception's sticky: that exception's case
        expect(reveal(choice(undefined, { exception: 'Failure' }), 'Late').flow).toEqual({ exception: 'Delay' });
        // an earlier version's choice too
        const { hidden: _, ...legacy } = { ...choice(), exceptions: false };
        expect(shownStorming(stormings, revealIn(stormings, legacy, 'es/R/Failed'))?.flow).toBe('all');
    });

    test('a row or a link opens a timeline’s view: an exception as its case', async () => {
        const { stormings } = await viewService(TEXT).refresh();
        expect(shownStorming(stormings, chooseScope(stormings, choice(), 'R', 'Failure'))?.flow).toEqual({ exception: 'Failure' });
        expect(shownStorming(stormings, chooseScope(stormings, choice(), 'R', 'Main'))?.options).toEqual({ level: 'big-picture', timelineId: 'Main' });
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
