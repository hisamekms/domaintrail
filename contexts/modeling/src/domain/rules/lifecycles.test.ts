import { describe, expect, test } from 'bun:test';
import { check, checkSales, codes } from '../../test-helpers.js';
import { generationGateDiagnostics } from './generation-gate.js';
import { applicableOutcomes, hasExternalObligations, validStatesFor } from '../model.js';
import { formatDomain } from '../../infrastructure/syntax/format.js';

const BASE = `
  id RequestId: UUID
  enum CollectionKind { COLLECT DROP_OFF }
  event Collected
  event Received
  event Delivered
  error Invalid
  aggregate Request {
    id: RequestId
    readonly kind: CollectionKind
    state Unassigned
    state Assigned
    state CollectDone
    state Holding
    state Delivered
    initial Unassigned
    create command open(id: RequestId, kind: CollectionKind) {
      outcome opened: -> Unassigned
    }
    command assign() {
      outcome assigned: Unassigned -> Assigned
    }
    command complete()
    transitions for kind == CollectionKind.COLLECT {
      on complete { outcome collected: Assigned -> CollectDone emits Collected }
    }
    transitions for kind == CollectionKind.DROP_OFF {
      on complete {
        outcome received: Assigned -> Holding emits Received
        outcome delivered: Holding -> Delivered emits Delivered
      }
    }
  }
`;

describe('kind-specific lifecycle', () => {
    test('parses, resolves and derives valid states and applicable outcomes', async () => {
        const a = await checkSales(BASE);
        expect(codes(a)).toEqual([]);
        const agg = a.model!.elements.find((e) => e.kind === 'aggregate')!;
        if (agg.kind !== 'aggregate') throw new Error('aggregate missing');
        expect(validStatesFor(agg, 'COLLECT')).toEqual(['Unassigned', 'Assigned', 'CollectDone']);
        expect(validStatesFor(agg, 'DROP_OFF')).toEqual(['Unassigned', 'Assigned', 'Holding', 'Delivered']);
        expect(
            applicableOutcomes(
                agg,
                agg.commands.find((c) => c.name === 'complete')!,
                'COLLECT',
            ).map((o) => o.name),
        ).toEqual(['collected']);
    });

    test('detects duplicate outcome names and missing choice rules', async () => {
        const a = await checkSales(
            BASE.replace('outcome delivered: Holding -> Delivered emits Delivered', 'outcome received: Assigned -> Delivered emits Delivered'),
        );
        expect(codes(a)).toContain('M028');
        expect(a.diagnostics.some((d) => d.message.includes('needs a select rule'))).toBe(true);
    });

    test('generation gate rejects declared-only choice and accepts reasoned external obligation', async () => {
        const text = BASE.replace(
            'outcome collected: Assigned -> CollectDone emits Collected',
            'outcome collected: Assigned -> CollectDone select "approved" emits Collected',
        );
        const a = await checkSales(text);
        expect(a.syntaxOk).toBe(true);
        expect(generationGateDiagnostics(a.sourceModel!).some((d) => d.code === 'M029' && d.severity === 'error')).toBe(true);
        const annotated = await checkSales(text.replace('select "approved"', 'select "approved" @externalCheck("requires human review")'));
        expect(annotated.syntaxOk).toBe(true);
        expect(generationGateDiagnostics(annotated.sourceModel!).some((d) => d.code === 'M029' && d.severity === 'info')).toBe(true);
        expect(hasExternalObligations(annotated.model!)).toBe(true);
        expect(hasExternalObligations(a.model!)).toBe(false);
    });

    test('rejects missing kind initial state and readonly changes', async () => {
        const text = BASE.replace('initial Unassigned', '').replace(
            'outcome assigned: Unassigned -> Assigned',
            'outcome assigned: Unassigned -> Assigned changes kind',
        );
        const a = await checkSales(text);
        expect(a.diagnostics.some((d) => d.message.includes('no initial state'))).toBe(true);
        expect(a.diagnostics.some((d) => d.message.includes("Readonly field 'kind'"))).toBe(true);
    });

    test('composes overlapping groups and multiple initial states', async () => {
        const text = BASE.replace(
            'transitions for kind == CollectionKind.COLLECT {',
            'transitions for kind in CollectionKind.COLLECT | CollectionKind.DROP_OFF { initial Assigned }\n    transitions for kind == CollectionKind.COLLECT {',
        );
        const a = await checkSales(text);
        expect(codes(a)).toEqual([]);
        const agg = a.model!.elements.find((e) => e.kind === 'aggregate')!;
        if (agg.kind !== 'aggregate') throw new Error('aggregate missing');
        expect(validStatesFor(agg, 'COLLECT')).toContain('Assigned');
        expect(validStatesFor(agg, 'DROP_OFF')).toContain('Assigned');
    });

    test('qualified enum selectors use :: and formatter preserves named clauses', async () => {
        const source = `context Shared { enum K { A } } context Sales {
          id RId: UUID
          aggregate R { id: RId readonly kind: Shared.K state S initial S command go()
            transitions for kind == Shared.K::A { on go { outcome same: S -> S select "human" @externalCheck("external policy") } }
          }
        }`;
        const a = await check({ 'model.dt': source });
        expect(codes(a)).toEqual([]);
        const formatted = formatDomain(source);
        expect(formatted).toContain('Shared.K::A');
        expect(formatted).toContain('@externalCheck("external policy")');
        expect(formatDomain(formatted)).toBe(formatted);
    });

    test('choice expressions are Boolean and annotated external rules need non-empty reasons', async () => {
        const typed = await checkSales(
            BASE.replace(
                'outcome collected: Assigned -> CollectDone emits Collected',
                'outcome collected: Assigned -> CollectDone select { 1 } emits Collected',
            ),
        );
        expect(codes(typed)).toContain('M008');
        const annotated = await checkSales(
            BASE.replace(
                'outcome collected: Assigned -> CollectDone emits Collected',
                'outcome collected: Assigned -> CollectDone select "human" @externalCheck("") emits Collected',
            ),
        );
        expect(annotated.diagnostics.some((d) => d.code === 'M028' && d.message.includes('needs a reason'))).toBe(true);
    });

    test('common requirements see fields of every named outcome source state', async () => {
        const text = BASE.replace('state Assigned', 'state Assigned { ready: Bool }')
            .replace('command complete()', 'command complete() { requires readyToFinish { ready } else Invalid }')
            .replace('outcome delivered: Holding -> Delivered emits Delivered', 'outcome delivered: Assigned -> Delivered emits Delivered');
        const a = await checkSales(text);
        expect(a.diagnostics.some((d) => d.code === 'M010' && d.message.includes("'ready'"))).toBe(false);
    });
});
