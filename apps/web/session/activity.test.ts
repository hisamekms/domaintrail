// What a running run is doing, as its line shows it (ADR 0026, amendment): a file by its last segment, a command whole.
import { describe, expect, test } from 'bun:test';
import { shownSubject } from './activity';

describe("a run's activity line", () => {
    test('a file by its last segment, a command as it is', () => {
        expect(shownSubject('reading', 'sales/order.dt')).toBe('order.dt');
        expect(shownSubject('editing', 'returns.dtes')).toBe('returns.dtes');
        expect(shownSubject('reading', 'model/')).toBe('model');
        expect(shownSubject('checking', 'dt check')).toBe('dt check');
    });
});
