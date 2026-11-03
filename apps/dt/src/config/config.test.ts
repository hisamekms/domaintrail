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
    type ResolvedAgentSection,
    type ResolvedCollabConfig,
    type ResolvedConfig,
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

const COLLAB_DEFAULTS: ResolvedCollabConfig = {
    port: 4321,
    host: '127.0.0.1',
    identity: 'dev',
    maxParticipants: 50,
    quickReactions: ['👍', '👀', '🤔', '🎉', '❤️', '🙏'],
};

const AGENT_DEFAULTS: ResolvedAgentSection = {
    port: 0,
    run: {
        allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(dt fmt:*)', 'Bash(dt check:*)', 'Bash(dt guide:*)'],
        warm: true,
        restartAfter: 20,
        idleTimeout: 30,
        maxPreviousRunDiff: 20480,
    },
    answer: { warm: true, restartAfter: 50, idleTimeout: 30, timeout: 120 },
    triage: { model: 'haiku', warm: false },
};

const CLASSIFIER_DEFAULTS = { enabled: false, provider: 'cloudflare-clef', model: 'clef-flash', apiTokenEnv: 'CLOUDFLARE_API_TOKEN', threshold: 0.9 } as const;

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
            tsModules: {},
            tsPolicies: { project: 'optional', contexts: {} },
            open: { port: 4321, host: '127.0.0.1' },
            collab: COLLAB_DEFAULTS,
            agent: AGENT_DEFAULTS,
            classifier: CLASSIFIER_DEFAULTS,
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
            open: { port: 8080 },
            collab: {
                port: 5000,
                identity: 'access',
                access: { teamDomain: 'team.cloudflareaccess.com', audience: 'aud', allowedOrigins: ['https://s.example.com'] },
                maxParticipants: 5,
                quickReactions: ['❤'],
            },
            agent: {
                port: 9000,
                run: { allowedTools: ['Read'], dt: ['bun', '../clone/bin/dt.ts'], warm: false, model: 'sonnet', effort: 'low', maxPreviousRunDiff: 4096 },
                answer: { model: 'haiku', timeout: 60 },
                triage: { model: 'sonnet', warm: true },
            },
            classifier: { enabled: true, accountId: '0123456789abcdef0123456789abcdef' },
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
            tsModules: {},
            tsPolicies: { project: 'optional', contexts: {} },
            open: { port: 8080, host: '127.0.0.1' },
            collab: {
                ...COLLAB_DEFAULTS,
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
                maxParticipants: 5,
                quickReactions: ['❤️'],
            },
            agent: {
                port: 9000,
                run: {
                    allowedTools: ['Read'],
                    dt: ['bun', path.resolve(ROOT, '../clone/bin/dt.ts')],
                    warm: false,
                    restartAfter: 20,
                    idleTimeout: 30,
                    model: 'sonnet',
                    effort: 'low',
                    maxPreviousRunDiff: 4096,
                },
                answer: { warm: true, restartAfter: 50, idleTimeout: 30, timeout: 60, model: 'haiku' },
                triage: { model: 'sonnet', warm: true },
            },
            classifier: { ...CLASSIFIER_DEFAULTS, enabled: true, accountId: '0123456789abcdef0123456789abcdef' },
        });
        expect(Object.keys(c.collab)).toEqual(['port', 'host', 'identity', 'access', 'maxParticipants', 'quickReactions']);
        expect(Object.keys(c.agent)).toEqual(['port', 'run', 'answer', 'triage']);
    });

    test.each([
        // the old sections: each key's new place
        [
            '{ "session": { "port": 5000, "identity": "dev", "agent": { "port": 9000, "allowedTools": ["Read"], "run": { "warm": false } }, "classifier": {} } }',
            "'session' was renamed: move session.port, session.identity to collab; session.agent.port to agent.port; session.agent.allowedTools to agent.run.allowedTools; session.agent.run.* to agent.run; session.classifier to classifier",
        ],
        [
            '{ "session": {} }',
            "'session' was renamed: move session.agent.port to agent.port, the other session.agent.* to agent.run, session.classifier to classifier, the rest to collab",
        ],
        [
            '{ "session": { "agent": { "dt": ["../dt"], "maxPreviousRunDiff": 1 } } }',
            "'session' was renamed: move session.agent.dt to agent.run.dt; session.agent.maxPreviousRunDiff to agent.run.maxPreviousRunDiff",
        ],
        ['{ "view": { "port": 8080, "host": "127.0.0.1" } }', "'view' was renamed to 'open': move view.port to open.port, view.host to open.host"],
        ['{ "view": 1 }', "'view' was renamed to 'open'"],
        // a key of the old section put in a new one
        ['{ "collab": { "agent": { "port": 1 } } }', "unknown key 'collab.agent': the agent's settings are in the top-level 'agent' (agent.port, agent.run)"],
        ['{ "collab": { "classifier": {} } }', "unknown key 'collab.classifier': the classifier is the top-level 'classifier'"],
        ['{ "agent": { "allowedTools": ["Read"] } }', "unknown key 'agent.allowedTools': it is a setting of the runner, 'agent.run.allowedTools'"],
        ['{ "agent": { "model": "sonnet" } }', "unknown key 'agent.model': it is a setting of the runner, 'agent.run.model'"],
    ])('%s is refused with where its keys went', (text, expected) => {
        expect(message(text)).toBe(`${FILE}: ${expected}`);
    });

    test.each([
        ['[]', 'expected an object'],
        ['{ "sources": [ }', 'invalid JSON'],
        ['{ "source": [] }', "unknown key 'source'"],
        ['{ "open": [] }', "'open' must be an object"],
        ['{ "open": { "port": "80" } }', "'open.port' must be a port number"],
        ['{ "open": { "host": 1 } }', "'open.host' must be a string"],
        ['{ "open": { "identity": "dev" } }', "unknown key 'open.identity'"],
        ['{ "collab": 1 }', "'collab' must be an object"],
        ['{ "collab": { "token": "x" } }', "unknown key 'collab.token'"],
        ['{ "collab": { "port": 70000 } }', "'collab.port' must be a port number"],
        ['{ "collab": { "host": "" } }', "'collab.host' must be a string"],
        ['{ "collab": { "access": [] } }', "'collab.access' must be an object"],
        ['{ "collab": { "access": { "teamDomain": "t", "audience": "a", "token": "x" } } }', "unknown key 'collab.access.token'"],
        [
            '{ "collab": { "access": { "teamDomain": "t", "audience": "a", "allowedHosts": ["*.example.com"] } } }',
            "'collab.access.allowedHosts' must hold host names only: '*.example.com'",
        ],
        [
            '{ "collab": { "access": { "teamDomain": "t", "audience": "a", "allowedHosts": "h" } } }',
            "'collab.access.allowedHosts' must be an array of host names",
        ],
        [
            '{ "collab": { "access": { "teamDomain": "t", "audience": "a", "allowedOrigins": ["https://x.example/path"] } } }',
            "'collab.access.allowedOrigins' must hold origins like 'https://example.com': 'https://x.example/path'",
        ],
        ['{ "agent": [] }', "'agent' must be an object"],
        ['{ "agent": { "token": "x" } }', "unknown key 'agent.token'"],
        ['{ "agent": { "port": 70000 } }', "'agent.port' must be a port number"],
        ['{ "agent": { "run": [] } }', "'agent.run' must be an object"],
        ['{ "agent": { "run": { "hot": true } } }', "unknown key 'agent.run.hot'"],
        ['{ "agent": { "answer": { "allowedTools": ["Edit"] } } }', "unknown key 'agent.answer.allowedTools'"],
        ['{ "agent": { "triage": { "effort": "low" } } }', "unknown key 'agent.triage.effort'"],
        ['{ "classifier": [] }', "'classifier' must be an object"],
        // each owner's refusal, through the composition
        ['{ "sources": ["!x/**"] }', "'sources' needs at least one include pattern"],
        ['{ "generate": { "rust": {} } }', "unknown generator 'generate.rust' (supported: ts)"],
        ['{ "collab": { "identity": "basic" } }', "'collab.identity' must be one of 'dev', 'access'"],
        ['{ "agent": { "run": { "allowedTools": [""] } } }', "'agent.run.allowedTools' must be an array of tool rules"],
        ['{ "agent": { "run": { "maxPreviousRunDiff": -1 } } }', "'agent.run.maxPreviousRunDiff' must be a non-negative integer"],
        ['{ "agent": { "run": { "warm": "yes" } } }', "'agent.run.warm' must be true or false"],
        ['{ "agent": { "answer": { "timeout": -1 } } }', "'agent.answer.timeout' must be a positive number of seconds"],
        ['{ "agent": { "triage": { "warm": 1 } } }', "'agent.triage.warm' must be true or false"],
        ['{ "collab": { "quickReactions": ["ok"] } }', "'collab.quickReactions' must hold one emoji per entry: 'ok'"],
        ['{ "classifier": { "model": "x" } }', "'classifier.model' must be one of"],
    ])('%s is refused with the file name', (text, expected) => {
        const msg = message(text);
        expect(msg.startsWith(`${FILE}: `)).toBe(true);
        expect(msg).toContain(expected);
    });

    test.each([
        // the top level's unknown keys first, then the sections in the order of the file's documentation
        ['{ "sources": "a", "zzz": 1 }', "unknown key 'zzz'"],
        ['{ "open": { "port": "x" }, "sources": "a" }', "'sources' must be an array of glob strings"],
        ['{ "respectGitignore": "no", "lintHint": "off" }', "'respectGitignore' must be true or false"],
        ['{ "lintHint": "off", "generate": { "rust": {} } }', "'lintHint' must be true or false"],
        ['{ "collab": { "port": 1.5 }, "open": { "port": "x" } }', "'open.port' must be a port number"],
        ['{ "sources": ["a"], "view": {}, "session": {} }', "'view' was renamed to 'open'"],
        // the sections in order: open, collab, agent, classifier
        ['{ "classifier": { "model": "x" }, "agent": { "port": -1 }, "collab": { "port": -1 } }', "'collab.port' must be a port number"],
        ['{ "classifier": { "model": "x" }, "agent": { "port": -1 } }', "'agent.port' must be a port number"],
        // inside collab: its keys, the app's port and host, the identity, the access settings, the participants, the
        // quick reactions
        ['{ "collab": { "identity": "basic", "token": "x" } }', "unknown key 'collab.token'"],
        ['{ "collab": { "identity": "basic", "host": "" } }', "'collab.host' must be a string"],
        // in the access settings: Collaboration's and the app's keys in one order
        ['{ "collab": { "access": { "allowedHosts": ["*"], "audience": "a" } } }', "'collab.access.teamDomain' must be a non-empty string"],
        ['{ "collab": { "access": { "teamDomain": "t", "audience": "a", "allowedHosts": ["*"], "publicUrl": "x" } } }', "'collab.access.publicUrl'"],
        ['{ "collab": { "access": { "teamDomain": "t", "audience": "a", "acceptCookie": 1, "allowedHosts": ["*"] } } }', "'collab.access.allowedHosts'"],
        ['{ "collab": { "access": { "teamDomain": "t", "audience": "a", "allowedOrigins": ["x"], "acceptCookie": 1 } } }', "'collab.access.acceptCookie'"],
        ['{ "collab": { "access": { "teamDomain": "t", "audience": "a", "allowedOrigins": ["x"], "avatarHosts": ["*"] } } }', "'collab.access.avatarHosts'"],
        ['{ "collab": { "identity": "access", "access": { "teamDomain": "t", "audience": "a", "allowedOrigins": ["x"] } } }', "'collab.access.allowedOrigins'"],
        ['{ "collab": { "quickReactions": [], "maxParticipants": 0 } }', "'collab.maxParticipants' must be a positive integer"],
        // inside agent: its keys, the port, the roles' keys, the runner, the answerer, the triage, the previous-run diff
        ['{ "agent": { "run": { "allowedTools": 1 }, "port": -1 } }', "'agent.port' must be a port number"],
        ['{ "agent": { "run": { "maxPreviousRunDiff": -1, "dt": [] } } }', "'agent.run.dt' must be a command"],
        ['{ "agent": { "run": { "maxPreviousRunDiff": -1 }, "answer": { "warm": 1 } } }', "'agent.answer.warm'"],
        ['{ "agent": { "run": { "maxPreviousRunDiff": -1 } } }', "'agent.run.maxPreviousRunDiff'"],
    ])('the first error of %s is %s', (text, expected) => {
        expect(message(text)).toContain(expected);
    });

    test("an agent's dt inside the workspace is refused after the pure checks", () => {
        expect(message(JSON.stringify({ agent: { run: { dt: ['node', './tools/dt.js'] } } }))).toBe(
            `${FILE}: 'agent.run.dt' may not run anything inside the workspace (${path.join(ROOT, 'tools', 'dt.js')}): the agent can write there during a run. Use a dt outside the workspace (e.g. a clone next to it).`,
        );
        expect(message(JSON.stringify({ agent: { run: { dt: ['./tools/dt.js'] } }, collab: { maxParticipants: 0 } }))).toContain("'collab.maxParticipants'");
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
