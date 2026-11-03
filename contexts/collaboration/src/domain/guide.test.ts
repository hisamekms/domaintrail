// The guide's map and what is known at once (guide.ts): from inline sources analyzed as the app does, the event
// storming's path to its goal, the four modeling patterns with their growing BC rows, the person's ✓ marks, the map
// without a goal, and the findings with where to go.
import { describe, expect, test } from 'bun:test';
import type { Diagnostic } from '@domaintrail/kernel';
import { analyzeDomain } from '@domaintrail/modeling';
import { analyzeStormings } from '@domaintrail/storming';
import type { Collaboration } from '../generated/index.js';
import {
    GUIDE_LIMITS,
    GUIDE_STEP_KEYS,
    guideFindings,
    guideMap,
    guideSnapshot,
    guideWorld,
    MODEL_PATTERNS,
    NO_GOAL,
    guideMarks,
    guideMaps,
    markableGuideMark,
    NO_MARKS,
    readGuideGoal,
    type GuideGoal,
    type GuideWorkspace,
} from './guide.js';

/** The workspace of inline sources: the model, the stormings and every finding, as the app analyzes them. */
async function workspace(files: Record<string, string>): Promise<GuideWorkspace> {
    const sources = Object.entries(files).map(([p, text]) => ({ path: p, text }));
    const domain = await analyzeDomain(sources.filter((s) => s.path.endsWith('.dt')));
    const es = await analyzeStormings(
        sources.filter((s) => s.path.endsWith('.dtes')),
        domain.model,
    );
    return { model: domain.model ?? null, stormings: es.stormings, diagnostics: [...domain.diagnostics, ...es.diagnostics] };
}

const EVENTS = ['Requested', 'Researched', 'Confirmed', 'Visited', 'Paid', 'Issued'].map((e) => `  event ${e}`).join('\n');
const FLOW = `  timeline Main {\n    Requested\n    Researched\n    Confirmed\n    Visited\n    Paid\n    Issued\n  }`;

/** A storming grown step by step: its brief, events, flow, an exception, a hotspot (open or resolved), Design Level. */
function storming(parts: { brief?: true; events?: true; flow?: true; exception?: true; hotspot?: 'open' | 'resolved'; design?: true }): string {
    return [
        parts.brief ? '/// 目的: 交付の流れをつかむ' : '',
        'storming Issue "交付" {',
        parts.events ? EVENTS : '  event Requested',
        parts.flow ? FLOW : '',
        parts.exception ? '  exception Closed {\n    Visited\n    Requested\n  }' : '',
        parts.hotspot === 'open' ? '  hotspot Days "何日かかる？"' : '',
        parts.hotspot === 'resolved' ? '  hotspot Days "何日かかる？" {\n    status resolved\n    resolution "3日"\n  }' : '',
        parts.design ? '  command Pay\n  aggregate Payment' : '',
        '}',
    ].join('\n');
}

const STORMING_VIEW = { view: { kind: 'Storming', storming: 'Issue', level: 'BigPicture', exceptions: true } } as unknown as Collaboration.ViewedAt;
const MODEL_VIEW = { view: { kind: 'ContextMap', all: false } } as unknown as Collaboration.ViewedAt;
/** The ES level for every storming of these tests. */
const esGoal = (level: 'BigPicture' | 'DesignLevel'): GuideGoal => ({
    es: Object.fromEntries(['Issue', 'ConvenienceStoreIssuance', 'A', 'B'].map((id) => [id, { level }])),
});
const BIG_PICTURE = esGoal('BigPicture');
/** One modeling journey, `j`. */
const one = (pattern: Collaboration.GuidePattern, goal?: string): GuideGoal => ({
    model: [{ id: 'j', name: 'J', pattern, ...(goal !== undefined && { goal }) }],
});

/** The map's steps as `key:state`, with `!` for the goal and `~` past it. */
const path = (map: Collaboration.GuideMap): string[] => map.steps.map((s) => `${s.key}:${s.state}${s.goal ? '!' : ''}${s.after ? '~' : ''}`);

