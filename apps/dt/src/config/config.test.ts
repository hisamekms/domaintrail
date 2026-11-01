// domaintrail.jsonc composed from its sections' owners: the file's keys and the schema, the order of the checks (the
// first error wins), the resolved configuration and its errors. Each section's own cases are its owner's: the
// analysis (capabilities/analysis/src/core/sources.test.ts), the generation (capabilities/generation/src/core/
// config.test.ts), Collaboration (contexts/collaboration/src/application/config.test.ts), the agent
// (capabilities/agent/src/adapters/config.test.ts, adapters/dt-shim.test.ts). Finding the file:
// platform/workspace/src/infrastructure/config.test.ts; through the CLI: test/config-cli.test.ts.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
    checkTsContexts,
    CONFIG_FILE_FORMAT,
    CONFIG_KEYS,
    ConfigError,
    defaultConfig,
    parseJsonc,
    resolveConfig,
    type ResolvedConfig,
    type ResolvedSessionConfig,
} from './config.js';

const ROOT = path.resolve('/work/project');
const FILE = path.join(ROOT, 'domaintrail.json');

const refusal = (text: string): unknown => {
    try {
        resolveConfig(text, FILE);
        return undefined;
    } catch (e) {
        return e;
    }
};
const message = (text: string): string => {
    const e = refusal(text);
    expect(e).toBeInstanceOf(ConfigError);
    return e instanceof Error ? e.message : String(e);
};

