import { describe, expect, test } from 'bun:test';
import { generateTypeScript } from '../src/generator/typescript.js';
import { checkSales, codes, only } from './helpers.js';

const SALES = `
  id OrderId: UUID
  /// 注文を受け付けた事実。
  persistent event OrderPlaced "注文受付" { orderId: OrderId }
  event OrderViewed { orderId: OrderId }
  persistent event OrderConfirmed
  value Flags { persistent: Bool }
`;

const salesTs = (model: Parameters<typeof generateTypeScript>[0]): string =>
    generateTypeScript(model).find((f) => f.path === 'Sales.ts')!.content;

describe('persistent events', () => {
    test('events are persisted only when declared persistent', async () => {
        const a = await checkSales(SALES);
        expect(codes(a)).toEqual([]);
        const els = a.model!.elements;
        expect(els['Sales.OrderPlaced'].persistent).toBe(true);
        expect(els['Sales.OrderConfirmed'].persistent).toBe(true);
        expect(els['Sales.OrderViewed'].persistent).toBeUndefined();
        // `persistent` stays usable as a field name.
        expect(els['Sales.Flags'].fields.map((f) => f.name)).toEqual(['persistent']);
    });

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
