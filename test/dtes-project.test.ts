import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
    type Clause,
    type NodeElement,
    type NodeElementKind,
    type RelationKeyword,
    type SourceRange,
    type Storming,
    type StormingElement,
    type Timeline,
} from '@domaintrail/modeling/storming/ir';
import { VIEW_LEVELS, semanticEdgeKey, type RenderEventNode, type RenderGraph, type ViewOptions } from '@domaintrail/visualization/domain/storming/ir';
import { matchRenderNodes, projectView } from '@domaintrail/visualization/domain/storming/render';
import { buildSemanticGraph } from '@domaintrail/visualization/domain/storming/semantic';
import { timelineOccurrences } from '@domaintrail/visualization/domain/storming/trie';

// ---- IR built by hand (the parser is not needed) ----

const range: SourceRange = { file: 'test.dtes', start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

const el = (kind: NodeElementKind, id: string, ...relations: [RelationKeyword, string][]): NodeElement => ({
    kind,
    id,
    range,
    nameRange: range,
    clauses: relations.map(([keyword, target]): Clause => ({ type: 'relation', keyword, target, range, targetRange: range })),
});

/** A timeline of event IDs; an array is a group (`<timeline>_g<step>`). */
const tl = (id: string, ...steps: (string | string[])[]): Timeline => ({
    kind: 'timeline',
    id,
    range,
    nameRange: range,
    steps: steps.map((s, i) =>
        typeof s === 'string'
            ? { type: 'event', eventId: s, range }
            : { type: 'group', kind: 'group', id: `${id}_g${i}`, range, nameRange: range, events: s.map((eventId) => ({ eventId, range })) },
    ),
});

const events = (...ids: string[]): NodeElement[] => ids.map((id) => el('event', id));

const storming = (...elements: StormingElement[]): Storming => ({ id: 'S', range, nameRange: range, elements });

const BP: ViewOptions = { level: 'big-picture' };
const DL: ViewOptions = { level: 'design-level' };

const nodeIds = (g: RenderGraph): string[] => g.nodes.map((n) => n.id);
const eventNodes = (g: RenderGraph): RenderEventNode[] => g.nodes.filter((n): n is RenderEventNode => n.type === 'event');
const nodesOf = (g: RenderGraph, eventId: string): RenderEventNode[] => eventNodes(g).filter((n) => n.eventId === eventId);
const sequences = (g: RenderGraph): string[] => g.edges.filter((e) => e.type === 'sequence').map((e) => `${e.source} -> ${e.target}`);
const semanticEdges = (g: RenderGraph): string[] => g.edges.filter((e) => e.type === 'semantic').map((e) => `${e.kind}:${e.source}->${e.target}`);
const elementIds = (g: RenderGraph): string[] => g.nodes.flatMap((n) => (n.type === 'element' ? [n.elementId] : []));

describe('semantic graph (spec §9.1)', () => {
    test('R09: a policy with several on and issues keeps the policy, with no Event → Command edges', () => {
        const s = storming(
            ...events('E1', 'E2', 'E3'),
            el('policy', 'P', ['on', 'E1'], ['on', 'E2'], ['issues', 'C1'], ['issues', 'C2']),
            el('command', 'C1', ['emits', 'E3']),
            el('command', 'C2'),
        );
        expect(buildSemanticGraph(s).edges.map(semanticEdgeKey)).toEqual(['on:E1->P', 'on:E2->P', 'issues:P->C1', 'issues:P->C2', 'emits:C1->E3']);
        const kinds = new Map(buildSemanticGraph(s).nodes.map((n) => [n.id, n.kind]));
        for (const e of buildSemanticGraph(s).edges) expect([kinds.get(e.sourceId), kinds.get(e.targetId)]).not.toEqual(['event', 'command']);
        const g = projectView(s, DL);
        const kindOf = (id: string) => (id.startsWith('n:') ? kinds.get(id.slice(2)) : 'event');
        for (const e of g.edges) expect([kindOf(e.source), kindOf(e.target)]).not.toEqual(['event', 'command']);
    });

    test('§9.1: relations are directed actor/read model → command, every other one from its owner', () => {
        const s = storming(
            ...events('E'),
            el('actor', 'A'),
            el('external', 'X'),
            el('readmodel', 'R'),
            el('aggregate', 'G'),
            el('command', 'C', ['actor', 'A'], ['actor', 'X'], ['reads', 'R'], ['target', 'G'], ['emits', 'E']),
            el('hotspot', 'H', ['on', 'E']),
        );
        expect(buildSemanticGraph(s).edges).toEqual([
            { sourceId: 'A', targetId: 'C', kind: 'actor' },
            { sourceId: 'X', targetId: 'C', kind: 'actor' },
            { sourceId: 'R', targetId: 'C', kind: 'reads' },
            { sourceId: 'C', targetId: 'G', kind: 'target' },
            { sourceId: 'C', targetId: 'E', kind: 'emits' },
            { sourceId: 'H', targetId: 'E', kind: 'hotspot-on' },
        ]);
    });

    test('invalid relations, duplicate IDs and timelines are left out, nothing is inferred', () => {
        const s = storming(
            ...events('E'),
            el('command', 'C', ['target', 'E'], ['emits', 'Missing'], ['issues', 'C'], ['emits', 'E'], ['emits', 'E']),
            el('aggregate', 'E'),
            el('policy', 'P', ['on', 'T']),
            tl('T', 'E'),
        );
        const graph = buildSemanticGraph(s);
        expect(graph.nodes.map((n) => `${n.kind}:${n.id}`)).toEqual(['event:E', 'command:C', 'policy:P']);
        expect(graph.edges.map(semanticEdgeKey)).toEqual(['emits:C->E']);
    });

    test('R13: changing a .dt ref keeps the semantic graph and the views', () => {
        const withRef = (path: string): Storming => {
            const s = storming(...events('E'), el('command', 'C', ['emits', 'E']), tl('T', 'E'));
            s.elements[0] = { ...el('event', 'E'), clauses: [{ type: 'ref', path, segments: path.split('.'), range }] };
            return s;
        };
        const [a, b] = [withRef('Sales.OrderPlaced'), withRef('Sales.OrderConfirmed')];
        expect(buildSemanticGraph(a).nodes.map((n) => n.id)).toEqual(buildSemanticGraph(b).nodes.map((n) => n.id));
        expect(buildSemanticGraph(a).edges).toEqual(buildSemanticGraph(b).edges);
        expect(projectView(a, DL)).toEqual(projectView(b, DL));
    });
});

describe('occurrences and the prefix trie (spec §7.2, §8)', () => {
    test('one occurrence per timeline reference, with its step path', () => {
        expect(timelineOccurrences(tl('T', 'A', ['C', 'B'], 'A'))).toEqual([
            { timelineId: 'T', stepPath: [0], eventId: 'A' },
            { timelineId: 'T', stepPath: [1, 0], eventId: 'C' },
            { timelineId: 'T', stepPath: [1, 1], eventId: 'B' },
            { timelineId: 'T', stepPath: [2], eventId: 'A' },
        ]);
    });

    test('R01: A B C and A B D share A B', () => {
        const g = projectView(storming(...events('A', 'B', 'C', 'D'), tl('T1', 'A', 'B', 'C'), tl('T2', 'A', 'B', 'D')), BP);
        expect(nodeIds(g)).toEqual(['t:e:A', 't:e:A>e:B', 't:e:A>e:B>e:C', 't:e:A>e:B>e:D']);
        expect(nodesOf(g, 'B')[0].occurrences).toEqual([
            { timelineId: 'T1', stepPath: [1], eventId: 'B' },
            { timelineId: 'T2', stepPath: [1], eventId: 'B' },
        ]);
        expect(g.edges.filter((e) => e.type === 'sequence').map((e) => [e.id, e.type === 'sequence' && e.timelineIds])).toEqual([
            ['s:t:e:A->t:e:A>e:B', ['T1', 'T2']],
            ['s:t:e:A>e:B->t:e:A>e:B>e:C', ['T1']],
            ['s:t:e:A>e:B->t:e:A>e:B>e:D', ['T2']],
        ]);
    });

    test('R02: A B C and X B C share no suffix', () => {
        const g = projectView(storming(...events('A', 'B', 'C', 'X'), tl('T1', 'A', 'B', 'C'), tl('T2', 'X', 'B', 'C')), BP);
        expect(nodesOf(g, 'B')).toHaveLength(2);
        expect(nodesOf(g, 'C')).toHaveLength(2);
    });

    test('R02: the spec example §8.2 (Normal and Absence share Assigned → Started, Retry shares nothing)', () => {
        const g = projectView(
            storming(
                ...events('Assigned', 'Started', 'Completed', 'Absent', 'Returned', 'Scheduled'),
                tl('Normal', 'Assigned', 'Started', 'Completed'),
                tl('Absence', 'Assigned', 'Started', 'Absent', 'Returned'),
                tl('Retry', 'Returned', 'Scheduled', 'Started', 'Completed'),
            ),
            BP,
        );
        expect(nodesOf(g, 'Started').map((n) => n.occurrences.map((o) => o.timelineId))).toEqual([['Absence', 'Normal'], ['Retry']]);
        expect(nodesOf(g, 'Completed')).toHaveLength(2);
    });

    test('R03: an event repeated in one timeline is two occurrences on two nodes', () => {
        const g = projectView(storming(...events('A', 'B'), tl('T', 'A', 'B', 'A')), BP);
        expect(nodesOf(g, 'A').map((n) => [n.id, n.occurrences.map((o) => o.stepPath)])).toEqual([
            ['t:e:A', [[0]]],
            ['t:e:A>e:B>e:A', [[2]]],
        ]);
    });

    test('R04: groups of the same events in another order are one step, with no order inside', () => {
        const g = projectView(storming(...events('A', 'C', 'F', 'X'), tl('A1', 'A', ['C', 'F'], 'X'), tl('B1', 'A', ['F', 'C'])), BP);
        expect(nodeIds(g)).toEqual(['t:e:A', 't:e:A>g:C,F', 't:e:A>g:C,F/C', 't:e:A>g:C,F/F', 't:e:A>g:C,F>e:X']);
        const group = g.nodes.find((n) => n.type === 'group');
        expect(group).toEqual({
            type: 'group',
            id: 't:e:A>g:C,F',
            members: ['t:e:A>g:C,F/C', 't:e:A>g:C,F/F'],
            groups: [
                { timelineId: 'A1', groupId: 'A1_g1' },
                { timelineId: 'B1', groupId: 'B1_g1' },
            ],
        });
        // the source position is kept: F is the first event of B1's group
        expect(nodesOf(g, 'F')[0].occurrences).toEqual([
            { timelineId: 'A1', stepPath: [1, 1], eventId: 'F' },
            { timelineId: 'B1', stepPath: [1, 0], eventId: 'F' },
        ]);
        expect(sequences(g)).toEqual(['t:e:A -> t:e:A>g:C,F', 't:e:A>g:C,F -> t:e:A>g:C,F>e:X']);
    });

    test('R05: a group and a single event are not merged', () => {
        const g = projectView(storming(...events('A', 'B', 'C'), tl('T1', 'A', ['B', 'C']), tl('T2', 'A', 'B'), tl('T3', 'A', ['B'])), BP);
        expect(nodeIds(g)).toEqual(['t:e:A', 't:e:A>e:B', 't:e:A>g:B', 't:e:A>g:B,C', 't:e:A>g:B,C/B', 't:e:A>g:B,C/C', 't:e:A>g:B/B']);
    });

    test('R06: reordering timelines and declarations gives the same canonical graph', () => {
        const parts = [
            ...events('A', 'B', 'C', 'D'),
            el('policy', 'P', ['on', 'B'], ['issues', 'K']),
            el('command', 'K', ['emits', 'C']),
            tl('T1', 'A', 'B', 'C'),
            tl('T2', 'A', ['B', 'D']),
            tl('T3', 'D', 'A'),
        ];
        for (const options of [BP, DL, { level: 'design-level', timelineId: 'T1' } satisfies ViewOptions]) {
            expect(projectView(storming(...[...parts].reverse()), options)).toEqual(projectView(storming(...parts), options));
        }
    });

    test('R07: appending a step keeps the existing prefix nodes', () => {
        const before = projectView(storming(...events('A', 'B', 'C'), tl('T1', 'A', 'B'), tl('T2', 'A', 'C')), BP);
        const after = projectView(storming(...events('A', 'B', 'C'), tl('T1', 'A', 'B', 'C'), tl('T2', 'A', 'C', ['A', 'B'])), BP);
        expect(nodeIds(after)).toEqual(expect.arrayContaining(nodeIds(before)));
        expect(matchRenderNodes(before, after)).toEqual(new Map(nodeIds(before).map((id) => [id, id])));
    });

    test('R08: a step inserted mid-timeline keeps the nodes that still match', () => {
        const before = projectView(storming(...events('A', 'B', 'C', 'X'), tl('T', 'A', 'B', 'C')), BP);
        const after = projectView(storming(...events('A', 'B', 'C', 'X'), tl('T', 'A', 'X', 'B', 'C')), BP);
        expect(matchRenderNodes(before, after)).toEqual(
            new Map([
                ['t:e:A', 't:e:A'],
                ['t:e:A>e:X>e:B', 't:e:A>e:B'],
                ['t:e:A>e:X>e:B>e:C', 't:e:A>e:B>e:C'],
                // X was in no timeline
                ['t:e:A>e:X', 'e:X'],
            ]),
        );
    });

    test('R08: an event added to a timeline keeps its node; a group keeps its node and members', () => {
        const before = projectView(storming(...events('A', 'B', 'C', 'Z'), tl('T', 'A', ['B', 'C'])), BP);
        const after = projectView(storming(...events('A', 'B', 'C', 'Z'), tl('T', 'Z', 'A', ['C', 'B'])), BP);
        expect(matchRenderNodes(before, after)).toEqual(
            new Map([
                ['t:e:Z', 'e:Z'],
                ['t:e:Z>e:A', 't:e:A'],
                ['t:e:Z>e:A>g:B,C', 't:e:A>g:B,C'],
                ['t:e:Z>e:A>g:B,C/B', 't:e:A>g:B,C/B'],
                ['t:e:Z>e:A>g:B,C/C', 't:e:A>g:B,C/C'],
            ]),
        );
    });

    test('R08: ambiguous nodes are left unpaired, to be placed anew', () => {
        const before = projectView(storming(...events('A', 'B', 'C', 'D'), tl('T1', 'A', 'B'), tl('T2', 'C', 'B')), BP);
        const after = projectView(storming(...events('A', 'B', 'C', 'D'), tl('T3', 'D', 'B')), BP);
        const pairs = matchRenderNodes(before, after);
        // B had a node in T1 and one in T2, and neither shares a timeline or a neighbour with T3's
        expect(pairs.has('t:e:D>e:B')).toBe(false);
        expect(pairs).toEqual(
            new Map([
                ['e:A', 't:e:A'],
                ['e:C', 't:e:C'],
                ['t:e:D', 'e:D'],
            ]),
        );
    });

    test('steps naming no event are left out of the trie, their occurrences keep the source positions', () => {
        const g = projectView(storming(...events('A', 'B'), el('command', 'C'), tl('T', 'A', 'C', 'Missing', ['C', 'B'])), BP);
        expect(nodeIds(g)).toEqual(['t:e:A', 't:e:A>g:B', 't:e:A>g:B/B']);
        expect(nodesOf(g, 'B')[0].occurrences).toEqual([{ timelineId: 'T', stepPath: [3, 1], eventId: 'B' }]);
    });
});

describe('views (spec §6, §9.3)', () => {
    const shop = storming(
        ...events('Placed', 'Paid', 'Shipped', 'Cancelled', 'Lonely'),
        el('actor', 'Customer'),
        el('external', 'Psp'),
        el('readmodel', 'Cart'),
        el('aggregate', 'Order'),
        el('command', 'Pay', ['actor', 'Psp'], ['reads', 'Cart'], ['target', 'Order'], ['emits', 'Paid']),
        el('command', 'Ship', ['actor', 'Customer'], ['emits', 'Shipped']),
        el('command', 'Cancel', ['emits', 'Cancelled']),
        el('policy', 'AfterPlaced', ['on', 'Placed'], ['issues', 'Pay'], ['issues', 'Cancel']),
        el('policy', 'AfterPaid', ['on', 'Paid'], ['issues', 'Ship']),
        el('hotspot', 'Late', ['on', 'Paid']),
        el('hotspot', 'Refund', ['on', 'Cancelled']),
        el('hotspot', 'Open'),
        tl('Happy', 'Placed', 'Paid'),
        tl('Abort', 'Placed', 'Cancelled'),
    );

    test('R11, R12: level and timeline are independent options, and projecting leaves the storming as it was', () => {
        const copy = structuredClone(shop);
        const views = VIEW_LEVELS.flatMap((level) => [{ level }, { level, timelineId: 'Happy' }, { level, timelineId: 'Abort' }]);
        const graphs = views.map((options) => projectView(shop, options));
        expect(graphs.map((g) => g.options)).toEqual(views);
        expect(new Set(graphs.map((g) => JSON.stringify(g))).size).toBe(views.length);
        expect(shop).toEqual(copy);
        // a timeline keeps its nodes at both levels, a level keeps its kinds with or without a timeline
        expect(eventNodes(projectView(shop, { level: 'big-picture', timelineId: 'Happy' }))).toEqual(
            eventNodes(projectView(shop, { level: 'design-level', timelineId: 'Happy' })),
        );
    });

    test('R14, R17: Big Picture hides the design elements but no event; Design Level shows external', () => {
        const bp = projectView(shop, BP);
        const dl = projectView(shop, DL);
        expect(eventNodes(bp)).toEqual(eventNodes(dl));
        expect(elementIds(bp)).toEqual(['Late', 'Open', 'Refund']);
        expect(semanticEdges(bp)).toEqual(['hotspot-on:n:Late->t:e:Placed>e:Paid', 'hotspot-on:n:Refund->t:e:Placed>e:Cancelled']);
        expect(elementIds(dl)).toEqual(['AfterPaid', 'AfterPlaced', 'Cancel', 'Cart', 'Customer', 'Late', 'Open', 'Order', 'Pay', 'Psp', 'Refund', 'Ship']);
        expect(dl.nodes.find((n) => n.id === 'n:Psp')).toEqual({ type: 'element', id: 'n:Psp', elementId: 'Psp', kind: 'external' });
        expect(sequences(bp)).toEqual(sequences(dl));
    });

    test('R15: the integrated canvas shows the events of no timeline, a timeline filter does not', () => {
        expect(nodesOf(projectView(shop, BP), 'Lonely')).toEqual([{ type: 'event', id: 'e:Lonely', eventId: 'Lonely', occurrences: [] }]);
        expect(nodesOf(projectView(shop, { level: 'design-level', timelineId: 'Happy' }), 'Lonely')).toEqual([]);
    });

    test('R16: a timeline filter projects only the 1-hop paths with both events in the timeline', () => {
        const happy = projectView(shop, { level: 'design-level', timelineId: 'Happy' });
        expect(nodeIds(happy)).toEqual(['n:AfterPlaced', 'n:Cart', 'n:Late', 'n:Order', 'n:Pay', 'n:Psp', 't:e:Placed', 't:e:Placed>e:Paid']);
        expect(semanticEdges(happy)).toEqual([
            'actor:n:Psp->n:Pay',
            'emits:n:Pay->t:e:Placed>e:Paid',
            'hotspot-on:n:Late->t:e:Placed>e:Paid',
            'issues:n:AfterPlaced->n:Pay',
            'on:t:e:Placed->n:AfterPlaced',
            'reads:n:Cart->n:Pay',
            'target:n:Pay->n:Order',
        ]);
        expect(sequences(happy)).toEqual(['t:e:Placed -> t:e:Placed>e:Paid']);
        // only this timeline's occurrences
        expect(nodesOf(happy, 'Placed')[0].occurrences).toEqual([{ timelineId: 'Happy', stepPath: [0], eventId: 'Placed' }]);
        // AfterPaid → Ship → Shipped leaves the timeline: not projected, nor is the other issues of AfterPlaced
        const abort = projectView(shop, { level: 'design-level', timelineId: 'Abort' });
        expect(elementIds(abort)).toEqual(['AfterPlaced', 'Cancel', 'Refund']);
    });

    test('R16: a multi-hop chain is not expanded', () => {
        const s = storming(
            ...events('E1', 'E2', 'E3'),
            el('policy', 'P1', ['on', 'E1'], ['issues', 'C1']),
            el('command', 'C1', ['emits', 'E2']),
            el('policy', 'P2', ['on', 'E2'], ['issues', 'C2']),
            el('command', 'C2', ['emits', 'E3']),
            tl('T', 'E1', 'E3'),
        );
        // E1 → P1 → C1 → E2 → P2 → C2 → E3 would reach E3 in two hops; E2 is not in the timeline
        expect(elementIds(projectView(s, { level: 'design-level', timelineId: 'T' }))).toEqual([]);
        expect(elementIds(projectView(s, DL))).toEqual(['C1', 'C2', 'P1', 'P2']);
    });

    test('hotspots of a timeline filter: those on an event of the timeline at both levels, none without on', () => {
        expect(elementIds(projectView(shop, { level: 'big-picture', timelineId: 'Happy' }))).toEqual(['Late']);
        expect(elementIds(projectView(shop, { level: 'big-picture', timelineId: 'Abort' }))).toEqual(['Refund']);
        expect(elementIds(projectView(shop, BP))).toContain('Open');
    });

    test('R10: a causal cycle is drawn once, without expansion', () => {
        const s = storming(
            ...events('E', 'F'),
            el('policy', 'P', ['on', 'E'], ['issues', 'C']),
            el('command', 'C', ['emits', 'F']),
            el('policy', 'Q', ['on', 'F'], ['issues', 'D']),
            el('command', 'D', ['emits', 'E']),
            tl('T', 'E', 'F', 'E', 'F'),
        );
        const g = projectView(s, { level: 'design-level', timelineId: 'T' });
        expect(elementIds(g)).toEqual(['C', 'D', 'P', 'Q']);
        expect(nodesOf(g, 'E')).toHaveLength(2);
        expect(semanticEdges(projectView(s, DL))).toHaveLength(2 * 2 + 2 + 2 * 2);
    });

    test('an unknown timeline gives the integrated canvas', () => {
        expect(projectView(shop, { level: 'big-picture', timelineId: 'Nope' })).toEqual(projectView(shop, BP));
    });

    test('timeline order edges are a kind of their own, never inside a group', () => {
        const g = projectView(storming(...events('A', 'B', 'C'), tl('T', 'A', ['B', 'C'], 'A')), DL);
        expect(g.edges.map((e) => e.type)).toEqual(['sequence', 'sequence']);
        expect(sequences(g)).toEqual(['t:e:A -> t:e:A>g:B,C', 't:e:A>g:B,C -> t:e:A>g:B,C>e:A']);
    });
});

// ---- §12.3 properties ----

const EVENTS = ['A', 'B', 'C', 'D', 'E'];
const COMMANDS = ['K1', 'K2', 'K3'];
const event = fc.constantFrom(...EVENTS);
const command = fc.constantFrom(...COMMANDS);
const step = fc.oneof(event, fc.uniqueArray(event, { minLength: 1, maxLength: 3 }));

const arbitraryStorming = fc
    .record({
        timelines: fc.array(fc.array(step, { maxLength: 6 }), { maxLength: 4 }),
        policies: fc.array(
            fc.record({ on: fc.uniqueArray(event, { minLength: 1, maxLength: 2 }), issues: fc.uniqueArray(command, { minLength: 1, maxLength: 2 }) }),
            { maxLength: 3 },
        ),
        emits: fc.tuple(...COMMANDS.map(() => fc.uniqueArray(event, { maxLength: 2 }))),
        hotspots: fc.array(fc.option(event, { nil: undefined }), { maxLength: 2 }),
    })
    .map(({ timelines, policies, emits, hotspots }): StormingElement[] => [
        ...events(...EVENTS),
        el('actor', 'Who'),
        el('aggregate', 'Agg'),
        ...COMMANDS.map((id, i) => el('command', id, ['actor', 'Who'], ['target', 'Agg'], ...emits[i].map((e): [RelationKeyword, string] => ['emits', e]))),
        ...policies.map((p, i) =>
            el('policy', `P${i}`, ...p.on.map((e): [RelationKeyword, string] => ['on', e]), ...p.issues.map((c): [RelationKeyword, string] => ['issues', c])),
        ),
        ...hotspots.map((on, i) => el('hotspot', `H${i}`, ...(on ? [['on', on] as [RelationKeyword, string]] : []))),
        ...timelines.map((steps, i) => tl(`T${i}`, ...steps)),
    ])
    .chain((elements) => fc.tuple(fc.constant(elements), fc.shuffledSubarray(elements, { minLength: elements.length, maxLength: elements.length })));

const viewsOf = (s: Storming): ViewOptions[] =>
    VIEW_LEVELS.flatMap((level) => [{ level }, ...s.elements.filter((e) => e.kind === 'timeline').map((t) => ({ level, timelineId: t.id }))]);

const allOccurrences = (s: Storming, timelineId?: string) =>
    s.elements.flatMap((e) => (e.kind === 'timeline' && (timelineId === undefined || e.id === timelineId) ? timelineOccurrences(e) : []));

const occurrenceKey = (o: { timelineId: string; stepPath: number[]; eventId: string }) => `${o.timelineId}:${o.stepPath.join('.')}:${o.eventId}`;

describe('§12.3 properties', () => {
    test('each occurrence belongs to exactly one event node of a view', () => {
        fc.assert(
            fc.property(arbitraryStorming, ([elements]) => {
                const s = storming(...elements);
                for (const options of viewsOf(s)) {
                    const drawn = eventNodes(projectView(s, options))
                        .flatMap((n) => n.occurrences)
                        .map(occurrenceKey)
                        .sort();
                    expect(drawn).toEqual(allOccurrences(s, options.timelineId).map(occurrenceKey).sort());
                }
            }),
        );
    });

    test('an event node never mixes events, nor two occurrences of one timeline', () => {
        fc.assert(
            fc.property(arbitraryStorming, ([elements]) => {
                const s = storming(...elements);
                for (const options of viewsOf(s)) {
                    for (const n of eventNodes(projectView(s, options))) {
                        expect(n.occurrences.every((o) => o.eventId === n.eventId)).toBe(true);
                        const timelines = n.occurrences.map((o) => o.timelineId);
                        expect(new Set(timelines).size).toBe(timelines.length);
                    }
                }
            }),
        );
    });

    test('sharing changes no semantic node or edge, and draws no edge that is not semantic or timeline order', () => {
        fc.assert(
            fc.property(arbitraryStorming, ([elements]) => {
                const s = storming(...elements);
                const semantic = buildSemanticGraph(s);
                const keys = new Map(semantic.edges.map((e) => [semanticEdgeKey(e), e]));
                const copy = structuredClone(s);
                for (const options of viewsOf(s)) {
                    const g = projectView(s, options);
                    const byId = new Map(g.nodes.map((n) => [n.id, n]));
                    const elementOf = (id: string) => {
                        const n = byId.get(id);
                        return n?.type === 'event' ? n.eventId : n?.type === 'element' ? n.elementId : undefined;
                    };
                    for (const e of g.edges) {
                        if (e.type === 'sequence') continue;
                        const edge = keys.get(e.semantic);
                        expect(edge).toBeDefined();
                        expect([e.kind, elementOf(e.source), elementOf(e.target)]).toEqual([edge!.kind, edge!.sourceId, edge!.targetId]);
                    }
                }
                expect(s).toEqual(copy);
                expect(buildSemanticGraph(s)).toEqual(semantic);
            }),
        );
    });

    test('no time order inside a group', () => {
        fc.assert(
            fc.property(arbitraryStorming, ([elements]) => {
                const s = storming(...elements);
                for (const options of viewsOf(s)) {
                    const g = projectView(s, options);
                    const members = new Set(g.nodes.flatMap((n) => (n.type === 'group' ? n.members : [])));
                    for (const e of g.edges) if (e.type === 'sequence') expect(members.has(e.source) || members.has(e.target)).toBe(false);
                }
            }),
        );
    });

    test('the canonical projection does not depend on the declaration order', () => {
        fc.assert(
            fc.property(arbitraryStorming, ([elements, shuffled]) => {
                const [s, t] = [storming(...elements), storming(...shuffled)];
                for (const options of viewsOf(s)) expect(projectView(t, options)).toEqual(projectView(s, options));
            }),
        );
    });

    test('R16: every policy and command of a timeline filter lies on a 1-hop path between two of its events', () => {
        fc.assert(
            fc.property(arbitraryStorming, ([elements]) => {
                const s = storming(...elements);
                const edges = buildSemanticGraph(s).edges;
                for (const options of viewsOf(s)) {
                    if (options.timelineId === undefined || options.level !== 'design-level') continue;
                    const inTimeline = new Set(allOccurrences(s, options.timelineId).map((o) => o.eventId));
                    const onPath = (policy: string, cmd: string) =>
                        edges.some((e) => e.kind === 'on' && e.targetId === policy && inTimeline.has(e.sourceId)) &&
                        edges.some((e) => e.kind === 'issues' && e.sourceId === policy && e.targetId === cmd) &&
                        edges.some((e) => e.kind === 'emits' && e.sourceId === cmd && inTimeline.has(e.targetId));
                    const shown = elementIds(projectView(s, options));
                    const policies = shown.filter((id) => id.startsWith('P'));
                    const commands = shown.filter((id) => COMMANDS.includes(id));
                    for (const p of policies) expect(commands.some((c) => onPath(p, c))).toBe(true);
                    for (const c of commands) expect(policies.some((p) => onPath(p, c))).toBe(true);
                }
            }),
        );
    });

    test('R07: appending a step to a timeline keeps every node ID, and pairs every node with itself', () => {
        fc.assert(
            fc.property(arbitraryStorming, fc.nat(), step, ([elements], which, appended) => {
                const timelines = elements.filter((e) => e.kind === 'timeline');
                if (timelines.length === 0) return;
                const target = timelines[which % timelines.length];
                const longer = elements.map((e) =>
                    e === target
                        ? tl(target.id, ...target.steps.map((st) => (st.type === 'event' ? st.eventId : st.events.map((x) => x.eventId))), appended)
                        : e,
                );
                for (const level of VIEW_LEVELS) {
                    const before = projectView(storming(...elements), { level });
                    const after = projectView(storming(...longer), { level });
                    const ids = new Set(nodeIds(after));
                    // an event of no timeline may join one; every other node stays
                    for (const id of nodeIds(before)) if (!id.startsWith('e:')) expect(ids.has(id)).toBe(true);
                    const pairs = matchRenderNodes(before, after);
                    for (const id of nodeIds(before)) if (ids.has(id)) expect(pairs.get(id)).toBe(id);
                }
            }),
        );
    });
});