const SESSION_DEFAULTS: ResolvedSessionConfig = {
    port: 4321,
    host: '127.0.0.1',
    identity: 'dev',
    agent: { port: 0, allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(dt fmt:*)', 'Bash(dt check:*)'], maxPreviousRunDiff: 20480 },
    maxParticipants: 50,
    quickReactions: ['👍', '👀', '🤔', '🎉', '❤️', '🙏'],
    classifier: { enabled: false, provider: 'cloudflare-clef', model: 'clef-flash', apiTokenEnv: 'CLOUDFLARE_API_TOKEN', threshold: 0.5 },
};

describe('config file', () => {
    test('JSONC: comments and trailing commas', () => {
        expect(parseJsonc('{\n // c\n "a": "x // not a comment", /* b */ "b": [1, 2,],\n}')).toEqual({ a: 'x // not a comment', b: [1, 2] });
    });

    test('defaults: every section with its own, rooted at the directory given', () => {
        const defaults: ResolvedConfig = {
            root: ROOT,
            sources: ['**/*.dt', '**/*.dtes'],
            respectGitignore: true,
            lintHint: true,
            tsOut: 'generated/domain',
            tsContexts: {},
            tsPolicies: { project: 'optional', contexts: {} },
            view: { port: 4321, host: '127.0.0.1' },
            session: SESSION_DEFAULTS,
        };
        expect(defaultConfig(ROOT)).toEqual(defaults);
        expect(Object.keys(defaultConfig(ROOT))).toEqual(Object.keys(defaults));
        expect(resolveConfig('{}', FILE)).toEqual({ ...defaults, file: FILE });
        expect(CONFIG_FILE_FORMAT.defaults(ROOT)).toEqual(defaults);
    });

    test('paths are relative to the config file; each section resolved by its owner', () => {
        const text = JSON.stringify({
            $schema: './node_modules/domaintrail/schema/domaintrail.schema.json',
            sources: ['domain/**/*.dt'],
            generate: { ts: { out: 'src/gen', contexts: { C: { out: 'shared/gen' } } } },
            view: { port: 8080 },
            session: {
                port: 5000,
                identity: 'access',
                access: { teamDomain: 'team.cloudflareaccess.com', audience: 'aud', allowedOrigins: ['https://s.example.com'] },
                agent: { port: 9000, allowedTools: ['Read'], dt: ['bun', '../clone/bin/dt.ts'], maxPreviousRunDiff: 4096 },
                maxParticipants: 5,
                quickReactions: ['❤'],
            },
        });
        const c = resolveConfig(text, FILE);
        expect(c).toEqual({
            root: ROOT,
            file: FILE,
            sources: ['domain/**/*.dt'],
            respectGitignore: true,
            lintHint: true,
            tsOut: 'src/gen',
            tsContexts: { C: 'shared/gen' },
            tsPolicies: { project: 'optional', contexts: {} },
            view: { port: 8080, host: '127.0.0.1' },
            session: {
                ...SESSION_DEFAULTS,
                port: 5000,
                identity: 'access',
                access: {
                    teamDomain: 'team.cloudflareaccess.com',
                    audience: 'aud',
                    allowedHosts: [],
                    allowedOrigins: ['https://s.example.com'],
                    acceptCookie: false,
                    avatarHosts: [],
                },
                agent: { port: 9000, allowedTools: ['Read'], dt: ['bun', path.resolve(ROOT, '../clone/bin/dt.ts')], maxPreviousRunDiff: 4096 },
                maxParticipants: 5,
                quickReactions: ['❤️'],
            },
        });
        expect(Object.keys(c.session)).toEqual(['port', 'host', 'identity', 'access', 'agent', 'maxParticipants', 'quickReactions', 'classifier']);
        expect(Object.keys(c.session.agent)).toEqual(['port', 'allowedTools', 'dt', 'maxPreviousRunDiff']);
    });

    test.each([
        ['[]', 'expected an object'],
        ['{ "sources": [ }', 'invalid JSON'],
        ['{ "source": [] }', "unknown key 'source'"],
        ['{ "view": [] }', "'view' must be an object"],
        ['{ "view": { "port": "80" } }', "'view.port' must be a port number"],
        ['{ "view": { "host": 1 } }', "'view.host' must be a string"],
        ['{ "session": 1 }', "'session' must be an object"],
        ['{ "session": { "token": "x" } }', "unknown key 'session.token'"],
        ['{ "session": { "port": 70000 } }', "'session.port' must be a port number"],
        ['{ "session": { "host": "" } }', "'session.host' must be a string"],
        ['{ "session": { "access": [] } }', "'session.access' must be an object"],
        ['{ "session": { "access": { "teamDomain": "t", "audience": "a", "token": "x" } } }', "unknown key 'session.access.token'"],
        [
            '{ "session": { "access": { "teamDomain": "t", "audience": "a", "allowedHosts": ["*.example.com"] } } }',
            "'session.access.allowedHosts' must hold host names only: '*.example.com'",
        ],
        [
            '{ "session": { "access": { "teamDomain": "t", "audience": "a", "allowedHosts": "h" } } }',
            "'session.access.allowedHosts' must be an array of host names",
        ],
        [
            '{ "session": { "access": { "teamDomain": "t", "audience": "a", "allowedOrigins": ["https://x.example/path"] } } }',
            "'session.access.allowedOrigins' must hold origins like 'https://example.com': 'https://x.example/path'",
        ],
        ['{ "session": { "agent": [] } }', "'session.agent' must be an object"],
        ['{ "session": { "agent": { "token": "x" } } }', "unknown key 'session.agent.token'"],
        ['{ "session": { "agent": { "port": 70000 } } }', "'session.agent.port' must be a port number"],
        // each owner's refusal, through the composition
        ['{ "sources": ["!x/**"] }', "'sources' needs at least one include pattern"],
        ['{ "generate": { "rust": {} } }', "unknown generator 'generate.rust' (supported: ts)"],
        ['{ "session": { "identity": "basic" } }', "'session.identity' must be one of 'dev', 'access'"],
        ['{ "session": { "agent": { "allowedTools": [""] } } }', "'session.agent.allowedTools' must be an array of tool rules"],
        ['{ "session": { "agent": { "maxPreviousRunDiff": -1 } } }', "'session.agent.maxPreviousRunDiff' must be a non-negative integer"],
        ['{ "session": { "quickReactions": ["ok"] } }', "'session.quickReactions' must hold one emoji per entry: 'ok'"],
    ])('%s is refused with the file name', (text, expected) => {
        const msg = message(text);
        expect(msg.startsWith(`${FILE}: `)).toBe(true);
        expect(msg).toContain(expected);
    });

    test.each([
        // the top level's unknown keys first, then the sections in the order of the file's documentation
        ['{ "sources": "a", "zzz": 1 }', "unknown key 'zzz'"],
        ['{ "view": { "port": "x" }, "sources": "a" }', "'sources' must be an array of glob strings"],
        ['{ "respectGitignore": "no", "lintHint": "off" }', "'respectGitignore' must be true or false"],
        ['{ "lintHint": "off", "generate": { "rust": {} } }', "'lintHint' must be true or false"],
        ['{ "session": { "port": 1.5 }, "view": { "port": "x" } }', "'view.port' must be a port number"],
        // inside the session: its keys, the app's port and host, the identity, the agent's port, tools, dt and diff, the
        // classifier, the participants, the quick reactions
        ['{ "session": { "identity": "basic", "token": "x" } }', "unknown key 'session.token'"],
        ['{ "session": { "identity": "basic", "host": "" } }', "'session.host' must be a string"],
        ['{ "session": { "agent": { "port": -1 }, "identity": "basic" } }', "'session.identity' must be one of"],
        // in the access settings: Collaboration's and the app's keys in one order
        ['{ "session": { "access": { "allowedHosts": ["*"], "audience": "a" } } }', "'session.access.teamDomain' must be a non-empty string"],
        ['{ "session": { "access": { "teamDomain": "t", "audience": "a", "allowedHosts": ["*"], "publicUrl": "x" } } }', "'session.access.publicUrl'"],
        ['{ "session": { "access": { "teamDomain": "t", "audience": "a", "acceptCookie": 1, "allowedHosts": ["*"] } } }', "'session.access.allowedHosts'"],
        ['{ "session": { "access": { "teamDomain": "t", "audience": "a", "allowedOrigins": ["x"], "acceptCookie": 1 } } }', "'session.access.acceptCookie'"],
        ['{ "session": { "access": { "teamDomain": "t", "audience": "a", "allowedOrigins": ["x"], "avatarHosts": ["*"] } } }', "'session.access.avatarHosts'"],
        [
            '{ "session": { "identity": "access", "access": { "teamDomain": "t", "audience": "a", "allowedOrigins": ["x"] } } }',
            "'session.access.allowedOrigins'",
        ],
        ['{ "session": { "agent": { "allowedTools": 1, "port": -1 } } }', "'session.agent.port' must be a port number"],
        ['{ "session": { "agent": { "maxPreviousRunDiff": -1, "dt": [] } } }', "'session.agent.dt' must be a command"],
        ['{ "session": { "classifier": { "model": "x" }, "agent": { "maxPreviousRunDiff": -1 } } }', "'session.agent.maxPreviousRunDiff'"],
        ['{ "session": { "quickReactions": [], "maxParticipants": 0, "classifier": { "model": "x" } } }', "'session.classifier.model'"],
        ['{ "session": { "quickReactions": [], "maxParticipants": 0 } }', "'session.maxParticipants' must be a positive integer"],
    ])('the first error of %s is %s', (text, expected) => {
        expect(message(text)).toContain(expected);
    });

    test("an agent's dt inside the workspace is refused after the pure checks", () => {
        expect(message(JSON.stringify({ session: { agent: { dt: ['node', './tools/dt.js'] } } }))).toBe(
            `${FILE}: 'session.agent.dt' may not run anything inside the workspace (${path.join(ROOT, 'tools', 'dt.js')}): the agent can write there during a run. Use a dt outside the workspace (e.g. a clone next to it).`,
        );
        expect(message(JSON.stringify({ session: { agent: { dt: ['./tools/dt.js'] }, maxParticipants: 0 } }))).toContain("'session.maxParticipants'");
    });

    test('a context the model does not have, once it is known', () => {
        const c = resolveConfig(
            JSON.stringify({ generate: { ts: { policies: 'required', contexts: { A: { out: 'a' }, X: { policies: 'optional' } } } } }),
            FILE,
        );
        expect(() => checkTsContexts(c, ['A', 'X'])).not.toThrow();
        expect(() => checkTsContexts(c, ['A', 'B'])).toThrow(
            new ConfigError(`${FILE}: 'generate.ts.contexts' names 'X', which is not a context of the model (contexts: A, B).`),
        );
        expect(() => checkTsContexts({ ...defaultConfig(ROOT), tsContexts: { Y: 'y' } }, [])).toThrow("config: 'generate.ts.contexts' names 'Y'");
    });

    test('an explicit file that does not exist', () => {
        expect(CONFIG_FILE_FORMAT.notFound('nope.json')).toEqual(new ConfigError('Config file not found: nope.json'));
        expect(CONFIG_FILE_FORMAT.files).toEqual(['domaintrail.jsonc', 'domaintrail.json']);
    });
});

/** The keys of every object the schema describes, by where they sit (`*`: an object's values). */
function schemaKeys(schema: unknown, where = '', out: Record<string, string[]> = {}): Record<string, string[]> {
    if (typeof schema !== 'object' || schema === null) return out;
    const { properties, additionalProperties } = schema as { properties?: Record<string, unknown>; additionalProperties?: unknown };
    const at = (key: string): string => (where === '' ? key : `${where}.${key}`);
    if (properties) {
        out[where] = Object.keys(properties);
        for (const [key, value] of Object.entries(properties)) schemaKeys(value, at(key), out);
    }
    if (typeof additionalProperties === 'object') schemaKeys(additionalProperties, at('*'), out);
    return out;
}

describe('schema/domaintrail.schema.json', () => {
    test("describes exactly the keys the sections' owners define", () => {
        const schema: unknown = JSON.parse(readFileSync(path.join(import.meta.dir, '../../../../schema/domaintrail.schema.json'), 'utf8'));
        const sorted = (keys: Record<string, readonly string[]>): Record<string, string[]> =>
            Object.fromEntries(
                Object.entries(keys)
                    .map(([where, k]) => [where, [...k].sort()] as const)
                    .sort(([a], [b]) => a.localeCompare(b)),
            );
        expect(sorted(CONFIG_KEYS)).toEqual(sorted(schemaKeys(schema)));
    });
});
