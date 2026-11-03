// The access check's parts the `link` identity mode adds: an Origin required on what changes something, and the client
// key of a rate limit, which trusts a forwarded address only from loopback (the local cloudflared).
import { describe, expect, test } from 'bun:test';
import { changesState, checkAccess, clientKey, isLoopbackAddress, sessionHostPolicy } from './access.js';

describe('the client key', () => {
    test('is the forwarded CF-Connecting-IP only when the request comes from loopback', () => {
        const forwarded = { 'cf-connecting-ip': '203.0.113.7' };
        expect(clientKey('127.0.0.1', forwarded)).toBe('203.0.113.7');
        expect(clientKey('::1', forwarded)).toBe('203.0.113.7');
        expect(clientKey('::ffff:127.0.0.1', forwarded)).toBe('203.0.113.7');
        expect(clientKey('192.0.2.1', forwarded)).toBe('192.0.2.1');
        expect(clientKey('10.0.0.5', { 'cf-connecting-ip': '127.0.0.1' })).toBe('10.0.0.5');
    });

    test('ignores a forwarded value that is not an address, and falls back to the socket', () => {
        expect(clientKey('127.0.0.1', { 'cf-connecting-ip': 'evil, 1.2.3.4' })).toBe('127.0.0.1');
        expect(clientKey('127.0.0.1', {})).toBe('127.0.0.1');
        expect(clientKey(undefined, {})).toBe('unknown');
    });

    test('loopback addresses', () => {
        expect(['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'].every(isLoopbackAddress)).toBe(true);
        expect(['192.168.1.1', '::ffff:10.0.0.1', '', undefined].some(isLoopbackAddress)).toBe(false);
    });
});

describe('an Origin required on what changes something', () => {
    const policy = { ...sessionHostPolicy(['dt.example.com'], ['https://dt.example.com']), requireOrigin: true };
    test('a read needs none; a change needs the allowed one', async () => {
        expect(changesState('GET')).toBe(false);
        expect(changesState('POST')).toBe(true);
        expect((await checkAccess({ host: 'dt.example.com' }, policy, false)).kind).toBe('anonymous');
        expect((await checkAccess({ host: 'dt.example.com' }, policy, true)).kind).toBe('forbidden');
        expect((await checkAccess({ host: 'dt.example.com', origin: 'https://dt.example.com' }, policy, true)).kind).toBe('anonymous');
        expect((await checkAccess({ host: 'dt.example.com', origin: 'https://evil.example' }, policy, true)).kind).toBe('forbidden');
        // without the requirement (dev, access), a client without an Origin may still change things
        expect((await checkAccess({ host: '127.0.0.1:4321' }, { ...policy, requireOrigin: false }, true)).kind).toBe('anonymous');
    });
});
