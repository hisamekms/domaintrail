import { expect, test } from 'bun:test';
import { portableRegexPattern } from './checks.js';

test('portable regex expands shorthands correctly inside a character class', () => {
    const pattern = new RegExp(portableRegexPattern('^[^@\\s]+@[^@\\s]+$'), 'u');
    expect(pattern.test('a@b')).toBe(true);
    expect(pattern.test('a b@c')).toBe(false);
    expect(pattern.test('a@b c')).toBe(false);
});

test('portable regex leaves escaped backslashes before d unchanged', () => {
    const pattern = new RegExp(portableRegexPattern('^\\\\d$'), 'u');
    expect(pattern.test('\\d')).toBe(true);
    expect(pattern.test('7')).toBe(false);
});

test('portable regex rejects a negative shorthand inside a character class', () => {
    expect(() => portableRegexPattern('[\\S]')).toThrow('not portable inside a character class');
});
