import { describe, expect, test } from 'bun:test';
import { initialDisplayMode } from './preferences';

describe('initialDisplayMode', () => {
    test('is ラベル with nothing saved', () => {
        expect(initialDisplayMode(null)).toBe('label');
    });

    test('takes the value saved under the former key', () => {
        expect(initialDisplayMode('"ja"')).toBe('label');
        expect(initialDisplayMode('"en"')).toBe('name');
        expect(initialDisplayMode('"both"')).toBe('both');
    });

    test('is ラベル for a former value it cannot read', () => {
        expect(initialDisplayMode('not json')).toBe('label');
        expect(initialDisplayMode('"fr"')).toBe('label');
    });
});
