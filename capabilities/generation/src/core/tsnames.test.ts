// The generator's check of the `.dt` sources (M011), as the project analysis runs it.
import { describe, expect, test } from 'bun:test';
import { checkSales, only } from '../test-helpers.js';

const ORDER = `
  id OrderId: UUID
  id LineId: UUID
  aggregate Order {
    id: OrderId
    owns lines: Line[0..*]
    state Draft
    state Done { doneAt: Timestamp }
    command finish(at: Timestamp) Draft -> Done
  }
  entity Line { id: LineId  quantity: Int }
`;

describe('generated TypeScript names (M011)', () => {
    test('collision between a generated command type and a declared type', async () => {
        const a = await checkSales(`${ORDER} value FinishOrder`);
        expect(only(a, 'M011')[0].message).toBe("Generated TypeScript name 'FinishOrder' for value object 'FinishOrder' collides with command 'Order.finish'.");
    });

    test('collision with the decision of a command, and with the shape of an aggregate', async () => {
        const a = await checkSales(`${ORDER} value FinishOrderDecision value OrderShape`);
        expect(only(a, 'M011').map((d) => d.message)).toEqual([
            "Generated TypeScript name 'FinishOrderDecision' for value object 'FinishOrderDecision' collides with the decision of 'Order.finish'.",
            "Generated TypeScript name 'OrderShape' for value object 'OrderShape' collides with the shape of 'Order'.",
        ]);
    });

    test('collision with the parameters object of a command; a command without parameters has none', async () => {
        const a = await checkSales(
            `${ORDER.replace('Draft -> Done', 'Draft -> Done\n    command archive() Done -> Done')} value FinishOrderParams value ArchiveOrderParams`,
        );
        expect(only(a, 'M011').map((d) => d.message)).toEqual([
            "Generated TypeScript name 'FinishOrderParams' for value object 'FinishOrderParams' collides with the parameters of 'Order.finish'.",
        ]);
    });

    test('reserved discriminant and parameter names', async () => {
        const a = await checkSales(`${ORDER.replace('finish(at: Timestamp)', 'finish(order: Timestamp, default: Int)')} event E { type: String }`);
        expect(only(a, 'M011').map((d) => d.message)).toEqual([
            "Parameter 'order' of FinishOrder collides with the aggregate parameter 'order'.",
            "Parameter name 'default' is a reserved word in TypeScript.",
            "Field 'type' is reserved for the discriminant of generated event types.",
        ]);
    });
});
