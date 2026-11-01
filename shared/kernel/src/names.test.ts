import { describe, expect, test } from 'bun:test';
import { camel } from './names.js';

describe('camel', () => {
    test('lowers the first letter only', () => {
        expect(camel('OrderLine')).toBe('orderLine');
        expect(camel('order')).toBe('order');
        expect(camel('URL')).toBe('uRL');
        expect(camel('')).toBe('');
    });
});
