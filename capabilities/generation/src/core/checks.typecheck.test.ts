// The generated checks, type-checked strictly by tsc.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { generateFromAnalysis, check } from '../test-helpers.js';

const ROOT = path.join(import.meta.dir, '..', '..', '..', '..');
const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** Type-checks generated files strictly (also against unused parameters). */
function tsc(dir: string, files: string[]): string {
    const flags = [
        '--ignoreConfig',
        '--noEmit',
        '--strict',
        '--noUnusedLocals',
        '--noUnusedParameters',
        '--exactOptionalPropertyTypes',
        '--target',
        'ES2023',
        '--module',
        'preserve',
        '--moduleResolution',
        'bundler',
        '--verbatimModuleSyntax',
    ];
    const r = Bun.spawnSync([process.execPath, path.join(ROOT, 'node_modules', '.bin', 'tsc'), ...flags, ...files], { cwd: dir });
    return r.stdout.toString() + r.stderr.toString();
}

const MODEL = {
    'common.dt': `
shared context Common {
  enum Currency { JPY USD }
  primitive Amount: Decimal { invariant nonNegative { value >= 0 } }
  value Money { amount: Amount  currency: Currency }
  value Caption { text: String  max: Amount  invariant fits { text.length <= max } }
}`,
    'sales.dt': `
context Sales {
  id LineId: UUID
  id OrderId: UUID
  primitive Quantity: Int { value in 1..999 }
  primitive Sku: String {
    invariant format { value.matches("^[A-Z]{3}-\\d{4}$") }
    invariant reserved "予約語でない"
    invariant short { value.length <= 8 }
  }
  primitive Code: String { value.matches("^a/b$") }
  enum Reason { Requested Other }
  value Period {
    from: Timestamp
    until: Timestamp?
    invariant ordered { !(exists(until)) || from <= until }
  }
  value Tags { names: String[0..*]  invariant distinctNames { names.unique() } }
  value Approval {
    needed: Quantity
    confirmedBy: String[0..*]
    invariant enough { confirmedBy.length >= needed }
    invariant exact { needed == confirmedBy.length || (confirmedBy.length in 0..needed) }
  }
  entity Line {
    id: LineId
    sku: Sku
    quantity: Quantity
    price: Money
  }
  union Payment {
    Card { last4: String  invariant digits { last4.matches("^\\d{4}$") } }
    Cash
  }
  aggregate Order {
    id: OrderId
    owns lines: Line[0..*]
    payment: Payment?
    prices: Money[0..*]
    invariant distinctSkus { lines.unique(l => l.sku) }
    invariant distinctLines { lines.unique() }
    state Draft
    state Cancelled {
      reason: Reason
      note: String?
      invariant otherNeedsNote { !(reason == Reason.Other) || exists(note) }
      invariant audited "監査済み"
    }
    create command place(id: OrderId) -> Draft
    command add(line: Line, total: Decimal)
      Draft -> Draft
      requires newSku { lines.every(x => x.sku != line.sku) } else Duplicate
      requires known "既知の商品" else Unknown
      requires small { total < 100.5 } else TooLarge
      requires priced { prices.includes(line.price) } else Unpriced
      changes lines
    command cancel(reason: Reason) Draft -> Cancelled
  }
  id TicketId: UUID
  aggregate Ticket {
    id: TicketId
    title: String
    invariant titled "件名がある"
    state Open
    state Closed { invariant short { title.length <= 80 } }
  }
  id MemoId: UUID
  aggregate Memo {
    id: MemoId
    state Open
    state Done
  }
  error Duplicate
  error Unknown
  error TooLarge
  error Unpriced
}`,
};

describe('generated checks', () => {
    test('type-check strictly, with unused parameters reported', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-checks-tsc-'));
        dirs.push(dir);
        const a = await check(MODEL);
        const files = generateFromAnalysis(a);
        for (const f of files) await writeFile(path.join(dir, f.path), f.content);
        expect(
            tsc(
                dir,
                files.map((f) => f.path),
            ),
        ).toBe('');
    });
});
