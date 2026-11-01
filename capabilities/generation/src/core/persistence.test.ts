// What persistent events make of the generated TypeScript, and the generator's check of `PersistentEvent` (M011) (the
// DSL: core/checker/persistence.test.ts).
import { describe, expect, test } from 'bun:test';
import { generateTypeScript } from './typescript.js';
import { checkSales, only } from '../test-helpers.js';

const SALES = `
  id OrderId: UUID
  /// 注文を受け付けた事実。
  persistent event OrderPlaced "注文受付" { orderId: OrderId }
  event OrderViewed { orderId: OrderId }
  persistent event OrderConfirmed
  value Flags { persistent: Bool }
`;

const salesTs = (model: Parameters<typeof generateTypeScript>[0]): string => generateTypeScript(model).find((f) => f.path === 'Sales.ts')!.content;

describe('persistent events: generated', () => {
    test('generated: a JSDoc tag on each persistent event and the PersistentEvent union', async () => {
        const ts = salesTs((await checkSales(SALES)).model!);
        expect(ts).toContain(
            '/**\n * 注文受付\n * 注文を受け付けた事実。\n * @persistent Persisted: storing this event is part of its contract.\n * @see sales.dt:5\n */\nexport interface OrderPlaced {',
        );
        expect(ts).toContain('\n\n/** @see sales.dt:6 */\nexport interface OrderViewed {');
        expect(ts).toContain('export type PersistentEvent = OrderPlaced | OrderConfirmed;');
    });

    test('generated: no PersistentEvent without persistent events', async () => {
        const ts = salesTs((await checkSales(SALES.replaceAll('persistent event', 'event'))).model!);
        expect(ts).not.toContain('PersistentEvent');
        expect(ts).not.toContain('@persistent');
    });

    test('M011: PersistentEvent collides with a declared type only when generated', async () => {
        const a = await checkSales(`${SALES} value PersistentEvent`);
        expect(only(a, 'M011').map((d) => d.message)).toEqual([
            "Generated TypeScript name 'PersistentEvent' for the union of persistent events collides with value object 'PersistentEvent'.",
        ]);
        const b = await checkSales(`${SALES.replaceAll('persistent event', 'event')} value PersistentEvent`);
        expect(only(b, 'M011')).toEqual([]);
    });
});
