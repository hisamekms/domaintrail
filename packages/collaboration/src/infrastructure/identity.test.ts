// The identity adapter's pure rules (the verifier and the Identity API against a stand-in for Cloudflare:
// test/session-access.test.ts).
import { describe, expect, test } from 'bun:test';
import { allowedAvatarUrl } from './identity.js';

describe('the Identity API and the identity', () => {
    test('an avatar only when https, without credentials or port, on an allowed host; else initials (none)', () => {
        const hosts = ['avatars.example.com'];
        expect(allowedAvatarUrl('https://avatars.example.com/a.png?s=64', hosts)).toBe('https://avatars.example.com/a.png?s=64');
        expect(allowedAvatarUrl('https://AVATARS.example.com/a.png', hosts)).toBe('https://avatars.example.com/a.png');
        for (const raw of [
            'http://avatars.example.com/a.png',
            'https://evil.example.com/a.png',
            'https://avatars.example.com.evil.example/a.png',
            'https://user:pw@avatars.example.com/a.png',
            'https://avatars.example.com:8443/a.png',
            'data:image/png;base64,AAAA',
            'javascript:alert(1)',
            '/relative.png',
            `https://avatars.example.com/${'a'.repeat(2100)}`,
        ]) {
            expect([raw, allowedAvatarUrl(raw, hosts)]).toEqual([raw, undefined]);
        }
        expect(allowedAvatarUrl('https://avatars.example.com/a.png', [])).toBeUndefined();
    });
});
