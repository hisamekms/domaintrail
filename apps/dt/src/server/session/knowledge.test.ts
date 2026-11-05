// The person a participant's change to the knowledge is by: the Access e-mail when there is one, else the name.
import { describe, expect, test } from 'bun:test';
import type { Identified } from '../http/access.js';
import { actorOf, imageLine, isKnowledgePath } from './knowledge.js';

const who = (identity: { provider: 'dev' | 'access' | 'link'; displayName: string; email?: string }): Identified =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the identity is read
    ({ participant: { id: `${identity.provider}:x`, identity: { subject: 'x', ...identity } } }) as unknown as Identified;

describe('the knowledge routes', () => {
    test('a change is by the verified e-mail of an Access identity, else by the typed name, each namespaced', () => {
        expect(actorOf(who({ provider: 'access', displayName: '山田', email: 'yamada@example.com' }))).toBe('access:yamada@example.com' as never);
        expect(actorOf(who({ provider: 'dev', displayName: '山田' }))).toBe('guest:山田' as never);
        // a typed name that looks like an e-mail is never taken for a verified one
        expect(actorOf(who({ provider: 'link', displayName: 'alice@corp.com' }))).toBe('guest:alice@corp.com' as never);
        expect(actorOf(who({ provider: 'dev', displayName: 'x', email: 'alice@corp.com' }))).toBe('guest:x' as never);
    });

    test('its paths, and the line of an attached image', () => {
        expect([isKnowledgePath('/api/session/knowledge'), isKnowledgePath('/api/session/knowledge/counts'), isKnowledgePath('/api/session/knowledgex')]).toEqual([
            true,
            true,
            false,
        ]);
        expect(imageLine('img_abcdefgh' as never)).toBe('![](image:img_abcdefgh)');
    });
});
