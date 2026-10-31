import { describe, expect, test } from 'bun:test';
import { backIndex, popHistory, pushHistory } from '@domaintrail/web/view/history';

const all = () => true;

describe('selection history', () => {
    test('pushes selections, but not the current one again', () => {
        expect(pushHistory(pushHistory(pushHistory([], 'a'), 'b'), 'b')).toEqual(['a', 'b']);
    });

    test('going back drops the current entry', () => {
        expect(backIndex(['a', 'b', 'c'], all)).toBe(1);
        expect(popHistory(['a', 'b', 'c'], all)).toEqual(['a', 'b']);
    });

    test('there is nothing to go back to with one entry or none', () => {
        expect(backIndex(['a'], all)).toBe(-1);
        expect(backIndex([], all)).toBe(-1);
        expect(popHistory(['a'], all)).toEqual(['a']);
    });

    test('skips entries that no longer exist', () => {
        const exists = (id: string) => id !== 'b';
        expect(backIndex(['a', 'b', 'c'], exists)).toBe(0);
        expect(popHistory(['a', 'b', 'c'], exists)).toEqual(['a']);
        expect(backIndex(['b', 'c'], exists)).toBe(-1);
    });
});
