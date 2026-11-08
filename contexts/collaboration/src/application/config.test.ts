// Collaboration's settings in domaintrail.jsonc (`collab`, `classifier`, `agent.run.maxPreviousRunDiff`) (composed with the others and read from a
// file: apps/dt/src/config/config.test.ts).
import { describe, expect, test } from 'bun:test';
import {
    ACCESS_CHECKS,
    type ResolvedClassifierConfig,
    resolveCollaborationConfig,
    validateAccessNeeded,
    validateClassifierConfig,
    validateCollaborationConfig,
    validateIdentityConfig,
    validatePreviousRunsConfig,
} from './config.js';

/** The first refusal of the checks of `collab` (and of `run`: `agent.run`), in the order the app runs them. */
const refusal = (collab: Record<string, unknown>, run?: Record<string, unknown>): string | undefined => {
    const fail = (msg: string): never => {
        throw new Error(msg);
    };
    try {
        validateIdentityConfig(collab, fail);
        const access = collab.access;
        if (access !== undefined) {
            if (typeof access !== 'object' || access === null || Array.isArray(access)) return fail("'collab.access' must be an object");
            for (const check of Object.values(ACCESS_CHECKS)) check(access as Record<string, unknown>, fail);
        }
        validateAccessNeeded(collab, fail);
        if (run) validatePreviousRunsConfig(run, fail);
        validateCollaborationConfig(collab, fail);
        return undefined;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
};

/** The refusal of the `classifier` section's checks, if any. */
const classifierRefusal = (classifier: unknown): string | undefined => {
    try {
        validateClassifierConfig(classifier, (msg) => {
            throw new Error(msg);
        });
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
    threshold: 0.9,
};

describe("Collaboration's settings", () => {
    test('defaults: the dev identity, 50 participants, the quick reactions, no classifier', () => {
        expect(resolveCollaborationConfig()).toEqual({
            identity: 'dev',
            maxPreviousRunDiff: 20480,
            maxParticipants: 50,
            quickReactions: ['👍', '👀', '🤔', '🎉', '❤️', '🙏'],
            classifier: CLASSIFIER_DEFAULTS,
            templates: [],
        });
    });

    test("access: the team, the audience, the public URL (the hosts and origins allowed are the app's)", () => {
        const collab = {
            identity: 'access',
            access: { teamDomain: 'team.cloudflareaccess.com', audience: 'aud', publicUrl: 'https://s.example.com', avatarHosts: ['img.example.com'] },
            maxParticipants: 5,
        } as const;
        expect(refusal(collab, { maxPreviousRunDiff: 4096 })).toBeUndefined();
        expect(
            resolveCollaborationConfig({
                collab: { ...collab, access: { ...collab.access, avatarHosts: [...collab.access.avatarHosts] } },
                agent: { run: { maxPreviousRunDiff: 4096 } },
            }),
        ).toEqual({
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
            templates: [],
        });
    });

    test('the quick reactions: one emoji each, kept in the form reactions are (❤ as ❤️)', () => {
        const quickReactions = ['❤', '👨‍👩‍👧‍👦', '👍🏽', '🇯🇵', '1⃣'];
        expect(refusal({ quickReactions })).toBeUndefined();
        expect(resolveCollaborationConfig({ collab: { quickReactions } }).quickReactions).toEqual(['❤️', '👨‍👩‍👧‍👦', '👍🏽', '🇯🇵', '1️⃣']);
    });

    test('the classifier: opt-in, Clef Flash, the token by the name of its variable', () => {
        const classifier = { enabled: true, accountId: '0123456789abcdef0123456789abcdef', model: 'clef', threshold: 0.7 } as const;
        expect(classifierRefusal(classifier)).toBeUndefined();
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
        [{ identity: 'basic' }, "'collab.identity' must be one of 'dev', 'access', 'link'"],
        [{ identity: 'access' }, "'collab.identity' \"access\" needs 'collab.access' with 'teamDomain' and 'audience'"],
        [{ access: [] }, "'collab.access' must be an object"],
        [{ access: { teamDomain: 't' } }, "'collab.access.audience' must be a non-empty string"],
        [{ access: { teamDomain: 't', audience: 'a', publicUrl: 'nope' } }, "'collab.access.publicUrl' must be a URL"],
        [
            { access: { teamDomain: 'https://t.example.com/path', audience: 'a' } },
            "'collab.access.teamDomain' must be a host name like '<team>.cloudflareaccess.com': 'https://t.example.com/path'",
        ],
        [{ access: { teamDomain: 't', audience: 'a', acceptCookie: 'yes' } }, "'collab.access.acceptCookie' must be a boolean"],
        [
            { access: { teamDomain: 't', audience: 'a', avatarHosts: ['https://x.example'] } },
            "'collab.access.avatarHosts' must hold host names only: 'https://x.example'",
        ],
        [{ maxParticipants: 0 }, "'collab.maxParticipants' must be a positive integer"],
        [{ quickReactions: [] }, "'collab.quickReactions' must be an array of 1 to 8 emoji"],
        [{ quickReactions: '👍' }, "'collab.quickReactions' must be an array of 1 to 8 emoji"],
        [{ quickReactions: ['👍', '👍', '👍', '👍', '👍', '👍', '👍', '👍', '👍'] }, "'collab.quickReactions' must be an array of 1 to 8 emoji"],
        [{ quickReactions: ['ok'] }, "'collab.quickReactions' must hold one emoji per entry: 'ok'"],
        [{ quickReactions: ['👍👍'] }, "'collab.quickReactions' must hold one emoji per entry: '👍👍'"],
        [{ quickReactions: ['❤', '❤️'] }, "'collab.quickReactions' must not repeat an emoji: '❤️'"],
        // the first refusal wins: the identity before the participants
        [{ maxParticipants: 0, identity: 'basic' }, "'collab.identity' must be one of 'dev', 'access', 'link'"],
    ])('collab %j is refused', (collab, message) => {
        expect(refusal(collab)).toBe(message);
    });

    test.each([
        [{ maxPreviousRunDiff: -1 }, "'agent.run.maxPreviousRunDiff' must be a non-negative integer (characters of diff)"],
        [{ maxPreviousRunDiff: 1.5 }, "'agent.run.maxPreviousRunDiff' must be a non-negative integer (characters of diff)"],
    ])('agent.run %j is refused', (run, message) => {
        expect(refusal({}, run)).toBe(message);
    });

    test.each([
        [[], "'classifier' must be an object"],
        [{ enabled: true }, "'classifier' enabled needs 'accountId'"],
        [{ provider: 'openai' }, "'classifier.provider' must be one of 'cloudflare-clef'"],
        [{ model: 'jev' }, "'classifier.model' must be one of 'clef-flash', 'clef'"],
        [{ accountId: 'acct' }, "'classifier.accountId' must be a Cloudflare account ID (32 hexadecimal digits)"],
        [{ apiTokenEnv: 'cf-token value' }, "'classifier.apiTokenEnv' must be the name of an environment variable (the token itself never goes in the file)"],
        [{ threshold: 1 }, "'classifier.threshold' must be a number between 0 and 1"],
        [{ token: 'x' }, "unknown key 'classifier.token'"],
        [{ token: 'x', model: 'jev' }, "unknown key 'classifier.token'"],
    ])('classifier %j is refused', (classifier, message) => {
        expect(classifierRefusal(classifier)).toBe(message);
    });
});
