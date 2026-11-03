// The access check's parts the `link` identity mode adds: an Origin required on what changes something, and the client
// key of a rate limit, which trusts a forwarded address only from loopback and only when this process started the
// quick tunnel (its own cloudflared).
import { describe, expect, test } from 'bun:test';
import { addressKey, changesState, checkAccess, clientKey, isLoopbackAddress, sessionHostPolicy } from './access.js';

describe('the client key', () => {
    test('is the forwarded CF-Connecting-IP only from loopback, with the tunnel this process started', () => {
        const forwarded = { 'cf-connecting-ip': '203.0.113.7' };
        expect(clientKey('127.0.0.1', forwarded, true)).toBe('203.0.113.7');
        expect(clientKey('::1', forwarded, true)).toBe('203.0.113.7');
        expect(clientKey('::ffff:127.0.0.1', forwarded, true)).toBe('203.0.113.7');
        expect(clientKey('192.0.2.1', forwarded, true)).toBe('192.0.2.1');
        expect(clientKey('10.0.0.5', { 'cf-connecting-ip': '127.0.0.1' }, true)).toBe('10.0.0.5');
        // a self-managed proxy (no --tunnel): the header is never read, and loopback tells no client from another
        expect(clientKey('127.0.0.1', forwarded)).toBeUndefined();
        expect(clientKey('127.0.0.1', forwarded, false)).toBeUndefined();
    });

    test('IPv6 counts by its /64; an IPv4-mapped address as its IPv4', () => {
        expect(addressKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
        expect(addressKey('2001:DB8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
        expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
        expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
        expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
        expect(clientKey('127.0.0.1', { 'cf-connecting-ip': '2001:db8:1:2::99' }, true)).toBe('2001:db8:1:2::/64');
        expect(clientKey('2001:db8:1:2::5', {})).toBe('2001:db8:1:2::/64');
    });

    test('ignores a forwarded value that is not an address, and falls back to the socket', () => {
        expect(clientKey('127.0.0.1', { 'cf-connecting-ip': 'evil, 1.2.3.4' }, true)).toBeUndefined();
        expect(clientKey('127.0.0.1', {}, true)).toBeUndefined();
        expect(clientKey(undefined, {})).toBeUndefined();
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
