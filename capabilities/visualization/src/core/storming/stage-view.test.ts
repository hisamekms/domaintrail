// The views of a storming with stages (docs/dtes-v0.1.md §3.7, §6, §10): the projection of the user's storming in
// stages, its grid and the layout of the grid (`layoutGrid`), and the same storming without stages, unchanged.
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { analyzeStormings, type Storming } from '@domaintrail/storming';
import { layoutGrid } from '../graph/grid.js';
import type { LaidOutGraph, NodeLayout } from '../graph/ir.js';
import type { RenderEventNode, RenderGraph, ViewOptions } from './ir.js';
import { renderToGraph, stormingGraphId, stormingViewKey } from './graph.js';
import { projectView } from './render.js';

const FIXTURES = path.join(import.meta.dir, '..', '..', '..', '..', '..', 'test', 'fixtures', 'stages');
const read = (name: string): Promise<string> => readFile(path.join(FIXTURES, name), 'utf8');

async function parse(text: string): Promise<Storming> {
    const a = await analyzeStormings([{ path: 's.dtes', text }], undefined);
    // an incomplete design (S024, S027) is drawn as written
    expect(a.diagnostics.filter((d) => d.severity === 'error' && d.code !== 'S024' && d.code !== 'S027')).toEqual([]);
    return a.stormings[0]!;
}

const STAGED = await parse(await read('convenience-store-stages.dtes'));
const ORIGINAL = await parse(await read('convenience-store.dtes'));

const BP: ViewOptions = { level: 'big-picture' };
const DL: ViewOptions = { level: 'design-level' };

const eventNodes = (g: RenderGraph): RenderEventNode[] => g.nodes.filter((n): n is RenderEventNode => n.type === 'event');
const nodesOf = (g: RenderGraph, eventId: string): RenderEventNode[] => eventNodes(g).filter((n) => n.eventId === eventId);
const only = (g: RenderGraph, eventId: string): RenderEventNode => {
    const list = nodesOf(g, eventId);
    expect(list.map((n) => n.eventId)).toEqual([eventId]);
    return list[0]!;
};
const eventOf = (g: RenderGraph, id: string): string => {
    const n = g.nodes.find((x) => x.id === id);
    return n?.type === 'event' ? n.eventId : id;
};
/** The chain into an event note: the command's note that causes it and the note of its aggregate the `emits` comes out of. */
const chainInto = (g: RenderGraph, eventNode: string): { command: string; aggregate?: string } => {
    const emits = g.edges.find((e) => e.type === 'semantic' && e.kind === 'emits' && e.target === eventNode)!;
    const source = g.nodes.find((n) => n.id === emits.source)!;
    return source.type === 'element' && source.kind === 'aggregate' ? { command: `n:${source.use}`, aggregate: source.id } : { command: source.id };
};
/** The element IDs of the element nodes of a view, each once. */
const elementsOf = (g: RenderGraph): string[] => [...new Set(g.nodes.flatMap((n) => (n.type === 'element' ? [n.elementId] : [])))].sort();
const edgesOf = (g: RenderGraph, type: 'rejoin' | 'stage'): string[] =>
    g.edges
        .filter((e) => e.type === type)
        .map((e) => `${eventOf(g, e.source)} -> ${eventOf(g, e.target)}`)
        .sort();

const laidOut = (render: RenderGraph, storming: Storming): LaidOutGraph => layoutGrid(renderToGraph(render, storming));

/** The main flows of the stages in time order. */
const MAIN = [
    'ResidentCertificateRequested',
    'IssuanceMethodResearched',
    'RequiredContentConfirmed',
    'RequiredCopiesConfirmed',
    'LeftWithMyNumberCard',
    'ConvenienceStoreVisited',
    'GovernmentServiceMenuSelected',
    'MyNumberCardRead',
    'PinEntered',
    'IssuingMunicipalitySelected',
    'CertificateOptionsSelected',
    'RequestDetailsConfirmed',
    'FeePaid',
    'CertificateDataCreated',
    'IssuanceRecorded',
    'CertificateIssuedAtMultiCopier',
    'MyNumberCardCollected',
    'CertificateContentChecked',
    'CertificateSubmitted',
    'CertificateAccepted',
];

const inside = (a: NodeLayout, b: NodeLayout): boolean => a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;

