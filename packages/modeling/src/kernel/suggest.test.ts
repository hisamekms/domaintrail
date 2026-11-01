import { describe, expect, test } from 'bun:test';
import { closest, distance } from './suggest.js';

describe('edit distance', () => {
    test('counts insertions, deletions, substitutions and swaps of neighbors', () => {
        expect(distance('confirm', 'confirm')).toBe(0);
        expect(distance('confirmd', 'confirmed')).toBe(1);
        expect(distance('cnofirm', 'confirm')).toBe(1);
        expect(distance('kitten', 'sitting')).toBe(3);
    });

    test('suggests at most 3 names within a third of the length, best first, ignoring case', () => {
        expect(closest('Ordr', ['Order', 'Orders', 'Odor', 'Customer'])).toEqual(['Order']);
        expect(closest('OrderLne', ['Order', 'OrderLines', 'OrderLone', 'OrderLine', 'OrderLane'])).toEqual(['OrderLane', 'OrderLine', 'OrderLone']);
        expect(closest('status', ['Status', 'stats'])).toEqual(['Status']); // another letter case only: the one suggestion
        expect(closest('Payment', ['Customer', 'Order'])).toEqual([]);
        expect(closest('x', ['y'])).toEqual([]);
    });

    test('an exact match of a name of another context is the only suggestion', () => {
        expect(closest('OrderId', [{ name: 'Order' }, { name: 'Sales.OrderId', key: 'OrderId' }])).toEqual(['Sales.OrderId']);
    });
});