describe('the goal and the world', () => {
    test('no goal is read for now: the map is "set the goal", whatever the files', async () => {
        const ws = await workspace({ 'issue.dtes': storming({ brief: true, events: true }) });
        expect(readGuideGoal(ws)).toEqual(NO_GOAL);
        const map = guideMap({ workspace: ws, goal: readGuideGoal(ws), marks: NO_MARKS, viewedAt: STORMING_VIEW });
        expect(map).toEqual({
            world: 'Storming',
            storming: 'Issue',
            steps: [{ key: 'setGoal', state: 'Here', goal: false, after: false, markable: false, marked: false }],
            contexts: [],
        } as never);
        // a modeling goal does not make a map in the storming world
        expect(path(guideMap({ workspace: ws, goal: one('Strategic'), marks: NO_MARKS, viewedAt: STORMING_VIEW }))).toEqual(['setGoal:Here']);
    });

    test('the world: the view, else the selection, else what the files hold', async () => {
        const both = await workspace({ 'issue.dtes': storming({}), 'a.dt': 'context A {\n  id AId: UUID\n}' });
        expect(guideWorld(both, STORMING_VIEW)).toBe('Storming');
        expect(guideWorld(both, MODEL_VIEW)).toBe('Model');
        expect(guideWorld(both, undefined, { kind: 'DtElement', element: 'A' } as never)).toBe('Model');
        expect(guideWorld(both, undefined, { kind: 'DtesStorming', storming: 'Issue' } as never)).toBe('Storming');
        expect(guideWorld(both)).toBe('None');
        expect(guideWorld(await workspace({ 'issue.dtes': storming({}) }))).toBe('Storming');
        expect(guideWorld(await workspace({ 'a.dt': 'context A {\n  id AId: UUID\n}' }))).toBe('Model');
        expect(guideWorld(await workspace({}))).toBe('None');
        // nothing written: neither world, whatever the view
        expect(guideWorld(await workspace({}), MODEL_VIEW)).toBe('None');
    });
});

describe('the event storming map', () => {
    test('Big Picture: the path to the questions, Design Level past the goal; here moves as the storming grows', async () => {
        const map = async (parts: Parameters<typeof storming>[0], goal: GuideGoal = BIG_PICTURE): Promise<string[]> =>
            path(guideMap({ workspace: await workspace({ 'issue.dtes': storming(parts) }), goal, marks: NO_MARKS, viewedAt: STORMING_VIEW }));
        expect(await map({})).toEqual(['brief:Here', 'events:Todo', 'flows:Todo', 'exceptions:Todo', 'questions:Todo!', 'designLevel:Todo~']);
        expect(await map({ brief: true })).toEqual(['brief:Done', 'events:Here', 'flows:Todo', 'exceptions:Todo', 'questions:Todo!', 'designLevel:Todo~']);
        expect(await map({ brief: true, events: true, flow: true })).toEqual([
            'brief:Done',
            'events:Done',
            'flows:Done',
            'exceptions:Here',
            'questions:Todo!',
            'designLevel:Todo~',
        ]);
        // an open question is not done; a resolved one is
        expect((await map({ brief: true, events: true, flow: true, exception: true, hotspot: 'open' })).slice(3)).toEqual([
            'exceptions:Done',
            'questions:Here!',
            'designLevel:Todo~',
        ]);
        // the goal reached: nothing is here; Design Level past it, still told
        expect((await map({ brief: true, events: true, flow: true, exception: true, hotspot: 'resolved', design: true })).slice(4)).toEqual([
            'questions:Done!',
            'designLevel:Done~',
        ]);
        // Design Level: the path ends there
        expect((await map({ brief: true, events: true, flow: true, exception: true, hotspot: 'resolved' }, esGoal('DesignLevel'))).slice(4)).toEqual([
            'questions:Done',
            'designLevel:Here!',
        ]);
    });

    test('a storming with stages: the exceptions step is done when every stage has one', async () => {
        const ws = await workspace({
            'stages.dtes': await Bun.file(new URL('../../../../test/fixtures/stages/convenience-store-stages.dtes', import.meta.url)).text(),
        });
        const map = guideMap({ workspace: ws, goal: BIG_PICTURE, marks: NO_MARKS });
        expect(map.storming as string).toBe('ConvenienceStoreIssuance');
        // its brief is missing; its first stage has no exception
        expect(path(map).slice(0, 4)).toEqual(['brief:Here', 'events:Done', 'flows:Done', 'exceptions:Todo']);
    });

    test('the storming in view, else the first', async () => {
        const ws = await workspace({ 'a.dtes': 'storming A {\n  event X\n}', 'b.dtes': '/// b\nstorming B {\n  event Y\n}' });
        const inView = { view: { kind: 'Storming', storming: 'B', level: 'BigPicture', exceptions: true } } as unknown as Collaboration.ViewedAt;
        expect(guideMap({ workspace: ws, goal: BIG_PICTURE, marks: NO_MARKS, viewedAt: inView }).storming as string).toBe('B');
        expect(
            guideMap({ workspace: ws, goal: BIG_PICTURE, marks: NO_MARKS, focus: { kind: 'DtesElement', storming: 'B', local: 'Y' } as never })
                .storming as string,
        ).toBe('B');
        expect(guideMap({ workspace: ws, goal: BIG_PICTURE, marks: NO_MARKS }).storming as string).toBe('A');
    });
});