describe('the integrated canvas of a storming with stages', () => {
    const render = projectView(STAGED, BP);
    const laid = laidOut(render, STAGED);
    const at = (eventId: string): NodeLayout => laid.nodeLayout[only(render, eventId).id]!;

    test('the stages in time order, each a frame; the main flows one straight row, strictly left to right through every stage', () => {
        expect(render.nodes.filter((n) => n.type === 'stage').map((n) => n.id)).toEqual(['st:Issuance', 'st:Preparation', 'st:Submission']);
        const frames = ['st:Preparation', 'st:Issuance', 'st:Submission'].map((id) => laid.nodeLayout[id]!);
        for (let i = 1; i < frames.length; i++) expect(frames[i - 1]!.x + frames[i - 1]!.width).toBeLessThan(frames[i]!.x);
        const main = MAIN.map(at);
        for (let i = 1; i < main.length; i++) {
            expect(main[i]!.y).toBe(main[0]!.y);
            expect(main[i - 1]!.x + main[i - 1]!.width).toBeLessThan(main[i]!.x);
        }
        // every step of a main flow in its stage's frame, on row 0
        for (const id of MAIN.slice(0, 5)) expect(inside(at(id), frames[0]!)).toBe(true);
        for (const id of MAIN.slice(17)) expect(inside(at(id), frames[2]!)).toBe(true);
        for (const id of MAIN) expect(render.grid!.cells[only(render, id).id]!.row).toBe(0);
    });

    test('an exception hangs below the step it branches off from, flows right and stays in its stage’s frame', () => {
        const mainY = at('ConvenienceStoreVisited').y;
        const issuance = laid.nodeLayout['st:Issuance']!;
        const exceptions = eventNodes(render).filter((n) => !MAIN.includes(n.eventId));
        expect(exceptions.length).toBeGreaterThan(0);
        for (const n of exceptions) {
            const l = laid.nodeLayout[n.id]!;
            expect(l.y).toBeGreaterThan(mainY);
            const stage = n.id.startsWith('s:Submission:') ? 'st:Submission' : 'st:Issuance';
            expect(inside(l, laid.nodeLayout[stage]!)).toBe(true);
        }
        // PinLocked branches off MyNumberCardRead: one column to its right, below it
        const read = at('MyNumberCardRead');
        const locked = at('PinLocked');
        expect(locked.x).toBeGreaterThan(read.x + read.width);
        expect(locked.x).toBeLessThan(at('IssuingMunicipalitySelected').x);
        expect(inside(locked, issuance)).toBe(true);
    });

    test('an exception from the middle of a main flow shares its branch step: the event is drawn once, for both timelines', () => {
        const read = only(render, 'MyNumberCardRead');
        expect(read.occurrences.map((o) => `${o.timelineId}[${o.stepPath.join('.')}]`)).toEqual([
            'IssuanceFlow[2]',
            'PinForgottenBranch[0]',
            'PinLockedBranch[0]',
        ]);
        expect(only(render, 'ConvenienceStoreVisited').occurrences.map((o) => o.timelineId)).toEqual([
            'IssuanceFlow',
            'MaintenanceDayBranch',
            'MultiCopierNotSupportedBranch',
            'OutsideServiceHoursBranch',
        ]);
        // what the exceptions go on to is theirs: each drawn on its own lane
        expect(nodesOf(render, 'PinResetAtCityOffice')).toHaveLength(2);
        expect(nodesOf(render, 'VisitPostponed')).toHaveLength(2);
    });

    test('`after` joins the end of a stage’s main flow to the start of the next one’s', () => {
        expect(edgesOf(render, 'stage')).toEqual(['LeftWithMyNumberCard -> ConvenienceStoreVisited', 'MyNumberCardCollected -> CertificateContentChecked']);
    });

    test('`then` returns from an exception’s last step to a step of a main flow: of its stage, a later one or an earlier one', () => {
        expect(edgesOf(render, 'rejoin')).toEqual([
            'HeadedToSupportedStore -> ConvenienceStoreVisited',
            'PinResetAtCityOffice -> PinEntered',
            'PinResetAtCityOffice -> PinEntered',
            'ReissueDecided -> ConvenienceStoreVisited',
            'RequestedFromDomicileOffice -> CertificateContentChecked',
            'VisitPostponed -> ConvenienceStoreVisited',
            'VisitPostponed -> ConvenienceStoreVisited',
        ]);
        // the rejoin's route ends at the bottom of its target
        const e = render.edges.find((x) => x.type === 'rejoin' && eventOf(render, x.source) === 'RequestedFromDomicileOffice')!;
        const end = laid.edgeLayout[e.id]!.points.at(-1)!;
        const target = at('CertificateContentChecked');
        expect(end).toEqual({ x: target.x + target.width / 2, y: target.y + target.height });
    });

    test('each exception’s lane is captioned with its label, and its time order drawn as an exception’s, on the edge into its first step', () => {
        const graph = renderToGraph(render, STAGED);
        const captions = graph.edges.filter((e) => e.label).map((e) => e.label!.ja.label);
        const kindOf = (from: string, to: string): string | undefined =>
            graph.edges.find((e) => e.kind !== 'esRejoin' && eventOf(render, e.source) === from && eventOf(render, e.target) === to)?.kind;
        expect(kindOf('MyNumberCardRead', 'PinLocked')).toBe('esException');
        // an exception's lane is entered from the left, its caption above its first note
        const laid = layoutGrid(graph);
        const into = graph.edges.find((e) => e.kind === 'esException' && e.label?.ja.label === '暗証番号のロック')!;
        const first = laid.nodeLayout[into.target]!;
        expect(laid.edgeLayout[into.id]!.label).toMatchObject({ x: first.x });
        expect(laid.edgeLayout[into.id]!.label!.y).toBeLessThan(first.y);
        expect(laid.edgeLayout[into.id]!.points.at(-1)).toEqual({ x: first.x, y: first.y + first.height / 2 });
        expect(kindOf('MyNumberCardRead', 'PinEntered')).toBe('esSequence');
        expect(kindOf('LeftWithMyNumberCard', 'ConvenienceStoreVisited')).toBe('esSequence');
        expect(captions.sort()).toEqual(
            [
                '利用時間外',
                'メンテナンス日',
                'コピー機が非対応',
                'カードの期限切れ',
                'カードの破損（チップ）',
                '暗証番号を忘れた',
                '暗証番号のロック',
                '交付先が対象外',
                '提出先で受け取ってもらえない',
            ].sort(),
        );
    });

    test('no edge crosses a note: every route runs through the gutters between the cells', () => {
        for (const options of [BP, DL]) {
            const g = laidOut(projectView(STAGED, options), STAGED);
            expect(crossings(g)).toEqual([]);
        }
    });

    test('canonical: the order the exceptions are written in changes nothing (R06)', async () => {
        const reordered: Storming = {
            ...STAGED,
            elements: STAGED.elements.map((el) => (el.kind === 'stage' ? { ...el, timelines: [el.timelines[0]!, ...el.timelines.slice(1).reverse()] } : el)),
        };
        const strip = (g: RenderGraph): unknown => JSON.parse(JSON.stringify(g));
        expect(strip(projectView(reordered, BP))).toEqual(strip(render));
        expect(laidOut(projectView(reordered, BP), reordered).nodeLayout).toEqual(laid.nodeLayout);
    });

    test('its graph ID and view key are those of the integrated canvas', () => {
        expect(stormingGraphId(STAGED.id, render.options)).toBe('storming:ConvenienceStoreIssuance:big-picture:*');
        expect(stormingViewKey(render.options)).toBe('big-picture|');
    });
});

