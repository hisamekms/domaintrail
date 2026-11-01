import { describe, expect, test } from 'bun:test';
import { knownRequestId, knownSessionId } from './ids.js';

describe('IDs from values known to be UUIDs', () => {
    test('a UUID is the ID; anything else is a programming error', () => {
        expect<string>(knownSessionId('6f0b0b1e-1f0a-4c3e-9a4e-000000000001')).toBe('6f0b0b1e-1f0a-4c3e-9a4e-000000000001');
        expect(() => knownRequestId('request-1')).toThrow('Not a UUID (InvalidRequestId): request-1');
    });
});
