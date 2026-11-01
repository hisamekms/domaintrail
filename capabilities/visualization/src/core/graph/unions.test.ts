import { describe, expect, test } from 'bun:test';
import { buildStructureGraph, VARIANT_INDENT } from './build.js';
import { perLang } from './ir.js';
import { check } from '../../test-helpers.js';

const SALES = `context Sales "販売" {
  id UserId: UUID
  id PartnerId: UUID
  primitive PartyName: String { length(value) > 0 }
  enum Process { DELIVERY "配達" PRINTING "印刷" }

  /// 実際の行為者。
  union Actor "行為者" {
    INTERNAL_USER "社内" { userId: UserId }
    EXTERNAL_PARTY "社外" { name: PartyName  partnerId: PartnerId? }
  }

  value DeliverySpec { planned: Int? }
  value PrintingSpec { copies: Int? }
  union Details "工程別の仕様" by type: Process {
    DELIVERY { details: DeliverySpec }
    PRINTING { details: PrintingSpec }
  }

  union Coverage by form { DESCRIPTION { text: String  invariant notBlank { length(text) > 0 } } }

  id SpecId: UUID
  aggregate Spec "仕様" {
    id: SpecId
    process: Process
    owns details: Details
    actor: Actor
    coverage: Coverage?
    invariant detailsMatchProcess { details.type == process }
    invariant internalOnly { actor.kind == Actor.INTERNAL_USER }
    command change(details: Details) emits Changed
  }
  event Changed { specId: SpecId details: Details }
}
`;

describe('unions', () => {
    test('Structure View draws unions with their variants and value edges per variant', async () => {
        const a = await check({ 'sales.dt': SALES });
        const g = buildStructureGraph(a.model!);
        const node = g.nodes.find((n) => n.id === 'Sales.Details')!;
        expect(node).toMatchObject({ kind: 'union', stereotype: perLang({ ja: '«ユニオン»', en: '«union»' }), parent: 'Sales.Spec@boundary' });
        expect(node.lines.map((l) => l.key.en.name)).toEqual(['type: DELIVERY', `${VARIANT_INDENT}details`, 'type: PRINTING', `${VARIANT_INDENT}details`]);
        const edges = g.edges.filter((e) => e.source === 'Sales.Details').map((e) => [e.id, e.target, e.label?.en.name]);
        expect(edges).toEqual([
            ['Sales.Details.DELIVERY.details', 'Sales.DeliverySpec', 'DELIVERY.details'],
            ['Sales.Details.PRINTING.details', 'Sales.PrintingSpec', 'PRINTING.details'],
        ]);
        expect(g.edges.find((e) => e.id === 'Sales.Spec.details')).toMatchObject({ kind: 'owns', target: 'Sales.Details' });
    });
});
