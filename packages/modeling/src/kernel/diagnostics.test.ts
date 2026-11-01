import { describe, expect, test } from 'bun:test';
import { formatDiagnostic, jsonDiagnostic } from './diagnostics.js';

describe('output of a diagnostic', () => {
    const d = {
        file: 'sales/order.dt',
        start: { line: 8, column: 32 },
        end: { line: 8, column: 40 },
        severity: 'error' as const,
        code: 'M009' as const,
        message: "count() requires a collection, but got 'Money'.",
    };

    test('text: the hint on an indented second line', () => {
        expect(formatDiagnostic(d)).toBe("sales/order.dt:8:32 - error M009: count() requires a collection, but got 'Money'.");
        expect(formatDiagnostic({ ...d, hint: 'x' })).toBe("sales/order.dt:8:32 - error M009: count() requires a collection, but got 'Money'.\n  hint: x");
    });

    test('JSON: 1-based start and end, hint only when there is one', () => {
        expect(jsonDiagnostic({ ...d, elementId: 'Sales.Order' })).toEqual({
            file: 'sales/order.dt',
            line: 8,
            column: 32,
            endLine: 8,
            endColumn: 40,
            severity: 'error',
            code: 'M009',
            message: "count() requires a collection, but got 'Money'.",
        });
        expect(jsonDiagnostic({ ...d, hint: 'x' }).hint).toBe('x');
    });
});