describe('the view of one stage', () => {
    const render = projectView(STAGED, { level: 'big-picture', stageId: 'Issuance' });
    const laid = laidOut(render, STAGED);

    test('its main flow and its exceptions, in its frame, from column 0', () => {
        expect(render.options).toEqual({ level: 'big-picture', stageId: 'Issuance' });
        expect(render.nodes.filter((n) => n.type === 'stage').map((n) => n.id)).toEqual(['st:Issuance']);
        expect(eventNodes(render).every((n) => n.id.startsWith('s:Issuance:'))).toBe(true);
        expect(nodesOf(render, 'LeftWithMyNumberCard')).toEqual([]);
        expect(render.grid!.cells[only(render, 'ConvenienceStoreVisited').id]).toEqual({ col: 0, row: 0 });
        for (const n of eventNodes(render)) expect(inside(laid.nodeLayout[n.id]!, laid.nodeLayout['st:Issuance']!)).toBe(true);
        expect(crossings(laid)).toEqual([]);
    });

    test('no `after`; a `then` to another stage is not drawn, one within it is', () => {
        expect(edgesOf(render, 'stage')).toEqual([]);
        expect(edgesOf(render, 'rejoin')).not.toContain('RequestedFromDomicileOffice -> CertificateContentChecked');
        expect(edgesOf(render, 'rejoin')).toContain('PinResetAtCityOffice -> PinEntered');
    });

    test('its graph ID and view key name the stage', () => {
        expect(stormingGraphId(STAGED.id, render.options)).toBe('storming:ConvenienceStoreIssuance:big-picture:@Issuance');
        expect(stormingViewKey(render.options)).toBe('big-picture|@Issuance');
    });

    test('a timeline of a stage is viewed as any timeline: its occurrences and their order, without a grid', () => {
        const one = projectView(STAGED, { level: 'big-picture', timelineId: 'PinLockedBranch' });
        expect(one.grid).toBeUndefined();
        expect(eventNodes(one).map((n) => n.eventId)).toEqual(['MyNumberCardRead', 'PinLocked', 'PinResetAtCityOffice']);
    });
});

describe('a storming without stages is drawn as before', () => {
    test('no grid, no frame, the prefix-merged canvas', () => {
        const render = projectView(ORIGINAL, BP);
        expect(render.grid).toBeUndefined();
        expect(render.nodes.some((n) => n.type === 'stage')).toBe(false);
        expect(renderToGraph(render, ORIGINAL).grid).toBeUndefined();
    });
});

