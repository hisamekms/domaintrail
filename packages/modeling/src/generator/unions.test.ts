// What unions make of the generated TypeScript (the DSL and its checks: core/checker/unions.test.ts).
import { describe, expect, test } from 'bun:test';
import { generateTypeScript } from './typescript.js';
import { check } from './test-helpers.js';

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

describe('unions: generated TypeScript', () => {
    test('generates a tagged union per union', async () => {
        const a = await check({ 'sales.dt': SALES });
        const code = generateTypeScript(a.model!).find((f) => f.path === 'Sales.ts')!.content;
        expect(code).toContain(`/**
 * 行為者
 * 実際の行為者。
 * @see sales.dt:8
 */
export type Actor =
    /** 社内 */
    | {
          readonly kind: 'INTERNAL_USER';
          readonly userId: UserId;
      }
    /** 社外 */
    | {
          readonly kind: 'EXTERNAL_PARTY';
          readonly name: PartyName;
          readonly partnerId?: PartnerId;
      };`);
        expect(code).toContain("readonly type: 'DELIVERY';\n          readonly details: DeliverySpec;");
        expect(code).toContain("/** @invariant notBlank: length(text) > 0 */\n    | {\n          readonly form: 'DESCRIPTION';");
        expect(code).toContain('readonly details: Details;');
    });
});
