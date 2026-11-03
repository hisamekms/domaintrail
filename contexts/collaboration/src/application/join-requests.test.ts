// The join requests of the `link` identity mode: pending, approved (admitted once), denied, expired with their time or
// their invite, and the limits (pending, per client key).
import { describe, expect, test } from 'bun:test';
import { Collaboration as C } from '../generated/index.js';
import { createJoinRequests, type JoinRequests } from './join-requests.js';

const name = (raw: string): C.DisplayName => {
    const made = C.makeDisplayName(raw);
    if (!made.ok) throw new Error(raw);
    return made.value;
};

/** A clock the test moves, and secrets that count up. */
function setup(over: { maxPending?: number; perKey?: number; ttlMs?: number; windowMs?: number; perInvite?: number } = {}): {
    requests: JoinRequests;
    advance: (ms: number) => void;
    now: () => Date;
} {
    let t = Date.parse('2026-11-03T09:00:00Z');
    let n = 0;
    const requests = createJoinRequests({
        clock: { now: () => new Date(t) },
        secrets: { newSecret: () => `${String(++n).padStart(4, '0')}-${'x'.repeat(38)}` },
        ...over,
    });
    return { requests, advance: (ms) => (t += ms), now: () => new Date(t) };
}

const HOUR = 60 * 60_000;

describe('join requests', () => {
    test('a request is pending, the facilitator approves it, and the visitor is admitted once', () => {
        const { requests, now } = setup();
        const made = requests.request({ name: name('Ada'), key: '203.0.113.1', inviteExpiresAt: new Date(now().getTime() + HOUR) });
        if (!made.ok) throw new Error('refused');
        expect(requests.status(made.value.secret)).toMatchObject({ state: 'pending', request: { name: 'Ada' } });
        expect(requests.pending().map((r) => r.id)).toEqual([made.value.id]);
        expect(requests.approve(made.value.id).ok).toBe(true);
        expect(requests.pending()).toEqual([]);
        expect(requests.status(made.value.secret).state).toBe('approved');
        expect(String(requests.admit(made.value.secret)?.name)).toBe('Ada');
        expect(requests.admit(made.value.secret)).toBeUndefined();
        expect(requests.status(made.value.secret).state).toBe('expired');
    });

    test('a denied request stays denied for the visitor and is never admitted; deciding twice is refused', () => {
        const { requests, now } = setup();
        const made = requests.request({ name: name('Bob'), key: 'k', inviteExpiresAt: new Date(now().getTime() + HOUR) });
        if (!made.ok) throw new Error('refused');
        expect(requests.deny(made.value.id).ok).toBe(true);
        expect(requests.status(made.value.secret).state).toBe('denied');
        expect(requests.admit(made.value.secret)).toBeUndefined();
        expect(requests.approve(made.value.id)).toEqual({ ok: false, error: { type: 'JoinRequestNotFound' } });
        expect(requests.deny('unknown')).toEqual({ ok: false, error: { type: 'JoinRequestNotFound' } });
    });

    test('a request expires after ten minutes, or with its invite when that is sooner', () => {
        const { requests, advance, now } = setup();
        const long = requests.request({ name: name('Ada'), key: 'a', inviteExpiresAt: new Date(now().getTime() + HOUR) });
        const short = requests.request({ name: name('Bob'), key: 'b', inviteExpiresAt: new Date(now().getTime() + 60_000) });
        if (!long.ok || !short.ok) throw new Error('refused');
        expect(long.value).not.toEqual(short.value);
        advance(60_000);
        expect(requests.sweep()).toBe(true);
        expect(requests.status(short.value.secret).state).toBe('expired');
        expect(requests.pending().map((r) => String(r.name))).toEqual(['Ada']);
        advance(9 * 60_000);
        expect(requests.pending()).toEqual([]);
        expect(requests.approve(long.value.id).ok).toBe(false);
    });

    test('the invite revoked: every pending request expires, decided ones stay', () => {
        const { requests, now } = setup();
        const until = new Date(now().getTime() + HOUR);
        const a = requests.request({ name: name('Ada'), key: 'a', inviteExpiresAt: until });
        const b = requests.request({ name: name('Bob'), key: 'b', inviteExpiresAt: until });
        if (!a.ok || !b.ok) throw new Error('refused');
        requests.approve(a.value.id);
        requests.expirePending();
        expect(requests.status(b.value.secret).state).toBe('expired');
        expect(String(requests.admit(a.value.secret)?.name)).toBe('Ada');
    });

    test('at most maxPending pending at once', () => {
        const { requests, now } = setup({ maxPending: 2 });
        const until = new Date(now().getTime() + HOUR);
        expect(requests.request({ name: name('A'), key: '1', inviteExpiresAt: until }).ok).toBe(true);
        const second = requests.request({ name: name('B'), key: '2', inviteExpiresAt: until });
        expect(requests.request({ name: name('C'), key: '3', inviteExpiresAt: until })).toEqual({ ok: false, error: { type: 'TooManyPending', max: 2 } });
        if (!second.ok) throw new Error('refused');
        requests.deny(second.value.id);
        expect(requests.request({ name: name('C'), key: '3', inviteExpiresAt: until }).ok).toBe(true);
    });

    test('at most perKey requests per window from one client key; another key is not limited', () => {
        const { requests, advance, now } = setup({ perKey: 2, windowMs: 60_000 });
        const until = () => new Date(now().getTime() + HOUR);
        expect(requests.request({ name: name('A'), key: 'x', inviteExpiresAt: until() }).ok).toBe(true);
        advance(10_000);
        expect(requests.request({ name: name('A'), key: 'x', inviteExpiresAt: until() }).ok).toBe(true);
        expect(requests.request({ name: name('A'), key: 'x', inviteExpiresAt: until() })).toEqual({
            ok: false,
            error: { type: 'RateLimited', retryAfterMs: 50_000 },
        });
        expect(requests.request({ name: name('B'), key: 'y', inviteExpiresAt: until() }).ok).toBe(true);
        advance(50_000);
        expect(requests.request({ name: name('A'), key: 'x', inviteExpiresAt: until() }).ok).toBe(true);
    });

    test('at most perInvite requests through one invite, whatever client keys they claim; a new invite starts again', () => {
        const { requests, now } = setup({ perInvite: 3, maxPending: 10 });
        const until = new Date(now().getTime() + HOUR);
        for (let i = 0; i < 3; i++) expect(requests.request({ name: name(`A${i}`), key: `spoofed-${i}`, inviteExpiresAt: until }).ok).toBe(true);
        expect(requests.request({ name: name('B'), key: 'spoofed-9', inviteExpiresAt: until })).toEqual({
            ok: false,
            error: { type: 'InviteExhausted', max: 3 },
        });
        requests.expirePending();
        expect(requests.request({ name: name('B'), key: 'spoofed-9', inviteExpiresAt: until }).ok).toBe(true);
    });

    test('the secret is not the ID, and a request is looked up by its secret only', () => {
        const { requests, now } = setup();
        const made = requests.request({ name: name('Ada'), key: 'k', inviteExpiresAt: new Date(now().getTime() + HOUR) });
        if (!made.ok) throw new Error('refused');
        expect(made.value.secret).not.toBe(made.value.id);
        expect(requests.status(made.value.id).state).toBe('expired');
    });
});