describe('stages and `level design`', () => {
    const text = `storming L {
  event A
  event B {
    level design
  }
  event C
  event D {
    level design
  }
  event E
  event X
  event Y
  stage P {
    timeline Main {
      A
      B
      C
      D
      E
    }
    exception FromHidden {
      B
      X
      then D
    }
    exception Hidden {
      C
      Y
    }
  }
}
`;
    test('at Big Picture a hidden branch step branches off from the nearest visible step before it; a hidden `then` target returns to the next visible one', async () => {
        const s = await parse(text);
        const bp = projectView(s, BP);
        expect(nodesOf(bp, 'B')).toEqual([]);
        expect(nodesOf(bp, 'D')).toEqual([]);
        const seq = bp.edges.filter((e) => e.type === 'sequence').map((e) => `${eventOf(bp, e.source)}->${eventOf(bp, e.target)}`);
        expect(seq.sort()).toEqual(['A->C', 'A->X', 'C->E', 'C->Y'].sort());
        expect(edgesOf(bp, 'rejoin')).toEqual(['X -> E']);
        const laid = laidOut(bp, s);
        expect(crossings(laid)).toEqual([]);
        // at Design Level, as written
        const dl = projectView(s, DL);
        expect(edgesOf(dl, 'rejoin')).toEqual(['X -> D']);
        const dlSeq = dl.edges.filter((e) => e.type === 'sequence').map((e) => `${eventOf(dl, e.source)}->${eventOf(dl, e.target)}`);
        expect(dlSeq.sort()).toEqual(['A->B', 'B->C', 'B->X', 'C->D', 'C->Y', 'D->E'].sort());
    });
});

