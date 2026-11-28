import { describe, expect, test } from 'bun:test';
import { check, checkSales, codes } from '../../test-helpers.js';
import { generationGateDiagnostics } from './generation-gate.js';
import { applicableOutcomes, commandKinds, hasExternalObligations, validStatesFor } from '../model.js';
import { formatDomain } from '../../infrastructure/syntax/format.js';

/** A request with two kinds (ADR 0037): `complete` is common, its outcomes are in each kind's `on complete`. */
const BASE = `
  id RequestId: UUID
  event Collected { requestId: RequestId }
  event Received { requestId: RequestId }
  event Delivered { requestId: RequestId }
  error Invalid
  aggregate Request {
    id: RequestId
    state Unassigned
    state Assigned
    state CollectDone
    state Holding
    state Delivered
    command assign() {
      outcome assigned: Unassigned -> Assigned
    }
    command complete()
    kind COLLECT {
      create command openCollect(id: RequestId) {
        outcome opened: -> Unassigned changes id = id
      }
      on complete { outcome collected: Assigned -> CollectDone emits Collected }
    }
    kind DROP_OFF {
      create command openDropOff(id: RequestId) {
        outcome opened: -> Unassigned changes id = id
      }
      on complete {
        outcome received: Assigned -> Holding emits Received
        outcome delivered: Holding -> Delivered emits Delivered
      }
    }
  }
`;

describe('kind-specific lifecycle', () => {
    test('preserves diagnostics for a kind without declared states', async () => {
        const a = await checkSales(`id XId: UUID aggregate X {
          id: XId
          n: Int
          kind K { on go { outcome o: -> X } }
          command go() changes n
        }`);
        expect(a.diagnostics.map(({ code, message }) => [code, message])).toEqual([
            ['M030', expect.any(String)],
            ['M028', "Outcome 'o' needs a source state."],
            ['M006', expect.any(String)],
        ]);
        expect(a.diagnostics.some(({ message }) => message.includes('mixes named outcomes'))).toBe(false);
    });

    test('keeps M028 create reachability unchanged when there are no declared initials', async () => {
        const a = await checkSales(`id ItemId: UUID aggregate Item {
          id: ItemId state Draft state Done
          create command open(id: ItemId) { outcome made: -> Draft changes id = id }
          command finish() { outcome finished: Draft -> Done }
        }`);
        expect(a.diagnostics.filter((d) => d.code === 'M028').map((d) => d.message)).toEqual([
            "Lifecycle kind '*' of 'Item' has no initial state.",
            "Create outcome 'made' must end at an initial state for kind '*'.",
            "Source state 'Draft' of outcome 'finished' is unreachable for kind '*'.",
        ]);
    });

    test('a factory target does not replace a declared initial for M028', async () => {
        const a = await checkSales(`id ItemId: UUID aggregate Item {
          id: ItemId state Draft state Done initial Draft
          create command open(id: ItemId) { outcome made: -> Done changes id = id }
        }`);
        expect(a.diagnostics.filter((d) => d.code === 'M028').map((d) => d.message)).toEqual([
            "Create outcome 'made' must end at an initial state for kind '*'.",
        ]);
    });

    test('keeps a stateless create command in the legacy command model', async () => {
        const a = await checkSales('id TokenId: UUID aggregate Token { id: TokenId create command make(id: TokenId) changes id = id }');
        expect(codes(a)).toEqual([]);
        const aggregate = a.model!.elements.find((e) => e.kind === 'aggregate')!;
        if (aggregate.kind !== 'aggregate') throw new Error('aggregate missing');
        expect(aggregate.commands[0]?.legacy).toBe(true);
    });

    test('parses, resolves and derives valid states and applicable outcomes', async () => {
        const a = await checkSales(BASE);
        expect(codes(a)).toEqual([]);
        const agg = a.model!.elements.find((e) => e.kind === 'aggregate')!;
        if (agg.kind !== 'aggregate') throw new Error('aggregate missing');
        expect(agg.kinds.map((k) => k.name)).toEqual(['COLLECT', 'DROP_OFF']);
        expect(validStatesFor(agg, 'COLLECT')).toEqual(['Unassigned', 'Assigned', 'CollectDone']);
        expect(validStatesFor(agg, 'DROP_OFF')).toEqual(['Unassigned', 'Assigned', 'Holding', 'Delivered']);
        const complete = agg.commands.find((c) => c.name === 'complete')!;
        expect(applicableOutcomes(agg, complete, 'COLLECT').map((o) => o.name)).toEqual(['collected']);
        const openCollect = agg.commands.find((c) => c.name === 'openCollect')!;
        expect(openCollect.kind).toBe('COLLECT');
        expect(commandKinds(agg, openCollect)).toEqual(['COLLECT']);
        expect(applicableOutcomes(agg, openCollect, 'DROP_OFF')).toEqual([]);
        expect(commandKinds(agg, complete)).toEqual(['COLLECT', 'DROP_OFF']);
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

    test('a kind starts where its create commands end; an initial state of a kind adds to them', async () => {
        const text = BASE.replace('kind COLLECT {', 'kind COLLECT {\n      initial Assigned');
        const a = await checkSales(text);
        expect(codes(a)).toEqual([]);
        const agg = a.model!.elements.find((e) => e.kind === 'aggregate')!;
        if (agg.kind !== 'aggregate') throw new Error('aggregate missing');
        expect(agg.initials).toContainEqual({ state: 'Assigned', kinds: ['COLLECT'] });
        expect(validStatesFor(agg, 'COLLECT')).toContain('Assigned');
    });

    test('a kind field changed by a common outcome, and a readonly kind field changed, are errors', async () => {
        const text = BASE.replace('kind COLLECT {', 'kind COLLECT {\n      readonly route: String\n      depot: String')
            .replace('outcome assigned: Unassigned -> Assigned', 'outcome assigned: Unassigned -> Assigned changes depot')
            .replace(
                'on complete { outcome collected: Assigned -> CollectDone emits Collected }',
                'on complete { outcome collected: Assigned -> CollectDone changes route emits Collected }',
            );
        const a = await checkSales(text);
        expect(a.diagnostics.some((d) => d.code === 'M028' && d.message.includes("Field 'depot' exists only in kind 'COLLECT'"))).toBe(true);
        expect(a.diagnostics.some((d) => d.message.includes("Readonly field 'route'"))).toBe(true);
    });

    test('formats kinds and keeps their clauses', async () => {
        const source = `context Sales {
          id RId: UUID
          aggregate R { id: RId state S command go()
            kind A { create command makeA(id: RId) { outcome made: -> S changes id = id } on go { outcome same: S -> S select "human" @externalCheck("external policy") } }
          }
        }`;
        const a = await check({ 'model.dt': source });
        expect(codes(a)).toEqual([]);
        const formatted = formatDomain(source);
        expect(formatted).toContain('    kind A {\n');
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

    test('primitive external obligations survive in the typed model', async () => {
        const a = await checkSales('primitive P: Int { invariant approved "approved externally" @externalCheck("policy service") }');
        expect(codes(a)).toEqual([]);
        expect(hasExternalObligations(a.model!)).toBe(true);
    });
});
