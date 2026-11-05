// The person a participant's change to the knowledge is by: the Access e-mail when there is one, else the name.
import { describe, expect, test } from 'bun:test';
import type { Identified } from '../http/access.js';
import { actorOf, imageLine, isKnowledgePath } from './knowledge.js';

const who = (identity: { displayName: string; email?: string }): Identified =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the identity is read
    ({ participant: { id: 'dev:x', identity: { provider: 'dev', subject: 'x', ...identity } } }) as unknown as Identified;

describe('the knowledge routes', () => {
    test('a change is by the e-mail of an Access identity, else by the name', () => {
        expect(actorOf(who({ displayName: '山田', email: 'yamada@example.com' }))).toBe('yamada@example.com' as never);
        expect(actorOf(who({ displayName: '山田' }))).toBe('山田' as never);
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