describe('Design Level elements in a view of stages', () => {
    const text = `storming D {
  event Placed
  event Paid
  event Failed
  event Retried
  actor Customer
  aggregate Order
  command Pay {
    by Customer
    handledBy Order
    emits Paid
    emits Failed
  }
  command Retry {
    emits Retried
  }
  policy RetryFailed {
    on Failed
    issues Retry
  }
  hotspot Limit "何回まで？" {
    on Failed
  }
  readmodel Lonely
  stage Ordering {
    timeline Main {
      Placed
      Paid
    }
    exception Failure {
      Placed
      Failed
      Retried
      then Paid
    }
  }
}
`;
    test('read left to right in the band above their event’s lane: command → aggregate → event → policy; the others below every stage', async () => {
        const s = await parse(text);
        const render = projectView(s, DL);
        const cells = render.grid!.cells;
        const cell = (id: string) => cells[id]!;
        const at = (eventId: string) => cell(only(render, eventId).id);
        // Pay emits Paid (the main flow) and Failed (the exception's lane): a chain into each, in the band above its lane
        for (const eventId of ['Paid', 'Failed']) {
            const { command, aggregate } = chainInto(render, only(render, eventId).id);
            expect(render.nodes.find((n) => n.id === command)).toMatchObject({ elementId: 'Pay' });
            expect(cell(command).row).toBe(at(eventId).row - 1);
            expect(cell(aggregate!)).toEqual({ col: cell(command).col + 1, row: cell(command).row });
            expect(cell(aggregate!).col).toBe(at(eventId).col - 1);
            // the actor stuck on top of its command
            expect(cell(`n:Customer@${command.slice(2)}`)).toEqual({ col: cell(command).col, row: cell(command).row - 1 });
        }
        expect(at('Failed').row).toBeGreaterThan(at('Paid').row);
        // the hotspot on top of its event; the policy after its trigger, before the command it issues
        expect(cell('n:Limit')).toEqual({ col: at('Failed').col, row: at('Failed').row - 1 });
        expect(cell('n:RetryFailed')).toEqual({ col: at('Failed').col + 1, row: at('Failed').row - 1 });
        expect(cell('n:Retry')).toEqual({ col: at('Retried').col - 1, row: at('Retried').row - 1 });
        expect(cell('n:RetryFailed').col).toBeLessThan(cell('n:Retry').col);
        expect(cell('n:Lonely').row).toBe(render.grid!.looseRow!);
        expect(crossings(laidOut(render, s))).toEqual([]);
        // Big Picture: the hotspot only, on top of its event
        const bp = projectView(s, BP);
        expect(Object.keys(bp.grid!.cells).filter((id) => id.startsWith('n:'))).toEqual(['n:Limit']);
        expect(bp.grid!.cells['n:Limit']).toEqual({ col: bp.grid!.cells[only(bp, 'Failed').id]!.col, row: bp.grid!.cells[only(bp, 'Failed').id]!.row - 1 });
    });

    test('an actor, read model or aggregate used by several commands: a note beside each command note, its edge to the next cell', async () => {
        const s = await parse(
            text.replace(
                '  command Retry {\n    emits Retried\n  }',
                '  readmodel Cart\n  command Retry {\n    reads Cart\n    handledBy Order\n    emits Retried\n  }',
            ),
        );
        const render = projectView(s, DL);
        const cells = render.grid!.cells;
        const commands = render.nodes.filter((n) => n.type === 'element' && n.kind === 'command').map((n) => n.id);
        expect(commands).toEqual(['n:Pay#1', 'n:Pay#2', 'n:Retry']);
        for (const command of commands) {
            const c = cells[command]!;
            const key = command.slice(2);
            // Retry, which a policy issues, has no actor
            if (key !== 'Retry') expect(cells[`n:Customer@${key}`]).toEqual({ col: c.col, row: c.row - 1 });
            expect(cells[`n:Order@${key}`]).toEqual({ col: c.col + 1, row: c.row });
        }
        expect(cells['n:Customer@Retry']).toBeUndefined();
        // the read model on the command's left, on its row (a policy's command reads it itself)
        expect(cells['n:Cart@Retry']).toEqual({ col: cells['n:Retry']!.col - 1, row: cells['n:Retry']!.row });
        expect(cells['n:Customer']).toBeUndefined();
        const g = laidOut(render, s);
        // every edge between a copy and its command joins neighbouring cells
        for (const e of render.edges.filter((x) => x.type === 'semantic' && ['by', 'reads', 'handledBy'].includes(x.kind))) {
            const [a, b] = [cells[e.source]!, cells[e.target]!];
            expect(Math.abs(a.col - b.col) + Math.abs(a.row - b.row)).toBe(1);
        }
        expect(crossings(g)).toEqual([]);
    });

    test('the cause of an event, with its actor and aggregate, in every view of it: the stages, the stage, a main flow and an exception', async () => {
        const s = await parse(text);
        // Pay emits Paid (the main flow) and Failed (the exception); no policy issues it
        const views: [ViewOptions, string][] = [
            [DL, 'Paid'],
            [{ ...DL, stageId: 'Ordering' }, 'Paid'],
            [{ ...DL, timelineId: 'Main' }, 'Paid'],
            [{ ...DL, timelineId: 'Failure' }, 'Failed'],
        ];
        for (const [options, eventId] of views) {
            const render = projectView(s, options);
            const event = only(render, eventId).id;
            const { command, aggregate } = chainInto(render, event);
            const key = command.slice(2);
            expect(render.nodes.find((n) => n.id === command)).toMatchObject({ elementId: 'Pay' });
            expect(aggregate).toBe(`n:Order@${key}`);
            const ids = render.edges.filter((e) => e.type === 'semantic').map((e) => `${e.kind}:${e.source}->${e.target}`);
            expect(ids).toEqual(expect.arrayContaining([`by:n:Customer@${key}->${command}`, `handledBy:${command}->${aggregate}`]));
            // never an emits from the command itself: it goes through its aggregate
            expect(render.edges.some((e) => e.type === 'semantic' && e.kind === 'emits' && e.source === command)).toBe(false);
            if (render.grid) {
                const cells = render.grid.cells;
                expect(cells[command]!.col).toBeLessThan(cells[aggregate!]!.col);
                expect(cells[aggregate!]!.col).toBeLessThan(cells[event]!.col);
                expect(crossings(laidOut(render, s))).toEqual([]);
            }
            // Big Picture: none of them
            const bp = projectView(s, { ...options, level: 'big-picture' });
            expect(elementsOf(bp)).not.toContain('Pay');
        }
        // Failed is not in the main flow: its emits is not drawn there
        const main = projectView(s, { ...DL, timelineId: 'Main' });
        expect(main.edges.some((e) => e.type === 'semantic' && e.kind === 'emits' && eventOf(main, e.target) === 'Failed')).toBe(false);
    });

    test('the cause of a step of the convenience store (EnterPin) in the stages, the stage, its main flow and an exception', async () => {
        const s = await parse(
            (await read('convenience-store-stages.dtes')).replace(
                '  stage Preparation',
                [
                    '  actor Resident',
                    '  aggregate Card',
                    '  command EnterPin {\n    by Resident\n    handledBy Card\n    emits PinEntered\n  }',
                    '  command ResetPin {\n    by Resident\n    emits PinResetAtCityOffice\n  }',
                    '  stage Preparation',
                ].join('\n'),
            ),
        );
        const has = (options: ViewOptions, ids: string[]): void => {
            const render = projectView(s, options);
            expect(elementsOf(render)).toEqual(expect.arrayContaining(ids));
            if (render.grid) expect(crossings(laidOut(render, s))).toEqual([]);
        };
        const enterPin = ['EnterPin', 'Resident', 'Card'];
        const resetPin = ['ResetPin', 'Resident'];
        has(DL, [...enterPin, ...resetPin]);
        has({ ...DL, stageId: 'Issuance' }, [...enterPin, ...resetPin]);
        has({ ...DL, timelineId: 'IssuanceFlow' }, enterPin);
        has({ ...DL, timelineId: 'PinLockedBranch' }, resetPin);
        const stage = projectView(s, { ...DL, stageId: 'Issuance' });
        const pinEntered = only(stage, 'PinEntered').id;
        expect(chainInto(stage, pinEntered)).toEqual({ command: 'n:EnterPin', aggregate: 'n:Card@EnterPin' });
        expect(stage.grid!.cells['n:Card@EnterPin']).toEqual({ col: stage.grid!.cells[pinEntered]!.col - 1, row: stage.grid!.cells[pinEntered]!.row - 1 });
    });
});

