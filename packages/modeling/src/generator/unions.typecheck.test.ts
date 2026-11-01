// The generated TypeScript of unions, type-checked by tsc.
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
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

describe('unions', () => {
    test('the generated union type-checks against hand-written code', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-union-'));
        try {
            const a = await check({ 'sales.dt': SALES });
            await mkdir(path.join(dir, 'gen'));
            for (const f of generateTypeScript(a.model!)) await writeFile(path.join(dir, 'gen', f.path), f.content);
            await writeFile(
                path.join(dir, 'use.ts'),
                `import type { Sales } from './gen/index.js';
export const actor: Sales.Actor = { kind: 'EXTERNAL_PARTY', name: 'x' as Sales.PartyName };
export const details: Sales.Details = { type: 'PRINTING', details: { copies: 3 } };
// @ts-expect-error the payload must match the variant
export const wrong: Sales.Details = { type: 'PRINTING', details: { planned: 3 } };
export const name = (a: Sales.Actor): string => (a.kind === 'EXTERNAL_PARTY' ? a.name : a.userId);
`,
            );
            const tsc = path.join(import.meta.dir, '..', '..', '..', '..', 'node_modules', '.bin', 'tsc');
            const r = Bun.spawnSync([tsc, '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', 'use.ts'], {
                cwd: dir,
            });
            expect(r.stdout.toString() + r.stderr.toString()).toBe('');
            expect(r.exitCode).toBe(0);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