const SALES = `/// 注文を受ける。
context Sales {
  terms {
    note: "備考"
  }
  id OrderId: UUID
  aggregate Order {
    id: OrderId
    note: String?
    state Draft
    state Confirmed
    create command place(id: OrderId) -> Draft
      emits OrderPlaced
    command confirm() Draft -> Confirmed
    invariant something "何か" { true }
  }
  event OrderPlaced {
    id: OrderId
  }
}`;
const BILLING = `context Billing {
  id InvoiceId: UUID
  aggregate Invoice {
    id: InvoiceId
    references order: Sales.OrderId -> Sales.Order
  }
}`;
const COMMON = `shared context Common {
  primitive Amount: Decimal
}`;

describe('the modeling maps', () => {
    const map = async (files: Record<string, string>, goal: GuideGoal, marked: readonly string[] = []): Promise<Collaboration.GuideMap> =>
        guideMap({ workspace: await workspace(files), goal, marks: guideMarks(marked.map((step) => ({ journey: 'j', step }))), viewedAt: MODEL_VIEW });

    test('each pattern: its steps in order, ending at its goal (the last of its goals by default)', async () => {
        // a context with nothing in it yet
        const empty = { 'a.dt': 'context A {\n  id AId: UUID\n}' };
        expect(path(await map(empty, one('Strategic')))).toEqual([
            'terms:Here',
            'subdomains:Todo',
            'bcSplit:Todo',
            'contextMap:Todo',
            'contexts:Todo',
            'invariants:Todo!',
        ]);
        expect(path(await map(empty, one('Strategic', 'contextMap'))).slice(3)).toEqual(['contextMap:Todo!', 'contexts:Todo~', 'invariants:Todo~']);
        expect(path(await map(empty, one('FromStorming')))).toEqual(['review:Here', 'bcCarved:Done', 'aggregates:Todo', 'commands:Todo', 'invariants:Todo!']);
        expect(path(await map(empty, one('OneContext', 'commands')))).toEqual([
            'terms:Here',
            'aggregates:Todo',
            'values:Done',
            'commands:Todo!',
            'invariants:Todo~',
            'policies:Todo~',
        ]);
        expect(path(await map(empty, one('Review')))).toEqual(['diagnostics:Done', 'termsAligned:Here', 'boundaries:Todo', 'invariants:Todo!']);
        // a goal the pattern does not end at: its last
        expect(path(await map(empty, one('Review', 'contextMap'))).at(-1)).toBe('invariants:Todo!');
        // every step has a key the model knows
        for (const p of Object.values(MODEL_PATTERNS)) for (const s of p.steps) expect(GUIDE_STEP_KEYS.has(s)).toBe(true);
    });

    test('the steps the files cannot tell: done by a ✓ mark only, and only those', async () => {
        const marked = await map({ 'sales.dt': SALES }, one('Strategic'), ['subdomains', 'bcSplit', 'terms', 'invariants']);
        expect(marked.steps.map((s): unknown[] => [s.key, s.state, s.markable, s.marked])).toEqual([
            ['terms', 'Done', false, false],
            ['subdomains', 'Done', true, true],
            ['bcSplit', 'Done', true, true],
            // one context: no line on the context map yet, and not marked
            ['contextMap', 'Here', true, false],
            // its one BC is in depth already
            ['contexts', 'Done', false, false],
            // a mark on a step the files tell changes nothing: Order has an invariant; that alone makes it done
            ['invariants', 'Done', false, false],
        ]);
    });

    test('pattern B on the shop: a row per context as they are added, its progress, the first not done here', async () => {
        const goal: GuideGoal = one('FromStorming');
        // no context yet (a storming only): one line, no rows
        const none = await map({ 'issue.dtes': storming({}) }, goal);
        expect(none.contexts).toEqual([]);
        expect(none.contextsAt as string).toBe('bcCarved');
        const single = await map({ 'sales.dt': SALES }, goal, ['review']);
        expect(path(single)).toEqual(['review:Done', 'bcCarved:Done', 'aggregates:Done', 'commands:Done', 'invariants:Done!']);
        expect(single.contexts).toEqual([
            { context: 'Sales', shared: false, aggregates: 1, commands: 2, invariants: 1, state: 'Done', marked: false },
        ] as never);
        // Billing added, its aggregate with no command nor invariant; Common, shared, done as it is (the model's order)
        const three = await map({ 'sales.dt': SALES, 'billing.dt': BILLING, 'common.dt': COMMON }, goal, ['review']);
        expect(path(three)).toEqual(['review:Done', 'bcCarved:Done', 'aggregates:Done', 'commands:Here', 'invariants:Todo!']);
        expect(three.contexts.map((r): unknown[] => [r.context, r.shared, r.aggregates, r.commands, r.invariants, r.state])).toEqual([
            ['Billing', false, 1, 0, 0, 'Todo'],
            ['Common', true, 0, 0, 0, 'Done'],
            ['Sales', false, 1, 2, 1, 'Done'],
        ]);
        // with the stormings, its commands step waits for a ref to the model
        const withStorming = await map({ 'sales.dt': SALES, 'issue.dtes': storming({ events: true }) }, goal, ['review']);
        expect(path(withStorming)[3]).toBe('commands:Here');
    });

    test('pattern A: the rows grow under "each BC in depth", here while that step is', async () => {
        const a = await map({ 'sales.dt': SALES, 'billing.dt': BILLING }, one('Strategic'), ['subdomains', 'bcSplit']);
        // Billing refers to Sales: the context map has a line
        expect(path(a)).toEqual(['terms:Done', 'subdomains:Done', 'bcSplit:Done', 'contextMap:Done', 'contexts:Here', 'invariants:Todo!']);
        expect(a.contextsAt as string).toBe('contexts');
        expect(a.contexts.map((r): unknown[] => [r.context, r.state])).toEqual([
            ['Billing', 'Here'],
            ['Sales', 'Done'],
        ]);
    });

    test('pattern C and D read the values, the emits, the policies and the findings', async () => {
        const c = await map({ 'sales.dt': SALES }, one('OneContext'));
        expect(path(c)).toEqual(['terms:Done', 'aggregates:Done', 'values:Done', 'commands:Done', 'invariants:Done!', 'policies:Todo~']);
        const d = await map({ 'billing.dt': 'context Billing {\n  aggregate Invoice {\n    id: Missing\n  }\n}' }, one('Review'));
        expect(path(d)[0]).toBe('diagnostics:Here');
        expect(path(await map({ 'sales.dt': SALES }, one('Review')))[0]).toBe('diagnostics:Done');
    });

    test('several modeling journeys: a map each, named, over its subject (the context for C, the stormings for B)', async () => {
        const ws = await workspace({ 'sales.dt': SALES, 'billing.dt': BILLING, 'common.dt': COMMON, 'issue.dtes': storming({ events: true }) });
        const goal: GuideGoal = {
            model: [
                { id: 'billing', name: 'Billing の深掘り', pattern: 'OneContext', context: 'Billing' },
                { id: 'all', name: '全体の見直し', pattern: 'Review' },
                { id: 'from-es', name: 'ES から', pattern: 'FromStorming', stormings: [] },
            ],
        };
        const maps = guideMaps({ workspace: ws, goal, marks: guideMarks([{ journey: 'from-es', step: 'review' }]), viewedAt: MODEL_VIEW });
        expect(maps.map((m): unknown[] => [m.journey, m.journeyName, m.pattern])).toEqual([
            ['billing', 'Billing の深掘り', 'OneContext'],
            ['all', '全体の見直し', 'Review'],
            ['from-es', 'ES から', 'FromStorming'],
        ]);
        // C on Billing: its one row; Billing has no terms of its own, an aggregate, no command
        expect(maps[0]?.contexts.map((r) => r.context as string)).toEqual(['Billing']);
        expect(path(maps[0] as Collaboration.GuideMap).slice(0, 4)).toEqual(['terms:Here', 'aggregates:Done', 'values:Done', 'commands:Todo']);
        // B over no storming: no ref is waited for; the mark is this journey's only
        expect(path(maps[2] as Collaboration.GuideMap)[0]).toBe('review:Done');
        expect(path(maps[1] as Collaboration.GuideMap).slice(0, 2)).toEqual(['diagnostics:Done', 'termsAligned:Here']);
        // the storming world: no modeling map
        expect(guideMaps({ workspace: ws, goal, marks: NO_MARKS, viewedAt: STORMING_VIEW }).map((m) => m.steps[0].key as string)).toEqual(['setGoal']);
        // a journey's marks stay its own: another journey's ✓ does not count
        expect(
            path(
                guideMaps({ workspace: ws, goal, marks: guideMarks([{ journey: 'all', step: 'review' }]), viewedAt: MODEL_VIEW })[2] as Collaboration.GuideMap,
            )[0],
        ).toBe('review:Here');
    });

    test('a BC row marked done by its context: done, and the next row not done is here', async () => {
        const goal = one('Strategic');
        const marks = guideMarks([
            { journey: 'j', step: 'subdomains' },
            { journey: 'j', step: 'bcSplit' },
            { journey: 'j', step: 'contexts', context: 'Billing' },
        ]);
        const map = guideMap({ workspace: await workspace({ 'sales.dt': SALES, 'billing.dt': BILLING }), goal, marks, viewedAt: MODEL_VIEW });
        expect(map.contexts.map((r): unknown[] => [r.context, r.state, r.marked])).toEqual([
            ['Billing', 'Done', true],
            ['Sales', 'Done', false],
        ]);
        expect(path(map)[4]).toBe('contexts:Done');
    });

    test('which marks a person may set: a step the files cannot tell, or a row under a rows step', () => {
        expect(markableGuideMark({ step: 'bcSplit' })).toBe(true);
        expect(markableGuideMark({ step: 'events' })).toBe(false);
        expect(markableGuideMark({ step: 'contexts', context: 'Sales' })).toBe(true);
        expect(markableGuideMark({ step: 'bcSplit', context: 'Sales' })).toBe(false);
    });

    test('deterministic: the same workspace and goal give the same map', async () => {
        const ws = await workspace({ 'sales.dt': SALES, 'billing.dt': BILLING });
        const input = { workspace: ws, goal: one('Strategic'), marks: guideMarks([{ journey: 'j', step: 'bcSplit' }]), viewedAt: MODEL_VIEW };
        expect(guideMap(input)).toEqual(guideMap(input));
    });
});

