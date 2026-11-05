// Knowledge's settings in domaintrail.jsonc (`knowledge`) and the store's credentials from the environment (composed
// with the other sections and read from a file: apps/dt/src/config/config.test.ts).
import { describe, expect, test } from 'bun:test';
import { Knowledge } from '../generated/index.js';
import {
    DEFAULT_EXTRACTION,
    isStoreUrl,
    KNOWLEDGE_CLIENT_ID_ENV,
    KNOWLEDGE_CLIENT_SECRET_ENV,
    knowledgeCredentials,
    missingCredentialsMessage,
    projectFromDirName,
    resolveKnowledgeConfig,
    validateKnowledgeConfig,
} from './config.js';

/** A project name known to be one. */
const projectName = (v: string): Knowledge.ProjectName => {
    const made = Knowledge.makeProjectName(v);
    if (!made.ok) throw new Error(`not a project name: ${v}`);
    return made.value;
};

/** The first refusal of `knowledge`'s checks, if any. */
const refusal = (knowledge: unknown): string | undefined => {
    try {
        validateKnowledgeConfig(knowledge, (msg) => {
            throw new Error(msg);
        });
        return undefined;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
};

describe('the knowledge section', () => {
    test('absent, it is the files store, its project named after the workspace, the extraction at its defaults', () => {
        expect(refusal(undefined)).toBeUndefined();
        expect(resolveKnowledgeConfig(undefined, 'shop')).toEqual({
            store: 'files',
            project: projectName('shop'),
            projectFrom: 'workspace',
            extraction: DEFAULT_EXTRACTION,
        });
        expect(DEFAULT_EXTRACTION).toEqual({
            enabled: false,
            quietSeconds: 30,
            minIntervalSeconds: 60,
            contextMinutes: 10,
            gateContextMinutes: 3,
            settleSeconds: 120,
        });
    });

    test('files with a project named, and every number of the extraction set', () => {
        const extraction = { enabled: true, quietSeconds: 5, minIntervalSeconds: 0, contextMinutes: 2.5, gateContextMinutes: 1, settleSeconds: 30 };
        const knowledge = { project: 'dmcore', extraction };
        expect(refusal(knowledge)).toBeUndefined();
        expect(resolveKnowledgeConfig(knowledge, 'elsewhere')).toEqual({
            store: 'files',
            project: projectName('dmcore'),
            projectFrom: 'config',
            extraction,
        });
        expect(resolveKnowledgeConfig({ extraction: { settleSeconds: 60 } }, 'shop').extraction).toEqual({ ...DEFAULT_EXTRACTION, settleSeconds: 60 });
    });

    test('cloudflare: its project and URL, the URL without a trailing slash; a URL with files is left unused', () => {
        const knowledge = { store: 'cloudflare', project: 'dmcore', url: 'https://knowledge.example.com/' } as const;
        expect(refusal(knowledge)).toBeUndefined();
        expect(resolveKnowledgeConfig(knowledge, 'shop')).toEqual({
            store: 'cloudflare',
            project: projectName('dmcore'),
            projectFrom: 'config',
            url: 'https://knowledge.example.com',
            extraction: DEFAULT_EXTRACTION,
        });
        expect(resolveKnowledgeConfig({ store: 'files', url: 'https://knowledge.example.com' }, 'shop')).not.toHaveProperty('url');
    });

    test.each([
        [[], "'knowledge' must be an object"],
        [{ token: 'x' }, "unknown key 'knowledge.token'"],
        [{ clientSecret: 'x' }, "unknown key 'knowledge.clientSecret'"],
        [{ store: 'd1' }, "'knowledge.store' must be one of 'files', 'cloudflare'"],
        [{ project: 'Shop' }, "'knowledge.project' must be a project name"],
        [{ project: '-shop' }, "'knowledge.project' must be a project name"],
        [{ project: 'a'.repeat(64) }, "'knowledge.project' must be a project name"],
        [{ project: 1 }, "'knowledge.project' must be a project name"],
        [{ url: 'http://knowledge.example.com' }, "'knowledge.url' must be the Worker's https URL"],
        [{ url: 'https://user:pw@knowledge.example.com' }, "'knowledge.url' must be the Worker's https URL"],
        [{ url: 'https://knowledge.example.com/?project=x' }, "'knowledge.url' must be the Worker's https URL"],
        [{ url: 'knowledge.example.com' }, "'knowledge.url' must be the Worker's https URL"],
        [{ extraction: 30 }, "'knowledge.extraction' must be an object"],
        [{ extraction: { quiet: 30 } }, "unknown key 'knowledge.extraction.quiet'"],
        [{ extraction: { quietSeconds: -1 } }, "'knowledge.extraction.quietSeconds' must be a non-negative number (seconds)"],
        [{ extraction: { contextMinutes: '10' } }, "'knowledge.extraction.contextMinutes' must be a non-negative number (minutes)"],
        [{ extraction: { gateContextMinutes: -1 } }, "'knowledge.extraction.gateContextMinutes' must be a non-negative number (minutes)"],
        [{ extraction: { enabled: 'yes' } }, "'knowledge.extraction.enabled' must be true or false"],
        [{ store: 'cloudflare', url: 'https://k.example.com' }, "'knowledge.store' \"cloudflare\" needs 'knowledge.project'"],
        [{ store: 'cloudflare', project: 'shop' }, "'knowledge.store' \"cloudflare\" needs 'knowledge.url'"],
        // the first error wins: the keys, the store, the project, the URL, the extraction, what cloudflare needs
        [{ store: 'cloudflare', zzz: 1 }, "unknown key 'knowledge.zzz'"],
        [{ store: 'x', project: 'X' }, "'knowledge.store' must be one of"],
        [{ store: 'cloudflare', project: 'X', url: 'x' }, "'knowledge.project' must be a project name"],
        [{ store: 'cloudflare', url: 'x', extraction: [] }, "'knowledge.url' must be"],
        [{ store: 'cloudflare', extraction: { settleSeconds: -1 } }, "'knowledge.extraction.settleSeconds'"],
    ])('%j is refused: %s', (knowledge, expected) => {
        expect(refusal(knowledge)).toStartWith(expected);
    });

    test('the URL of the Worker: https, or http on a loopback host (wrangler dev)', () => {
        expect(isStoreUrl('https://knowledge.example.com')).toBe(true);
        expect(isStoreUrl('https://example.com/knowledge')).toBe(true);
        expect(isStoreUrl('http://localhost:8787')).toBe(true);
        expect(isStoreUrl('http://127.0.0.1:8787/')).toBe(true);
        expect(isStoreUrl('http://[::1]:8787')).toBe(true);
        expect(isStoreUrl('http://localhost.example.com')).toBe(false);
        expect(isStoreUrl('https://knowledge.example.com/#x')).toBe(false);
        expect(isStoreUrl('ftp://knowledge.example.com')).toBe(false);
    });

    test.each([
        ['shop', 'shop'],
        ['dmcore-prototype', 'dmcore-prototype'],
        ['My Shop', 'my-shop'],
        ['knowledge_k3', 'knowledge-k3'],
        ['.hidden', 'hidden'],
        ['--x--', 'x'],
        ['日本語', 'workspace'],
        ['', 'workspace'],
        ['a'.repeat(62) + '-b', 'a'.repeat(62)],
        ['b'.repeat(70), 'b'.repeat(63)],
    ])('the project named after the directory %j is %j', (dir, project) => {
        expect(projectFromDirName(dir)).toBe(projectName(project));
        expect(refusal({ project })).toBeUndefined();
    });
});

describe("the cloudflare store's credentials", () => {
    test('both variables set: the service token, trimmed', () => {
        const env = { [KNOWLEDGE_CLIENT_ID_ENV]: 'id.access ', [KNOWLEDGE_CLIENT_SECRET_ENV]: 'secret' };
        expect(knowledgeCredentials(env)).toEqual({ ok: true, value: { clientId: 'id.access', clientSecret: 'secret' } });
    });

    test('missing or empty: the variables to set, named', () => {
        const none = knowledgeCredentials({});
        expect(none).toEqual({ ok: false, error: { type: 'MissingKnowledgeCredentials', missing: [KNOWLEDGE_CLIENT_ID_ENV, KNOWLEDGE_CLIENT_SECRET_ENV] } });
        const half = knowledgeCredentials({ [KNOWLEDGE_CLIENT_ID_ENV]: 'id', [KNOWLEDGE_CLIENT_SECRET_ENV]: '  ' });
        expect(half.ok ? undefined : missingCredentialsMessage(half.error)).toBe(
            "the knowledge store 'cloudflare' needs an Access service token: set DOMAINTRAIL_KNOWLEDGE_CLIENT_SECRET",
        );
    });
});
