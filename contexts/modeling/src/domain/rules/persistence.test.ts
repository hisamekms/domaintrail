import { describe, expect, test } from 'bun:test';
import { checkSales, codes } from '../../test-helpers.js';

const SALES = `
  id OrderId: UUID
  /// 注文を受け付けた事実。
  persistent event OrderPlaced "注文受付" { orderId: OrderId }
  event OrderViewed { orderId: OrderId }
  persistent event OrderConfirmed
  value Flags { persistent: Bool }
`;

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
});
