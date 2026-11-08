// The meaning of a storming: its semantic graph (spec §9.1) and the occurrences of events in timelines (spec §7.2); how
// the Live View draws them is visualization's (domain/storming/project.test.ts).
import { describe, expect, test } from 'bun:test';
import type { Clause, NodeElement, NodeElementKind, RelationKeyword, RemovedKeyword, SourceRange, Storming, StormingElement, Timeline } from './ir.js';
import { buildSemanticGraph, semanticEdgeKey, timelineOccurrences } from './semantic.js';

// ---- IR built by hand (the parser is not needed) ----

const range: SourceRange = { file: 'test.dtes', start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

const el = (kind: NodeElementKind, id: string, ...relations: [RelationKeyword | RemovedKeyword, string][]): NodeElement => ({
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
    });

    test('ADR 0032: relations are directed as Event Storming reads them', () => {
        const s = storming(
            ...events('E', 'F'),
            el('event', 'P', ['from', 'X']),
            el('actor', 'A'),
            el('external', 'X'),
            el('readmodel', 'R', ['from', 'F']),
            el('aggregate', 'G'),
            el('command', 'C', ['by', 'A'], ['by', 'X'], ['reads', 'R'], ['handledBy', 'G'], ['emits', 'E']),
            el('command', 'D', ['by', 'A'], ['handledBy', 'X'], ['emits', 'F']),
            el('hotspot', 'H', ['on', 'E']),
            el('hotspot', 'I', ['on', 'C']),
        );
        expect(buildSemanticGraph(s).edges).toEqual([
            { sourceId: 'X', targetId: 'P', kind: 'event-from' },
            { sourceId: 'F', targetId: 'R', kind: 'readmodel-from' },
            { sourceId: 'A', targetId: 'C', kind: 'by' },
            { sourceId: 'X', targetId: 'C', kind: 'by' },
            { sourceId: 'R', targetId: 'C', kind: 'reads' },
            { sourceId: 'C', targetId: 'G', kind: 'handledBy' },
            { sourceId: 'C', targetId: 'E', kind: 'emits' },
            { sourceId: 'A', targetId: 'D', kind: 'by' },
            { sourceId: 'D', targetId: 'X', kind: 'handledBy' },
            { sourceId: 'D', targetId: 'F', kind: 'emits' },
            { sourceId: 'H', targetId: 'E', kind: 'hotspot-on' },
            { sourceId: 'I', targetId: 'C', kind: 'hotspot-on' },
        ]);
    });

    test("ADR 0032 §14: a command's `on` is Event → Command (`command-on`), only when an actor and no external system issues it", () => {
        const s = storming(
            ...events('E', 'F'),
            el('actor', 'A'),
            el('external', 'X'),
            el('command', 'C', ['by', 'A'], ['on', 'E'], ['emits', 'F']),
            el('command', 'D', ['on', 'E'], ['emits', 'F']),
            el('command', 'K', ['by', 'A'], ['by', 'X'], ['on', 'E']),
            el('command', 'L', ['by', 'A'], ['on', 'A']),
        );
        expect(buildSemanticGraph(s).edges.map(semanticEdgeKey)).toEqual([
            'by:A->C',
            'command-on:E->C',
            'emits:C->F',
            'emits:D->F',
            'by:A->K',
            'by:X->K',
            'by:A->L',
        ]);
    });

    test('invalid relations, duplicate IDs and timelines are left out, nothing is inferred', () => {
        const s = storming(
            ...events('E'),
            el('command', 'C', ['handledBy', 'E'], ['actor', 'E'], ['emits', 'Missing'], ['issues', 'C'], ['emits', 'E'], ['emits', 'E']),
            el('aggregate', 'E'),
            el('policy', 'P', ['on', 'T']),
            tl('T', 'E'),
        );
        const graph = buildSemanticGraph(s);
        expect(graph.nodes.map((n) => `${n.kind}:${n.id}`)).toEqual(['event:E', 'command:C', 'policy:P']);
        expect(graph.edges.map(semanticEdgeKey)).toEqual(['emits:C->E']);
    });

    test('R13: changing a .dt ref keeps the semantic graph', () => {
        const withRef = (path: string): Storming => {
            const s = storming(...events('E'), el('command', 'C', ['emits', 'E']), tl('T', 'E'));
            s.elements[0] = { ...el('event', 'E'), clauses: [{ type: 'ref', path, segments: path.split('.'), range }] };
            return s;
        };
        const [a, b] = [withRef('Sales.OrderPlaced'), withRef('Sales.OrderConfirmed')];
        expect(buildSemanticGraph(a).nodes.map((n) => n.id)).toEqual(buildSemanticGraph(b).nodes.map((n) => n.id));
        expect(buildSemanticGraph(a).edges).toEqual(buildSemanticGraph(b).edges);
    });
});

describe('occurrences (spec §7.2)', () => {
    test('one occurrence per timeline reference, with its step path', () => {
        expect(timelineOccurrences(tl('T', 'A', ['C', 'B'], 'A'))).toEqual([
            { timelineId: 'T', stepPath: [0], eventId: 'A' },
            { timelineId: 'T', stepPath: [1, 0], eventId: 'C' },
            { timelineId: 'T', stepPath: [1, 1], eventId: 'B' },
            { timelineId: 'T', stepPath: [2], eventId: 'A' },
        ]);
    });
});