describe('what is known at once', () => {
    test('in a storming: its brief, the stages without exceptions (their view), open hotspots, long labels', async () => {
        const fixture = await Bun.file(new URL('../../../../test/fixtures/stages/convenience-store-stages.dtes', import.meta.url)).text();
        const long = `event ResidentCertificateRequested "${'住民票を取ってきてと家族に言われた'.repeat(6)}"`;
        const ws = await workspace({
            'stages.dtes': fixture.replace('event ResidentCertificateRequested "住民票を取ってきてと言われた"', `hotspot Days "何日？"\n  ${long}`),
        });
        const [first] = ws.stormings;
        const found = guideFindings(ws, 'Storming', first);
        expect(found.map((f) => [f.kind, f.count, f.subject])).toEqual([
            ['StormingWithoutBrief', 1, '住民票などのコンビニ交付（ビッグピクチャ）'],
            ['StageWithoutExceptions', 1, '依頼・準備'],
            ['OpenHotspots', 1, '住民票などのコンビニ交付（ビッグピクチャ）'],
            ['LongLabels', expect.any(Number), '住民票などのコンビニ交付（ビッグピクチャ）'],
        ] as never);
        expect(found[0]?.target).toEqual({ kind: 'DtesStorming', storming: 'ConvenienceStoreIssuance' } as never);
        // the stage's view, its exceptions shown
        expect(found[1]?.view).toEqual({
            kind: 'Storming',
            storming: 'ConvenienceStoreIssuance',
            level: 'BigPicture',
            stage: 'Preparation',
            exceptions: true,
        } as never);
        expect(found[2]?.target).toEqual({ kind: 'DtesElement', storming: 'ConvenienceStoreIssuance', local: 'Days' } as never);
        expect(found[3]?.target?.kind).toBe('DtesElement');
        // a storming without stages and without exceptions: its flow
        const flat = await workspace({ 'issue.dtes': storming({ brief: true, events: true, flow: true }) });
        expect(guideFindings(flat, 'Storming', flat.stormings[0]).map((f) => f.kind)).toEqual(['FlowWithoutExceptions']);
    });

    test('in the model: contexts without aggregates (their structure), aggregates without commands or invariants, the errors', async () => {
        const ws = await workspace({
            'sales.dt': SALES,
            'billing.dt': BILLING,
            'empty.dt': 'context Shipping {\n  id ShipmentId: UUID\n}',
            'broken.dt': 'context Broken {\n  aggregate B {\n    id: Missing\n  }\n}',
        });
        const found = guideFindings(ws, 'Model', undefined);
        expect(found.map((f) => [f.kind, f.count, f.subject])).toEqual([
            ['ContextWithoutAggregates', 1, 'Shipping'],
            ['AggregatesWithoutCommands', 2, undefined],
            ['AggregatesWithoutInvariants', 2, undefined],
            ['Errors', 1, undefined],
        ] as never);
        expect(found[0]?.view).toEqual({ kind: 'Structure', level: 'Detail', focus: ['Shipping'] } as never);
        expect(found[1]?.target).toEqual({ kind: 'DtElement', element: 'Billing.Invoice' } as never);
    });

    test('the findings of the world only; at most the limit', async () => {
        const ws = await workspace({ 'issue.dtes': storming({}), 'empty.dt': 'context Shipping {\n  id ShipmentId: UUID\n}' });
        expect(guideFindings(ws, 'Storming', ws.stormings[0]).map((f) => f.kind)).toEqual(['StormingWithoutBrief']);
        expect(guideFindings(ws, 'Model', undefined).map((f) => f.kind)).toEqual(['ContextWithoutAggregates']);
        expect(guideFindings(ws, 'None', ws.stormings[0]).map((f) => f.kind)).toEqual(['StormingWithoutBrief', 'ContextWithoutAggregates']);
        const many: Diagnostic[] = Array.from({ length: 30 }, (_, i) => ({
            file: `c${i}.dt`,
            start: { line: 1, column: 1 },
            end: { line: 1, column: 2 },
            severity: 'error',
            code: 'E001',
            message: 'x',
        }));
        const contexts = Array.from({ length: 12 }, (_, i) => `context C${i} {\n  id I${i}: UUID\n}`).join('\n');
        const crowded = await workspace({ 'c.dt': contexts });
        const found = guideFindings({ ...crowded, diagnostics: many }, 'Model', undefined);
        expect(found.length).toBeLessThanOrEqual(GUIDE_LIMITS.findings);
        expect(found.filter((f) => f.kind === 'ContextWithoutAggregates')).toHaveLength(GUIDE_LIMITS.perKind);
    });

    test('the snapshot: the map and the findings of its world', async () => {
        const ws = await workspace({ 'issue.dtes': storming({ brief: true, events: true, flow: true }) });
        const snapshot = guideSnapshot({ workspace: ws, goal: BIG_PICTURE, marks: NO_MARKS, viewedAt: STORMING_VIEW });
        expect(path(snapshot.maps[0])[3]).toBe('exceptions:Here');
        expect(snapshot.findings.map((f) => f.kind)).toEqual(['FlowWithoutExceptions']);
    });
});