/** The segments of edge routes that pass through a note other than the edge's own ends (and their groups). */
function crossings(g: LaidOutGraph): string[] {
    const parent = new Map(g.nodes.map((n) => [n.id, n.parent]));
    const notes = g.nodes.filter((n) => n.kind !== 'esStage' && n.kind !== 'esGroup');
    const out: string[] = [];
    for (const e of g.edges) {
        const own = new Set([e.source, e.target, parent.get(e.source), parent.get(e.target)]);
        const points = g.edgeLayout[e.id]?.points ?? [];
        for (let i = 1; i < points.length; i++) {
            const [p, q] = [points[i - 1]!, points[i]!];
            for (const n of notes) {
                if (own.has(n.id)) continue;
                const r = g.nodeLayout[n.id]!;
                const [x0, x1] = [Math.min(p.x, q.x), Math.max(p.x, q.x)];
                const [y0, y1] = [Math.min(p.y, q.y), Math.max(p.y, q.y)];
                if (x1 > r.x && x0 < r.x + r.width && y1 > r.y && y0 < r.y + r.height) out.push(`${e.id} crosses ${n.id}`);
            }
        }
    }
    return out;
}

describe('the grammar of ADR 0032 in a view of stages', () => {
    const text = `storming G {
  event Asked
  event Allocated
  event Notified {
    from Bank
  }
  external Batch
  external Bank
  readmodel Requests {
    from Asked
  }
  command Allocate {
    by Batch
    reads Requests
    handledBy Bank
    emits Allocated
  }
  hotspot Why "なぜ外部？" {
    on Allocate
  }
  stage S {
    timeline Main {
      Asked
      Allocated
      Notified
    }
  }
}
`;
    test('read model → issuer above its command, the external system handling it, a hotspot on the command above the chain', async () => {
        const s = await parse(text);
        const render = projectView(s, DL);
        const cells = render.grid!.cells;
        const at = (eventId: string) => cells[only(render, eventId).id]!;
        const command = cells['n:Allocate']!;
        expect(command.row).toBe(at('Allocated').row - 1);
        // the issuer on top of its command; the read model it looks at on the issuer's row, on the left
        expect(cells['n:Batch@Allocate']).toEqual({ col: command.col, row: command.row - 1 });
        expect(cells['n:Requests@Allocate']).toEqual({ col: command.col - 1, row: command.row - 1 });
        // the handler, an external system, between the command and its event
        expect(cells['n:Bank@Allocate']).toEqual({ col: command.col + 1, row: command.row });
        expect(cells['n:Bank@Allocate']!.col).toBe(at('Allocated').col - 1);
        // the hotspot on the command, above its chain
        expect(cells['n:Why']).toEqual({ col: command.col, row: command.row - 2 });
        // the external system an event comes from: in the handler's column, above the event
        const source = render.nodes.find((n) => n.type === 'element' && n.elementId === 'Bank' && n.use === only(render, 'Notified').id)!;
        expect(cells[source.id]).toEqual({ col: at('Notified').col - 1, row: at('Notified').row - 1 });
        const edges = render.edges.filter((e) => e.type === 'semantic').map((e) => `${e.kind}:${e.source}->${e.target}`);
        expect(edges).toEqual(
            expect.arrayContaining([
                'reads:n:Requests@Allocate->n:Batch@Allocate',
                `readmodel-from:${only(render, 'Asked').id}->n:Requests@Allocate`,
                `emits:n:Bank@Allocate->${only(render, 'Allocated').id}`,
                `event-from:${source.id}->${only(render, 'Notified').id}`,
                'hotspot-on:n:Why->n:Allocate',
            ]),
        );
        expect(crossings(laidOut(render, s))).toEqual([]);
        // Big Picture: a hotspot on a command is not drawn
        expect(Object.keys(projectView(s, BP).grid!.cells).filter((id) => id.startsWith('n:'))).toEqual([]);
    });
});

