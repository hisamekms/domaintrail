// The invite link of the `link` identity mode (SessionAccess on SQLite): issued for an open Collab session only, valid
// any number of times until it expires or is revoked, one live per session (a new one revokes the previous), never
// accepted as another kind of link, revoked with the server's links; and a removed identity's sign-ins revoked.
import { describe, expect, test } from 'bun:test';
import { Collaboration as C } from '../generated/index.js';
import { sessionCommands } from '../domain/commands.js';
import { knownSessionId } from '../domain/ids.js';
import { createUnitOfWork, openDatabase } from '../infrastructure/sqlite.js';
import { createSessionAccess, type SessionAccess } from './access.js';

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
};

const session = knownSessionId('00000000-0000-4000-8000-000000000001');
const solo = knownSessionId('00000000-0000-4000-8000-000000000002');

async function setup(): Promise<{ access: SessionAccess; advance: (ms: number) => void }> {
    let t = Date.parse('2026-11-03T09:00:00Z');
    const uow = createUnitOfWork(openDatabase(':memory:'));
    const facilitator = value(C.makeParticipantId('facilitator'));
    await uow.transaction((stores) => {
        for (const [id, mode] of [
            [session, 'Collab'],
            [solo, 'Solo'],
        ] as const) {
            const { Open } = value(sessionCommands.start({ id, facilitator, name: value(C.makeDisplayName('Ada')), mode, startedAt: new Date(t) }));
            stores.sessions.save(Open.aggregate);
        }
    });
    let n = 0;
    const access = createSessionAccess({ uow, clock: { now: () => new Date(t) }, secrets: { newSecret: () => `s${String(++n).padStart(42, '0')}` } });
    return { access, advance: (ms) => (t += ms) };
}

describe('the invite link', () => {
    test('is valid any number of times until it expires', async () => {
        const { access, advance } = await setup();
        const invite = value(await access.issueInvite({ session, ttlMs: 60 * 60_000 }));
        for (let i = 0; i < 3; i++) expect(await access.checkInvite({ session, code: invite.code })).toEqual(invite.expiresAt);
        expect(await access.liveInvite(session)).toEqual(invite.expiresAt);
        advance(60 * 60_000);
        expect(await access.checkInvite({ session, code: invite.code })).toBeUndefined();
        expect(await access.liveInvite(session)).toBeUndefined();
    });

    test('a new invite revokes the previous one; revoking stops it', async () => {
        const { access } = await setup();
        const first = value(await access.issueInvite({ session, ttlMs: 60_000 }));
        const second = value(await access.issueInvite({ session, ttlMs: 60_000 }));
        expect(await access.checkInvite({ session, code: first.code })).toBeUndefined();
        expect(await access.checkInvite({ session, code: second.code })).toBeDefined();
        expect(await access.revokeInvite(session)).toBe(true);
        expect(await access.revokeInvite(session)).toBe(false);
        expect(await access.checkInvite({ session, code: second.code })).toBeUndefined();
    });

    test('is never a facilitator link, an agent code or a sign-in code, nor the other way round', async () => {
        const { access } = await setup();
        const invite = value(await access.issueInvite({ session, ttlMs: 60_000 }));
        expect((await access.claimFacilitator({ session, code: invite.code, identity: { provider: 'link', subject: 'x' } })).ok).toBe(false);
        expect(await access.redeemAgentCode({ session, code: invite.code })).toBe(false);
        const link = value(await access.issueFacilitatorLink({ session, ttlMs: 60_000 }));
        expect(await access.checkInvite({ session, code: link.code })).toBeUndefined();
        expect(await access.checkInvite({ session, code: invite.code })).toBeDefined();
    });

    test('is not issued for a Solo session, and dies with the server (revokeLinks)', async () => {
        const { access } = await setup();
        expect(await access.issueInvite({ session: solo, ttlMs: 60_000 })).toEqual({ ok: false, error: { type: 'SessionNotOpen' } });
        const invite = value(await access.issueInvite({ session, ttlMs: 60_000 }));
        expect(await access.checkInvite({ session: solo, code: invite.code })).toBeUndefined();
        await access.revokeLinks(session);
        expect(await access.checkInvite({ session, code: invite.code })).toBeUndefined();
    });

    test('removing an identity revokes its sign-ins only', async () => {
        const { access } = await setup();
        const ada = { provider: 'link', subject: 'ada', displayName: 'Ada' } as const;
        const bob = { provider: 'link', subject: 'bob', displayName: 'Bob' } as const;
        const a1 = await access.signIn({ session, identity: ada });
        const a2 = await access.signIn({ session, identity: ada });
        const b = await access.signIn({ session, identity: bob });
        expect(await access.signOutIdentity({ session, identity: { provider: 'link', subject: 'ada' } })).toBe(true);
        expect(await access.signedIn(a1)).toBeUndefined();
        expect(await access.signedIn(a2)).toBeUndefined();
        expect((await access.signedIn(b))?.identity.subject).toBe('bob');
        expect(await access.signOutIdentity({ session, identity: { provider: 'link', subject: 'ada' } })).toBe(false);
    });
});
