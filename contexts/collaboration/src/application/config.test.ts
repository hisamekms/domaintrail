// Collaboration's settings in the `session` section of domaintrail.jsonc (composed with the others and read from a
// file: packages/presentation/src/config/config.test.ts).
import { describe, expect, test } from 'bun:test';
import {
    ACCESS_CHECKS,
    type ResolvedClassifierConfig,
    resolveCollaborationConfig,
    validateAccessNeeded,
    validateCollaborationConfig,
    validateIdentityConfig,
    validatePreviousRunsConfig,
} from './config.js';

/** The first refusal of the section's checks, in the order the app runs them. */
const refusal = (session: Record<string, unknown>): string | undefined => {
    const fail = (msg: string): never => {
        throw new Error(msg);
    };
    try {
        validateIdentityConfig(session, fail);
        const access = session.access;
        if (access !== undefined) {
            if (typeof access !== 'object' || access === null || Array.isArray(access)) return fail("'session.access' must be an object");
            for (const check of Object.values(ACCESS_CHECKS)) check(access as Record<string, unknown>, fail);
        }
        validateAccessNeeded(session, fail);
        if (typeof session.agent === 'object' && session.agent !== null) validatePreviousRunsConfig(session.agent as Record<string, unknown>, fail);
        validateCollaborationConfig(session, fail);
        return undefined;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
};

const CLASSIFIER_DEFAULTS: ResolvedClassifierConfig = {
    enabled: false,
    provider: 'cloudflare-clef',
    model: 'clef-flash',
    apiTokenEnv: 'CLOUDFLARE_API_TOKEN',
    threshold: 0.5,
};

describe("Collaboration's settings", () => {
    test('defaults: the dev identity, 50 participants, the quick reactions, no classifier', () => {
        expect(resolveCollaborationConfig()).toEqual({
            identity: 'dev',
            maxPreviousRunDiff: 20480,
            maxParticipants: 50,
            quickReactions: ['👍', '👀', '🤔', '🎉', '❤️', '🙏'],
            classifier: CLASSIFIER_DEFAULTS,
        });
    });

    test("access: the team, the audience, the public URL (the hosts and origins allowed are the app's)", () => {
        const session = {
            identity: 'access',
            access: { teamDomain: 'team.cloudflareaccess.com', audience: 'aud', publicUrl: 'https://s.example.com', avatarHosts: ['img.example.com'] },
            agent: { maxPreviousRunDiff: 4096 },
            maxParticipants: 5,
        } as const;
        expect(refusal(session)).toBeUndefined();
        expect(resolveCollaborationConfig({ ...session, access: { ...session.access, avatarHosts: [...session.access.avatarHosts] } })).toEqual({
            identity: 'access',
            access: {
                teamDomain: 'team.cloudflareaccess.com',
                audience: 'aud',
                publicUrl: 'https://s.example.com',
                acceptCookie: false,
                avatarHosts: ['img.example.com'],
            },
            maxPreviousRunDiff: 4096,
            maxParticipants: 5,
            quickReactions: ['👍', '👀', '🤔', '🎉', '❤️', '🙏'],
            classifier: CLASSIFIER_DEFAULTS,
        });
    });

    test('the quick reactions: one emoji each, kept in the form reactions are (❤ as ❤️)', () => {
        const quickReactions = ['❤', '👨‍👩‍👧‍👦', '👍🏽', '🇯🇵', '1⃣'];
        expect(refusal({ quickReactions })).toBeUndefined();
        expect(resolveCollaborationConfig({ quickReactions }).quickReactions).toEqual(['❤️', '👨‍👩‍👧‍👦', '👍🏽', '🇯🇵', '1️⃣']);
    });

    test('the classifier: opt-in, Clef Flash, the token by the name of its variable', () => {
        const classifier = { enabled: true, accountId: '0123456789abcdef0123456789abcdef', model: 'clef', threshold: 0.7 } as const;
        expect(refusal({ classifier })).toBeUndefined();
        expect(resolveCollaborationConfig({ classifier }).classifier).toEqual({
            enabled: true,
            provider: 'cloudflare-clef',
            model: 'clef',
            accountId: '0123456789abcdef0123456789abcdef',
            apiTokenEnv: 'CLOUDFLARE_API_TOKEN',
            threshold: 0.7,
        });
    });

    test.each([
        [{ identity: 'basic' }, "'session.identity' must be one of 'dev', 'access'"],
        [{ identity: 'access' }, "'session.identity' \"access\" needs 'session.access' with 'teamDomain' and 'audience'"],
        [{ access: [] }, "'session.access' must be an object"],
        [{ access: { teamDomain: 't' } }, "'session.access.audience' must be a non-empty string"],
        [{ access: { teamDomain: 't', audience: 'a', publicUrl: 'nope' } }, "'session.access.publicUrl' must be a URL"],
        [
            { access: { teamDomain: 'https://t.example.com/path', audience: 'a' } },
            "'session.access.teamDomain' must be a host name like '<team>.cloudflareaccess.com': 'https://t.example.com/path'",
        ],
        [{ access: { teamDomain: 't', audience: 'a', acceptCookie: 'yes' } }, "'session.access.acceptCookie' must be a boolean"],
        [
            { access: { teamDomain: 't', audience: 'a', avatarHosts: ['https://x.example'] } },
            "'session.access.avatarHosts' must hold host names only: 'https://x.example'",
        ],
        [{ agent: { maxPreviousRunDiff: -1 } }, "'session.agent.maxPreviousRunDiff' must be a non-negative integer (characters of diff)"],
        [{ agent: { maxPreviousRunDiff: 1.5 } }, "'session.agent.maxPreviousRunDiff' must be a non-negative integer (characters of diff)"],
        [{ maxParticipants: 0 }, "'session.maxParticipants' must be a positive integer"],
        [{ quickReactions: [] }, "'session.quickReactions' must be an array of 1 to 8 emoji"],
        [{ quickReactions: '👍' }, "'session.quickReactions' must be an array of 1 to 8 emoji"],
        [{ quickReactions: ['👍', '👍', '👍', '👍', '👍', '👍', '👍', '👍', '👍'] }, "'session.quickReactions' must be an array of 1 to 8 emoji"],
        [{ quickReactions: ['ok'] }, "'session.quickReactions' must hold one emoji per entry: 'ok'"],
        [{ quickReactions: ['👍👍'] }, "'session.quickReactions' must hold one emoji per entry: '👍👍'"],
        [{ quickReactions: ['❤', '❤️'] }, "'session.quickReactions' must not repeat an emoji: '❤️'"],
        [{ classifier: { enabled: true } }, "'session.classifier' enabled needs 'accountId'"],
        [{ classifier: { provider: 'openai' } }, "'session.classifier.provider' must be one of 'cloudflare-clef'"],
        [{ classifier: { model: 'jev' } }, "'session.classifier.model' must be one of 'clef-flash', 'clef'"],
        [{ classifier: { accountId: 'acct' } }, "'session.classifier.accountId' must be a Cloudflare account ID (32 hexadecimal digits)"],
        [
            { classifier: { apiTokenEnv: 'cf-token value' } },
            "'session.classifier.apiTokenEnv' must be the name of an environment variable (the token itself never goes in the file)",
        ],
        [{ classifier: { threshold: 1 } }, "'session.classifier.threshold' must be a number between 0 and 1"],
        [{ classifier: { token: 'x' } }, "unknown key 'session.classifier.token'"],
        // the first refusal wins: the identity before the classifier, the classifier before the participants
        [{ classifier: { token: 'x' }, identity: 'basic' }, "'session.identity' must be one of 'dev', 'access'"],
        [{ maxParticipants: 0, classifier: { model: 'jev' } }, "'session.classifier.model' must be one of 'clef-flash', 'clef'"],
    ])('%j is refused', (session, message) => {
        expect(refusal(session)).toBe(message);
    });
});