describe('without the exceptions (「例外を表示」 off)', () => {
    const text = `storming T {
  event A
  event B
  event C
  event X
  event Y
  hotspot OnX "X は？" {
    on X
  }
  hotspot OnB "B は？" {
    on B
  }
  stage P {
    timeline Main {
      A
      B
      C
    }
    exception Fail {
      B
      X
      then C
    }
    exception AlsoMain {
      A
      C
    }
  }
}
`;
    test('their steps, the events only they have and the hotspots on those events are not drawn; nor their `then`s', async () => {
        const s = await parse(text);
        const all = projectView(s, BP);
        const without = projectView(s, { level: 'big-picture', hideExceptions: true });
        expect(without.options).toEqual({ level: 'big-picture', hideExceptions: true });
        // Y is in no timeline: shown either way, below the stages
        expect(
            eventNodes(all)
                .map((n) => n.eventId)
                .sort(),
        ).toEqual(['A', 'B', 'C', 'C', 'X', 'Y']);
        expect(
            eventNodes(without)
                .map((n) => n.eventId)
                .sort(),
        ).toEqual(['A', 'B', 'C', 'Y']);
        expect(without.nodes.some((n) => n.id === 'n:OnX')).toBe(false);
        expect(without.nodes.some((n) => n.id === 'n:OnB')).toBe(true);
        expect(edgesOf(all, 'rejoin')).toEqual(['X -> C']);
        expect(edgesOf(without, 'rejoin')).toEqual([]);
        expect(stormingViewKey(without.options)).toBe('big-picture|-exceptions');
        expect(stormingGraphId('T', { level: 'big-picture', stageId: 'P', hideExceptions: true })).toBe('storming:T:big-picture:@P-exceptions');
        // a stage's view alike
        const stage = projectView(s, { level: 'big-picture', stageId: 'P', hideExceptions: true });
        expect(
            eventNodes(stage)
                .map((n) => n.eventId)
                .sort(),
        ).toEqual(['A', 'B', 'C']);
        // an exception's own view is as ever
        expect(eventNodes(projectView(s, { level: 'big-picture', timelineId: 'Fail' })).map((n) => n.eventId)).toEqual(['B', 'X']);
    });

    test('the user’s storming: the main flows only, still one straight row', () => {
        const without = projectView(STAGED, { level: 'big-picture', hideExceptions: true });
        expect(
            eventNodes(without)
                .map((n) => n.eventId)
                .sort(),
        ).toEqual([...MAIN].sort());
        expect(Object.values(without.grid!.cells).every((c) => c.row === 0)).toBe(true);
        expect(without.edges.filter((e) => e.type === 'rejoin')).toEqual([]);
    });
});

describe('without the exceptions at Design Level: the elements of the events only exceptions have go with them', () => {
    // EnterPin emits a main flow's event and an exception's: kept. ForgetPin emits only PinForgotten, GuidePinReset is on
    // only PinLocked and the ResetPin it issues emits only PinResetAtCityOffice (all of exceptions only): not drawn, nor
    // their copies of Resident, MyNumberCard and LockedCards (which no other command has).
    const extra = [
        '  actor Resident "住民"',
        '  readmodel LockedCards "ロック中のカード"',
        '  aggregate MyNumberCard "マイナンバーカード"',
        '  command EnterPin "暗証番号を入力する" {\n    by Resident\n    handledBy MyNumberCard\n    emits PinEntered\n    emits PinLocked\n  }',
        '  command ForgetPin "暗証番号を思い出せない" {\n    by Resident\n    handledBy MyNumberCard\n    emits PinForgotten\n  }',
        '  command ResetPin "暗証番号を再設定する" {\n    reads LockedCards\n    handledBy MyNumberCard\n    emits PinResetAtCityOffice\n  }',
        '  policy GuidePinReset "再設定を案内する" {\n    on PinLocked\n    issues ResetPin\n  }',
        '  stage Preparation',
    ].join('\n');
    const storming = async (): Promise<Storming> => parse((await read('convenience-store-stages.dtes')).replace('  stage Preparation', extra));
    const KEPT = ['n:EnterPin', 'n:Resident@EnterPin', 'n:MyNumberCard@EnterPin'];
    const GONE = [
        'n:ForgetPin',
        'n:Resident@ForgetPin',
        'n:MyNumberCard@ForgetPin',
        'n:GuidePinReset',
        'n:ResetPin',
        'n:LockedCards@ResetPin',
        'n:MyNumberCard@ResetPin',
    ];
    const ids = (render: RenderGraph): string[] => render.nodes.map((n) => n.id);
    const views: ViewOptions[] = [DL, { ...DL, stageId: 'Issuance' }];

    test('the stages and the stage: hidden with the toggle off, drawn as before with it on', async () => {
        const s = await storming();
        for (const options of views) {
            const without = projectView(s, { ...options, hideExceptions: true });
            expect(ids(without)).toEqual(expect.arrayContaining(KEPT));
            for (const id of GONE) expect(ids(without)).not.toContain(id);
            // nothing of theirs is left below the sections, and no edge goes to a hidden element
            for (const n of without.nodes)
                if (n.type === 'element') expect(['ForgetPin', 'GuidePinReset', 'ResetPin', 'CityOfficer']).not.toContain(n.elementId);
            const all = new Set(ids(without));
            for (const e of without.edges) expect(all.has(e.source) && all.has(e.target)).toBe(true);
            // EnterPin's emits of PinLocked goes with PinLocked; that of PinEntered stays, its copies beside it
            const emits = without.edges
                .filter((e) => e.type === 'semantic' && e.kind === 'emits')
                .map((e) => `${eventOf(without, e.source)}->${eventOf(without, e.target)}`);
            expect(emits).toContain('n:MyNumberCard@EnterPin->PinEntered');
            expect(emits.some((e) => e.endsWith('->PinLocked'))).toBe(false);
            const cells = without.grid!.cells;
            // the chain left of its event: command (its actor on top), aggregate, event
            const pinEntered = cells[only(without, 'PinEntered').id]!;
            expect(cells['n:EnterPin']!.col).toBe(cells['n:Resident@EnterPin']!.col);
            expect(cells['n:MyNumberCard@EnterPin']!.col).toBe(pinEntered.col - 1);
            expect(crossings(laidOut(without, s))).toEqual([]);
            expect(crossings(layoutGrid(renderToGraph(without, s), 'compact'))).toEqual([]);

            // with the exceptions, all of them (EnterPin also emits PinLocked: a note at each of its events' steps)
            const on = projectView(s, options);
            expect(elementsOf(on)).toEqual(
                expect.arrayContaining(['EnterPin', 'ForgetPin', 'GuidePinReset', 'ResetPin', 'Resident', 'MyNumberCard', 'LockedCards']),
            );
        }
    });

    test('a policy on a main flow’s event stays, the command it issues that emits only an exception’s event goes; so does one only a hidden policy issues', async () => {
        const s = await parse(`storming T {
  event A
  event B
  event X
  readmodel Inbox
  readmodel Board
  command Fix {
    emits X
  }
  command Notify {
    reads Inbox
  }
  policy OnA {
    on A
    issues Fix
  }
  policy OnX {
    on X
    issues Notify
  }
  timeline Main {
    A
    B
  }
  exception Fail {
    A
    X
  }
}
`);
        const without = projectView(s, { ...DL, hideExceptions: true });
        expect(
            ids(without)
                .filter((id) => id.startsWith('n:'))
                .sort(),
        ).toEqual(['n:Board', 'n:OnA']);
        expect(without.edges.filter((e) => e.type === 'semantic').map((e) => e.semantic)).toEqual(['on:A->OnA']);
        expect(
            ids(projectView(s, DL))
                .filter((id) => id.startsWith('n:'))
                .sort(),
        ).toEqual(['n:Board', 'n:Fix', 'n:Inbox@Notify', 'n:Notify', 'n:OnA', 'n:OnX']);
    });
});

