import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
    buildSemanticGraph,
    type Clause,
    type NodeElement,
    type NodeElementKind,
    type RelationKeyword,
    semanticEdgeKey,
    type SourceRange,
    type Storming,
    type StormingElement,
    type Timeline,
    timelineOccurrences,
} from '@domaintrail/storming';
import { VIEW_LEVELS, type RenderEventNode, type RenderGraph, type ViewOptions } from './ir.js';
import { matchRenderNodes, projectView } from './render.js';
import { renderToGraph } from './graph.js';

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

// the semantic graph and the occurrences themselves: modeling's storming/semantic.test.ts
describe('semantic edges in the views (spec §9.1)', () => {
    test('R09: a policy with several on and issues keeps the policy, with no Event → Command edges', () => {
        const s = storming(
            ...events('E1', 'E2', 'E3'),
            el('policy', 'P', ['on', 'E1'], ['on', 'E2'], ['issues', 'C1'], ['issues', 'C2']),
            el('command', 'C1', ['emits', 'E3']),
            el('command', 'C2'),
        );
        const kinds = new Map(buildSemanticGraph(s).nodes.map((n) => [n.id, n.kind]));
        const g = projectView(s, DL);
        const kindOf = (id: string) => (id.startsWith('n:') ? kinds.get(id.slice(2)) : 'event');
        for (const e of g.edges) expect([kindOf(e.source), kindOf(e.target)]).not.toEqual(['event', 'command']);
    });

    test('R13: changing a .dt ref keeps the views', () => {
        const withRef = (path: string): Storming => {
            const s = storming(...events('E'), el('command', 'C', ['emits', 'E']), tl('T', 'E'));
            s.elements[0] = { ...el('event', 'E'), clauses: [{ type: 'ref', path, segments: path.split('.'), range }] };
            return s;
        };
        const [a, b] = [withRef('Sales.OrderPlaced'), withRef('Sales.OrderConfirmed')];
        expect(projectView(a, DL)).toEqual(projectView(b, DL));
    });
});

