// The generated TypeScript of field sets, type-checked by tsc.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { generateTypeScript } from './typescript.js';
import { check } from '../test-helpers.js';

const FILES = {
    'common.dt': `shared context Common {
  primitive TenantId "テナントID": UUID
  /// 契約者ごとにデータを分ける。
  fields Tenanted "テナント所属" {
    tenant: TenantId "テナント"
  }
}`,
    'sales.dt': `context Sales {
  id OrderId: UUID
  id OrderItemId: UUID
  id StaffId: UUID

  fields Performed "実施記録" { performedBy: StaffId "実施者" }

  aggregate Order "注文" with Common.Tenanted {
    id: OrderId
    owns items: OrderItem[0..*]
    invariant sameTenant { all(items, i => i.tenant == tenant) }
    create command place(id: OrderId) -> Draft emits OrderPlaced
    command confirm() Draft -> Confirmed emits OrderConfirmed, Billing.Billed
    state Draft
    state Confirmed { confirmedAt: Timestamp }
  }

  entity OrderItem with Tenanted {
    id: OrderItemId
  }

  event OrderPlaced with Tenanted, Performed { orderId: OrderId }
  event OrderConfirmed { orderId: OrderId }
}`,
    'billing.dt': `context Billing {
  id InvoiceId: UUID
  aggregate Invoice with Sales.Performed {
    id: InvoiceId
    command bill() emits Billed
  }
  event Billed { invoiceId: InvoiceId orderId: Sales.OrderId }
}`,
};

describe('field sets: generated TypeScript', () => {
    let dir: string;
    let a: Awaited<ReturnType<typeof check>>;
    beforeAll(async () => {
        a = await check(FILES);
        dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-fieldsets-'));
        await mkdir(path.join(dir, 'generated'), { recursive: true });
        for (const f of generateTypeScript(a.model!)) await writeFile(path.join(dir, 'generated', f.path), f.content);
    });
    afterAll(() => rm(dir, { recursive: true, force: true }));

    test('compiles, and the extended fields are required', async () => {
        await writeFile(
            path.join(dir, 'use.ts'),
            `import type { Common, Sales } from './generated/index.js';
declare const tenant: Common.TenantId;
declare const staff: Sales.StaffId;
declare const order: Sales.OrderId;
export const placed: Sales.OrderPlaced = { type: 'OrderPlaced', tenant, performedBy: staff, orderId: order };
export const events: readonly Sales.OrderEvent[] = [placed];
export const all: readonly Sales.DomainEvent[] = [placed];
// @ts-expect-error the tenant comes from the field set and is required
export const missing: Sales.OrderPlaced = { type: 'OrderPlaced', performedBy: staff, orderId: order };
`,
        );
        const tsc = path.join(import.meta.dir, '..', '..', '..', '..', 'node_modules', '.bin', 'tsc');
        const r = Bun.spawnSync(
            [process.execPath, tsc, '--noEmit', '--strict', '--target', 'ES2023', '--module', 'preserve', '--moduleResolution', 'bundler', 'use.ts'],
            { cwd: dir },
        );
        expect(r.stdout.toString() + r.stderr.toString()).toBe('');
        expect(r.exitCode).toBe(0);
    });
});