describe('several main flows', () => {
    const text = `storming M {
  event A
  event B
  event C
  event D
  event E
  event X
  stage P {
    exception Fail {
      A
      X
    }
    timeline Trunk {
      A
      B
      C
    }
    timeline Shortcut "近道" {
      A
      D
      C
    }
    timeline Late {
      B
      E
    }
  }
}
`;
    test('the first is the trunk, straight; another branches off it as a flow (not an exception), above the exceptions', async () => {
        const s = await parse(text);
        const render = projectView(s, BP);
        const cell = (eventId: string, i = 0) => render.grid!.cells[nodesOf(render, eventId)[i]!.id]!;
        expect([cell('A'), cell('B')].map((c) => c.row)).toEqual([0, 0]);
        // C twice: on the trunk and on the shortcut (what follows a branch is its own)
        expect(
            nodesOf(render, 'C')
                .map((n) => render.grid!.cells[n.id]!.row)
                .sort((a, b) => a - b),
        ).toEqual([0, 1]);
        expect(cell('D')).toEqual({ col: 1, row: 1 });
        expect(cell('X').row).toBeGreaterThan(cell('D').row);
        expect(cell('E')).toEqual({ col: 2, row: cell('E').row });
        expect(cell('E').row).toBeLessThan(cell('X').row);
        const graph = renderToGraph(render, s);
        const into = (eventId: string) => graph.edges.find((e) => e.target === nodesOf(render, eventId)[0]!.id)!;
        expect(into('D')).toMatchObject({ kind: 'esSequence', label: { ja: { label: '近道' } } });
        expect(into('X').kind).toBe('esException');
        expect(crossings(laidOut(render, s))).toEqual([]);
    });
});

describe('exceptions without stages', () => {
    const text = `storming N {
  event A
  event B
  event C
  event X
  timeline Main {
    A
    B
    C
  }
  exception Fail {
    B
    X
    then C
  }
}
`;
    test('the top-level timelines are one section, without a frame: the trunk straight, the exception below', async () => {
        const s = await parse(text);
        const render = projectView(s, BP);
        expect(render.nodes.some((n) => n.type === 'stage')).toBe(false);
        expect(render.grid!.frames).toEqual({});
        expect(only(render, 'B').occurrences.map((o) => o.timelineId)).toEqual(['Fail', 'Main']);
        expect(render.grid!.cells[only(render, 'X').id]).toEqual({ col: 2, row: 1 });
        expect(edgesOf(render, 'rejoin')).toEqual(['X -> C']);
        expect(crossings(laidOut(render, s))).toEqual([]);
    });
});