describe('the prefix trie (spec §7.2, §8)', () => {
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
        el('command', 'Pay', ['by', 'Psp'], ['reads', 'Cart'], ['handledBy', 'Order'], ['emits', 'Paid']),
        el('command', 'Ship', ['by', 'Customer'], ['emits', 'Shipped']),
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
        expect(dl.nodes.find((n) => n.type === 'element' && n.elementId === 'Psp')).toEqual({
            type: 'element',
            id: 'n:Psp@Pay',
            elementId: 'Psp',
            kind: 'external',
            use: 'Pay',
        });
        expect(sequences(bp)).toEqual(sequences(dl));
    });

    test('R15: the integrated canvas shows the events of no timeline, a timeline filter does not', () => {
        expect(nodesOf(projectView(shop, BP), 'Lonely')).toEqual([{ type: 'event', id: 'e:Lonely', eventId: 'Lonely', occurrences: [] }]);
        expect(nodesOf(projectView(shop, { level: 'design-level', timelineId: 'Happy' }), 'Lonely')).toEqual([]);
    });

    test('R16: a timeline filter projects only the 1-hop paths with both events in the timeline', () => {
        const happy = projectView(shop, { level: 'design-level', timelineId: 'Happy' });
        expect(nodeIds(happy)).toEqual(['n:AfterPlaced', 'n:Cart@Pay', 'n:Late', 'n:Order@Pay', 'n:Pay', 'n:Psp@Pay', 't:e:Placed', 't:e:Placed>e:Paid']);
        expect(semanticEdges(happy)).toEqual([
            'by:n:Psp@Pay->n:Pay',
            // the command's events come out of its handler (Event Storming's grammar)
            'emits:n:Order@Pay->t:e:Placed>e:Paid',
            'handledBy:n:Pay->n:Order@Pay',
            'hotspot-on:n:Late->t:e:Placed>e:Paid',
            'issues:n:AfterPlaced->n:Pay',
            'on:t:e:Placed->n:AfterPlaced',
            // the read model is what the issuer looks at (ADR 0032)
            'reads:n:Cart@Pay->n:Psp@Pay',
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
        // E1 → P1 → C1 → E2 → P2 → C2 → E3 would reach E3 in two hops; E2 is not in the timeline. C2 is drawn as the
        // cause of E3, but nothing is followed back from it (P2 on E2, nor C1 and P1)
        expect(elementIds(projectView(s, { level: 'design-level', timelineId: 'T' }))).toEqual(['C2']);
        expect(elementIds(projectView(s, DL))).toEqual(['C1', 'C2', 'P1', 'P2']);
    });

    test('hotspots of a timeline filter: those on an event of the timeline at both levels, none without on', () => {
        expect(elementIds(projectView(shop, { level: 'big-picture', timelineId: 'Happy' }))).toEqual(['Late']);
        expect(elementIds(projectView(shop, { level: 'big-picture', timelineId: 'Abort' }))).toEqual(['Refund']);
        expect(elementIds(projectView(shop, BP))).toContain('Open');
    });

    test('R10: a causal cycle is drawn without expansion: a note per step of its events, never more', () => {
        const s = storming(
            ...events('E', 'F'),
            el('policy', 'P', ['on', 'E'], ['issues', 'C']),
            el('command', 'C', ['emits', 'F']),
            el('policy', 'Q', ['on', 'F'], ['issues', 'D']),
            el('command', 'D', ['emits', 'E']),
            tl('T', 'E', 'F', 'E', 'F'),
        );
        const g = projectView(s, { level: 'design-level', timelineId: 'T' });
        // each repeated event's cause and reaction drawn at each of its steps (a drawing-only split, §7.3, §10.2)
        expect(nodeIds(g).filter((id) => id.startsWith('n:'))).toEqual(['n:C#1', 'n:C#2', 'n:D#1', 'n:D#2', 'n:P#1', 'n:P#2', 'n:Q#1', 'n:Q#2']);
        expect(nodesOf(g, 'E')).toHaveLength(2);
        // a policy's note issues the command's note at the next step of its own; the last one, with none after it, every note
        expect(semanticEdges(g).filter((e) => e.startsWith('issues:'))).toEqual([
            'issues:n:P#1->n:C#1',
            'issues:n:P#2->n:C#2',
            'issues:n:Q#1->n:D#2',
            'issues:n:Q#2->n:D#1',
            'issues:n:Q#2->n:D#2',
        ]);
        // the integrated canvas draws each event once: one note of each element
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

describe('actors, external systems, read models and aggregates drawn once per use (Design Level)', () => {
    const uses = (...extra: StormingElement[]): Storming =>
        storming(
            ...events('E1', 'E2', 'E3'),
            el('actor', 'Clerk'),
            el('external', 'Bank'),
            el('readmodel', 'Stock'),
            el('aggregate', 'Order'),
            el('actor', 'Idle'),
            el('aggregate', 'Unused'),
            el('command', 'C1', ['by', 'Clerk'], ['by', 'Bank'], ['reads', 'Stock'], ['handledBy', 'Order'], ['emits', 'E1']),
            el('command', 'C2', ['by', 'Clerk'], ['reads', 'Stock'], ['handledBy', 'Order'], ['emits', 'E2']),
            el('policy', 'P', ['on', 'E1'], ['issues', 'C2']),
            tl('T', 'E1', 'E2'),
            ...extra,
        );
    const copies = (g: RenderGraph) =>
        g.nodes.flatMap((n) => (n.type === 'element' && n.use !== undefined ? [`${n.id} ${n.kind} ${n.elementId}@${n.use}`] : []));

    test('a note beside each command that uses the element, with the element’s ID; an unused one once', () => {
        const g = projectView(uses(), DL);
        expect(copies(g)).toEqual([
            'n:Bank@C1 external Bank@C1',
            'n:Clerk@C1 actor Clerk@C1',
            'n:Clerk@C2 actor Clerk@C2',
            'n:Order@C1 aggregate Order@C1',
            'n:Order@C2 aggregate Order@C2',
            'n:Stock@C1 readmodel Stock@C1',
            'n:Stock@C2 readmodel Stock@C2',
        ]);
        // no note of the element itself once it has copies
        for (const id of ['Bank', 'Clerk', 'Order', 'Stock']) expect(nodeIds(g)).not.toContain(`n:${id}`);
        // a timeline: the copies beside its commands, the cause of E1 (C1) and the command of its 1-hop path (E1 → P → C2 → E2)
        expect(copies(projectView(uses(), { level: 'design-level', timelineId: 'T' }))).toEqual(copies(g));
        // E3 is not in the timeline: the copies of its cause are not drawn there
        expect(copies(projectView(uses(el('command', 'C3', ['by', 'Clerk'], ['emits', 'E3'])), { level: 'design-level', timelineId: 'T' }))).toEqual(copies(g));
        // declared but used by no command: drawn once, where it was (the integrated canvas; a timeline draws only what it uses)
        expect(g.nodes.filter((n) => n.type === 'element' && ['Idle', 'Unused'].includes(n.elementId))).toEqual([
            { type: 'element', id: 'n:Idle', elementId: 'Idle', kind: 'actor' },
            { type: 'element', id: 'n:Unused', elementId: 'Unused', kind: 'aggregate' },
        ]);
        expect(elementIds(projectView(uses(), BP))).toEqual([]);
    });

    test('short edges per copy, within its command note’s row: read model → issuers → command → handler', () => {
        const g = projectView(uses(), DL);
        const related = semanticEdges(g).filter((e) => /^(by|reads|handledBy):/.test(e));
        expect(related).toEqual([
            'by:n:Bank@C1->n:C1',
            'by:n:Clerk@C1->n:C1',
            'by:n:Clerk@C2->n:C2',
            'handledBy:n:C1->n:Order@C1',
            'handledBy:n:C2->n:Order@C2',
            // the read model goes to each issuer of its command note
            'reads:n:Stock@C1->n:Bank@C1',
            'reads:n:Stock@C1->n:Clerk@C1',
            'reads:n:Stock@C2->n:Clerk@C2',
        ]);
        // every copy joins only notes of its command note's row (and the handler, the events it emits)
        for (const n of g.nodes) {
            if (n.type !== 'element' || n.use === undefined) continue;
            const own = g.edges.filter((e) => e.source === n.id || e.target === n.id);
            const kinds = own.map((e) => (e.type === 'semantic' ? e.kind : e.type)).sort();
            if (n.kind === 'aggregate') expect(kinds).toEqual(['emits', 'handledBy']);
            else if (n.kind === 'readmodel') expect(kinds.every((k) => k === 'reads')).toBe(true);
            else expect(kinds[0]).toBe('by');
            for (const e of own)
                expect([e.source, e.target].every((end) => end === `n:${n.use}` || end.endsWith(`@${n.use}`) || !end.startsWith('n:'))).toBe(true);
        }
    });

    test('a command a policy issues has no issuer: its read model goes to the command itself', () => {
        const s = storming(
            ...events('E1', 'E2'),
            el('readmodel', 'Stock'),
            el('aggregate', 'Order'),
            el('command', 'Auto', ['reads', 'Stock'], ['handledBy', 'Order'], ['emits', 'E2']),
            el('policy', 'P', ['on', 'E1'], ['issues', 'Auto']),
            tl('T', 'E1', 'E2'),
        );
        expect(semanticEdges(projectView(s, DL)).filter((e) => e.startsWith('reads:'))).toEqual(['reads:n:Stock@Auto->n:Auto']);
    });

    test('an external system handles a command, and an event comes from one: a copy beside each note', () => {
        const s = storming(
            ...events('Asked', 'Done'),
            el('event', 'Notified', ['from', 'Bank']),
            el('external', 'Bank'),
            el('actor', 'Clerk'),
            el('readmodel', 'Requests', ['from', 'Asked']),
            el('command', 'Pay', ['by', 'Clerk'], ['reads', 'Requests'], ['handledBy', 'Bank'], ['emits', 'Done']),
            el('hotspot', 'Why', ['on', 'Pay']),
            tl('T', 'Asked', 'Done', 'Notified'),
        );
        const g = projectView(s, { level: 'design-level', timelineId: 'T' });
        expect(semanticEdges(g)).toEqual([
            'by:n:Clerk@Pay->n:Pay',
            'emits:n:Bank@Pay->t:e:Asked>e:Done',
            'event-from:n:Bank@t:e:Asked>e:Done>e:Notified->t:e:Asked>e:Done>e:Notified',
            'handledBy:n:Pay->n:Bank@Pay',
            'hotspot-on:n:Why->n:Pay',
            'readmodel-from:t:e:Asked->n:Requests@Pay',
            'reads:n:Requests@Pay->n:Clerk@Pay',
        ]);
        // at Big Picture, a hotspot on a command goes with it
        expect(elementIds(projectView(s, BP))).toEqual([]);
        expect(elementIds(projectView(s, { level: 'big-picture', timelineId: 'T' }))).toEqual([]);
    });

    test('a handler shared by the commands converging on one event note is drawn once before it', () => {
        const s = storming(
            ...events('E1', 'E2', 'E3'),
            el('actor', 'Clerk'),
            el('actor', 'Boss'),
            el('aggregate', 'Order'),
            el('aggregate', 'Stock'),
            el('external', 'Bank'),
            // A and B converge on E1 through Order; A also emits E2 alone; C emits E1 through Stock, D E3 through Bank
            el('command', 'A', ['by', 'Clerk'], ['handledBy', 'Order'], ['emits', 'E1'], ['emits', 'E2']),
            el('command', 'B', ['by', 'Boss'], ['handledBy', 'Order'], ['emits', 'E1']),
            el('command', 'C', ['by', 'Clerk'], ['handledBy', 'Stock'], ['emits', 'E1']),
            el('command', 'D', ['by', 'Clerk'], ['handledBy', 'Bank'], ['emits', 'E3']),
            tl('T', 'E1', 'E2', 'E3'),
        );
        const g = projectView(s, { level: 'design-level', timelineId: 'T' });
        const merged = g.nodes.filter((n) => n.type === 'element' && n.commands);
        expect(merged).toEqual([{ type: 'element', id: 'n:Order@*t:e:E1', elementId: 'Order', kind: 'aggregate', commands: ['A#1', 'B'] }]);
        const edges = semanticEdges(g);
        // each command → the one handler, and one `emits` from it standing for both
        expect(edges).toEqual(expect.arrayContaining(['handledBy:n:A#1->n:Order@*t:e:E1', 'handledBy:n:B->n:Order@*t:e:E1', 'emits:n:Order@*t:e:E1->t:e:E1']));
        expect(g.edges.find((e) => e.type === 'semantic' && e.source === 'n:Order@*t:e:E1')).toMatchObject({ merged: ['emits:A->E1', 'emits:B->E1'] });
        expect(edges.filter((e) => e.endsWith('->t:e:E1'))).toEqual(['emits:n:Order@*t:e:E1->t:e:E1', 'emits:n:Stock@C->t:e:E1']);
        // A's note at E2, which only it emits, has its own handler; neither B's nor A's at E1 has; issuers stay per command
        expect(edges).toEqual(
            expect.arrayContaining(['emits:n:Order@A#2->t:e:E1>e:E2', 'handledBy:n:A#2->n:Order@A#2', 'by:n:Clerk@A#1->n:A#1', 'by:n:Boss@B->n:B']),
        );
        expect(nodeIds(g)).not.toContain('n:Order@B');
        expect(nodeIds(g)).not.toContain('n:Order@A#1');
        // another handler (Stock) or an external system alone is never merged
        expect(nodeIds(g)).toEqual(expect.arrayContaining(['n:Stock@C', 'n:Bank@D']));
    });

    test('a handler is never merged across event notes: an event drawn at two steps gets one before each', () => {
        const s = storming(
            ...events('E1', 'X'),
            el('aggregate', 'Order'),
            el('command', 'A', ['handledBy', 'Order'], ['emits', 'E1']),
            el('command', 'B', ['handledBy', 'Order'], ['emits', 'E1']),
            tl('T', 'E1', 'X', 'E1'),
        );
        const g = projectView(s, { level: 'design-level', timelineId: 'T' });
        expect(g.nodes.filter((n) => n.type === 'element' && n.commands).map((n) => n.id)).toEqual(['n:Order@*t:e:E1', 'n:Order@*t:e:E1>e:X>e:E1']);
        // the integrated canvas draws E1 once: one handler before it
        expect(
            projectView(s, DL)
                .nodes.filter((n) => n.type === 'element' && n.commands)
                .map((n) => n.id),
        ).toEqual(['n:Order@*e:E1']);
    });

    test('copy IDs are stable: the declaration order changes nothing, another use adds a copy and keeps the others', () => {
        const g = projectView(uses(), DL);
        const reversed = uses();
        reversed.elements.reverse();
        expect(projectView(reversed, DL)).toEqual(g);
        const more = projectView(uses(el('command', 'C3', ['by', 'Clerk'], ['emits', 'E3'])), DL);
        expect(nodeIds(more)).toEqual(expect.arrayContaining([...nodeIds(g), 'n:Clerk@C3']));
        expect(matchRenderNodes(g, more).get('n:Clerk@C1')).toBe('n:Clerk@C1');
    });
});

describe('events shown at Design Level only (`level design`, spec §6)', () => {
    /** The element with a `level` clause (only `design` on an event hides it). */
    const leveled = (e: NodeElement, value = 'design'): NodeElement => ({ ...e, clauses: [...e.clauses, { type: 'level', value, range }] });
    const designOnly = (...ids: string[]): NodeElement[] => events(...ids).map((e) => leveled(e));

    test('Big Picture hides them, and the order edges of a timeline join their neighbours', () => {
        const s = storming(...events('A', 'B'), ...designOnly('X', 'Y'), tl('T', 'A', 'X', 'Y', 'B', 'X'));
        const bp = projectView(s, BP);
        expect(nodeIds(bp)).toEqual(['t:e:A', 't:e:A>e:B']);
        expect(sequences(bp)).toEqual(['t:e:A -> t:e:A>e:B']);
        // the occurrences keep their source positions
        expect(nodesOf(bp, 'B')[0].occurrences).toEqual([{ timelineId: 'T', stepPath: [3], eventId: 'B' }]);
        expect(nodeIds(projectView(s, { level: 'big-picture', timelineId: 'T' }))).toEqual(['t:e:A', 't:e:A>e:B']);
    });

    test('Design Level is unchanged by the marks', () => {
        const plain = storming(
            ...events('A', 'B', 'X', 'Z'),
            el('command', 'C', ['emits', 'X']),
            el('hotspot', 'H', ['on', 'X']),
            tl('T', 'A', 'X', ['B', 'Z']),
        );
        const marked = { ...plain, elements: plain.elements.map((e) => (e.kind === 'event' && (e.id === 'X' || e.id === 'Z') ? leveled(e) : e)) };
        for (const options of [DL, { level: 'design-level' as const, timelineId: 'T' }])
            expect(projectView(marked, options)).toEqual(projectView(plain, options));
    });

    test('a group keeps its visible events, and one whose events are all hidden is hidden', () => {
        const s = storming(...events('A', 'B', 'C'), ...designOnly('X', 'Y'), tl('T', 'A', ['X', 'C'], ['X', 'Y'], 'B'));
        const bp = projectView(s, BP);
        expect(nodeIds(bp)).toEqual(['t:e:A', 't:e:A>g:C', 't:e:A>g:C/C', 't:e:A>g:C>e:B']);
        expect(sequences(bp)).toEqual(['t:e:A -> t:e:A>g:C', 't:e:A>g:C -> t:e:A>g:C>e:B']);
        expect(nodesOf(bp, 'C')[0].occurrences).toEqual([{ timelineId: 'T', stepPath: [1, 1], eventId: 'C' }]);
    });

    test('an event in no timeline is hidden too', () => {
        const s = storming(...events('A'), ...designOnly('Z'), tl('T', 'A'));
        expect(nodesOf(projectView(s, BP), 'Z')).toEqual([]);
        expect(nodesOf(projectView(s, DL), 'Z')).toEqual([{ type: 'event', id: 'e:Z', eventId: 'Z', occurrences: [] }]);
    });

    test('hotspots stay, without their `on` edge to a hidden event, on the integrated canvas and in a timeline', () => {
        const s = storming(
            ...events('A', 'B'),
            ...designOnly('X'),
            el('hotspot', 'OnX', ['on', 'X']),
            el('hotspot', 'OnA', ['on', 'A']),
            tl('T', 'A', 'X', 'B'),
        );
        for (const options of [BP, { level: 'big-picture' as const, timelineId: 'T' }]) {
            const g = projectView(s, options);
            expect(elementIds(g)).toEqual(['OnA', 'OnX']);
            expect(semanticEdges(g)).toEqual(['hotspot-on:n:OnA->t:e:A']);
        }
        expect(semanticEdges(projectView(s, DL))).toEqual(['hotspot-on:n:OnA->t:e:A', 'hotspot-on:n:OnX->t:e:A>e:X']);
    });

    test('only a valid `level design` on an event hides it', () => {
        const s = storming(leveled(el('event', 'A'), 'big-picture'), leveled(el('event', 'B'), 'desing'), tl('T', 'A', 'B'));
        expect(nodeIds(projectView(s, BP))).toEqual(['t:e:A', 't:e:A>e:B']);
    });

    test('§8 prefix sharing works on the visible steps, and the integrated canvas names the timelines consistently', () => {
        // Normal: A X B C, Retry: A B D (X is Design Level only): at Big Picture both start with A B
        const s = storming(...events('A', 'B', 'C', 'D'), ...designOnly('X'), tl('Normal', 'A', 'X', 'B', 'C'), tl('Retry', 'A', 'B', 'D'));
        const bp = projectView(s, BP);
        expect(nodeIds(bp)).toEqual(['t:e:A', 't:e:A>e:B', 't:e:A>e:B>e:C', 't:e:A>e:B>e:D']);
        expect(nodesOf(bp, 'B')[0].occurrences).toEqual([
            { timelineId: 'Normal', stepPath: [2], eventId: 'B' },
            { timelineId: 'Retry', stepPath: [1], eventId: 'B' },
        ]);
        // at Design Level they share A only
        expect(nodeIds(projectView(s, DL))).toEqual(['t:e:A', 't:e:A>e:B', 't:e:A>e:B>e:D', 't:e:A>e:X', 't:e:A>e:X>e:B', 't:e:A>e:X>e:B>e:C']);
        const order = (options: ViewOptions) =>
            renderToGraph(projectView(s, options), s)
                .edges.filter((e) => e.kind === 'esSequence')
                .map((e) => `${e.source} -> ${e.target}${e.label ? ` (${e.label.en.name})` : ''}`)
                .sort();
        expect(order(BP)).toEqual(['e:A -> e:B', 'e:B -> e:C (Normal)', 'e:B -> e:D (Retry)']);
        expect(order(DL)).toEqual(['e:A -> e:B (Retry)', 'e:A -> e:X (Normal)', 'e:B -> e:C (Normal)', 'e:B -> e:D (Retry)', 'e:X -> e:B (Normal)']);
    });

    test('properties hold at Big Picture: every visible occurrence on exactly one event node, no hidden event drawn', () => {
        fc.assert(
            fc.property(arbitraryLeveled, (s) => {
                const hidden = new Set(['A', 'C']);
                for (const options of [
                    BP,
                    ...s.elements.filter((e) => e.kind === 'timeline').map((t) => ({ level: 'big-picture' as const, timelineId: t.id })),
                ]) {
                    const g = projectView(s, options);
                    const drawn = eventNodes(g).flatMap((n) => n.occurrences.map(occurrenceKey));
                    const visible = allOccurrences(s, options.timelineId).filter((o) => !hidden.has(o.eventId));
                    expect(drawn.sort()).toEqual(visible.map(occurrenceKey).sort());
                    expect(eventNodes(g).filter((n) => hidden.has(n.eventId))).toEqual([]);
                }
            }),
            { numRuns: 100 },
        );
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
        ...COMMANDS.map((id, i) => el('command', id, ['by', 'Who'], ['handledBy', 'Agg'], ...emits[i].map((e): [RelationKeyword, string] => ['emits', e]))),
        ...policies.map((p, i) =>
            el('policy', `P${i}`, ...p.on.map((e): [RelationKeyword, string] => ['on', e]), ...p.issues.map((c): [RelationKeyword, string] => ['issues', c])),
        ),
        ...hotspots.map((on, i) => el('hotspot', `H${i}`, ...(on ? [['on', on] as [RelationKeyword, string]] : []))),
        ...timelines.map((steps, i) => tl(`T${i}`, ...steps)),
    ])
    .chain((elements) => fc.tuple(fc.constant(elements), fc.shuffledSubarray(elements, { minLength: elements.length, maxLength: elements.length })));

/** An arbitrary storming whose events A and C are Design Level only. */
const arbitraryLeveled = arbitraryStorming.map(([elements]) =>
    storming(
        ...elements.map((e): StormingElement =>
            e.kind === 'event' && (e.id === 'A' || e.id === 'C') ? { ...e, clauses: [{ type: 'level', value: 'design', range }] } : e,
        ),
    ),
);

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
                    /** An `emits` comes out of its command's aggregate when the command has one: the copy beside it. */
                    const commandOf = (id: string) => {
                        const n = byId.get(id);
                        return n?.type === 'element' && n.kind === 'aggregate' && n.use !== undefined ? elementOf(`n:${n.use}`) : elementOf(id);
                    };
                    for (const e of g.edges) {
                        if (e.type !== 'semantic') continue;
                        const merged = byId.get(e.source);
                        if (merged?.type === 'element' && merged.commands) {
                            // a handler shared by commands converging on one event note: each `emits` and `handledBy` is one of theirs
                            const commands = merged.commands.map((c) => elementOf(`n:${c}`));
                            for (const key of e.merged ?? [e.semantic]) {
                                const edge = keys.get(key);
                                expect(edge).toBeDefined();
                                expect([edge!.kind, commands.includes(edge!.sourceId), edge!.targetId === elementOf(e.target)]).toEqual(['emits', true, true]);
                            }
                            continue;
                        }
                        const edge = keys.get(e.semantic);
                        expect(edge).toBeDefined();
                        expect(e.merged).toBeUndefined();
                        const source = e.kind === 'emits' ? commandOf(e.source) : elementOf(e.source);
                        expect([e.kind, source, elementOf(e.target)]).toEqual([edge!.kind, edge!.sourceId, edge!.targetId]);
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

    test('R16: every policy of a timeline filter lies on a 1-hop path between two of its events; every command too, or emits one of them', () => {
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
                    const causes = (cmd: string) => edges.some((e) => e.kind === 'emits' && e.sourceId === cmd && inTimeline.has(e.targetId));
                    for (const c of commands) expect(policies.some((p) => onPath(p, c)) || causes(c)).toBe(true);
                    // the cause of each event of the timeline is drawn
                    for (const c of COMMANDS) if (causes(c)) expect(commands).toContain(c);
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
                    // an event of no timeline may join one, and so may a handler merged before it; every other node stays
                    for (const id of nodeIds(before)) if (!id.startsWith('e:') && !id.includes('@*e:')) expect(ids.has(id)).toBe(true);
                    const pairs = matchRenderNodes(before, after);
                    for (const id of nodeIds(before)) if (ids.has(id)) expect(pairs.get(id)).toBe(id);
                }
            }),
        );
    });
});
