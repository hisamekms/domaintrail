// domaintrail.jsonc composed from its sections' owners: the file's keys and the schema, the order of the checks (the
// first error wins), the resolved configuration and its errors. Each section's own cases are its owner's: the
// analysis (capabilities/analysis/src/core/sources.test.ts), the generation (capabilities/generation/src/core/
// config.test.ts), Collaboration (contexts/collaboration/src/application/config.test.ts), Knowledge
// (contexts/knowledge/src/application/config.test.ts), the agent
// (capabilities/agent/src/adapters/config.test.ts, adapters/dt-shim.test.ts). Finding the file:
// platform/workspace/src/infrastructure/config.test.ts; through the CLI: test/config-cli.test.ts.
import { describe, expect, test } from 'bun:test';
import { Knowledge } from '@domaintrail/knowledge';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
    checkTsContexts,
    CONFIG_FILE_FORMAT,
    CONFIG_KEYS,
    ConfigError,
    defaultConfig,
    localConfigFiles,
    mergeConfig,
    parseJsonc,
    resolveConfig,
    resolveConfigWithLocal,
    type ResolvedAgentSection,
    type ResolvedCollabConfig,
    type ResolvedConfig,
    type ResolvedKnowledgeConfig,
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
    read: { answer: [], run: [] },
};

const CLASSIFIER_DEFAULTS = { enabled: false, provider: 'cloudflare-clef', model: 'clef-flash', apiTokenEnv: 'CLOUDFLARE_API_TOKEN', threshold: 0.9 } as const;

/** A project name known to be one. */
const projectName = (v: string): Knowledge.ProjectName => {
    const made = Knowledge.makeProjectName(v);
    if (!made.ok) throw new Error(`not a project name: ${v}`);
    return made.value;
};
const EXTRACTION_DEFAULTS = { quietSeconds: 30, minIntervalSeconds: 60, contextMinutes: 10, settleSeconds: 120 };
/** The `files` store, its project named after the root's directory (`/work/project`). */
const KNOWLEDGE_DEFAULTS: ResolvedKnowledgeConfig = {
    store: 'files',
    project: projectName('project'),
    projectFrom: 'workspace',
    extraction: EXTRACTION_DEFAULTS,
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
            tsModules: {},
            tsPolicies: { project: 'optional', contexts: {} },
            open: { port: 4321, host: '127.0.0.1' },
            collab: COLLAB_DEFAULTS,
            agent: AGENT_DEFAULTS,
            classifier: CLASSIFIER_DEFAULTS,
            templates: [],
            knowledge: KNOWLEDGE_DEFAULTS,
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
            knowledge: { store: 'cloudflare', project: 'shop', url: 'https://knowledge.example.com/', extraction: { quietSeconds: 10 } },
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
                read: { answer: [], run: [] },
            },
            classifier: { ...CLASSIFIER_DEFAULTS, enabled: true, accountId: '0123456789abcdef0123456789abcdef' },
            templates: [],
            knowledge: {
                store: 'cloudflare',
                project: projectName('shop'),
                projectFrom: 'config',
                url: 'https://knowledge.example.com',
                extraction: { ...EXTRACTION_DEFAULTS, quietSeconds: 10 },
            },
        });
        expect(Object.keys(c.collab)).toEqual(['port', 'host', 'identity', 'access', 'maxParticipants', 'quickReactions']);
        expect(Object.keys(c.agent)).toEqual(['port', 'run', 'answer', 'triage', 'read']);
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
        ['{ "collab": { "identity": "basic" } }', "'collab.identity' must be one of 'dev', 'access', 'link'"],
        ['{ "collab": { "link": [] } }', "'collab.link' must be an object"],
        ['{ "collab": { "link": { "token": "x" } } }', "unknown key 'collab.link.token'"],
        ['{ "collab": { "link": { "publicUrl": "http://dt.example.com" } } }', "'collab.link.publicUrl' must be an https URL without a path"],
        ['{ "collab": { "link": { "publicUrl": "https://dt.example.com/session" } } }', "'collab.link.publicUrl' must be an https URL without a path"],
        ['{ "agent": { "run": { "allowedTools": [""] } } }', "'agent.run.allowedTools' must be an array of tool rules"],
        ['{ "agent": { "run": { "maxPreviousRunDiff": -1 } } }', "'agent.run.maxPreviousRunDiff' must be a non-negative integer"],
        ['{ "agent": { "run": { "warm": "yes" } } }', "'agent.run.warm' must be true or false"],
        ['{ "agent": { "answer": { "timeout": -1 } } }', "'agent.answer.timeout' must be a positive number of seconds"],
        ['{ "agent": { "triage": { "warm": 1 } } }', "'agent.triage.warm' must be true or false"],
        ['{ "collab": { "quickReactions": ["ok"] } }', "'collab.quickReactions' must hold one emoji per entry: 'ok'"],
        ['{ "classifier": { "model": "x" } }', "'classifier.model' must be one of"],
        // the team's message templates (the plan's round 4)
        ['{ "templates": {} }', "'templates' must be an array"],
        ['{ "templates": [{ "id": "a", "name": "A" }] }', "'templates[0].text' must be a string, or an object with 'ja' and/or 'en'"],
        ['{ "templates": [{ "id": "a", "name": "A", "text": "T", "when": ["board"] }] }', "'templates[0].when' must hold"],
        // knowledge (ADR 0031)
        ['{ "knowledge": [] }', "'knowledge' must be an object"],
        ['{ "knowledge": { "token": "x" } }', "unknown key 'knowledge.token'"],
        ['{ "knowledge": { "store": "cloudflare", "project": "shop" } }', "'knowledge.store' \"cloudflare\" needs 'knowledge.url'"],
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

    test('the link identity mode: its public URL resolved to its origin', () => {
        const cfg = resolveConfig('{ "collab": { "identity": "link", "link": { "publicUrl": "https://dt.example.com/" } } }', FILE);
        expect(cfg.collab.identity).toBe('link');
        expect(cfg.collab.link).toEqual({ publicUrl: 'https://dt.example.com' });
        expect(resolveConfig('{}', FILE).collab.link).toBeUndefined();
    });

    test('the team templates: kept as written, after the classifier is checked', () => {
        const templates = [{ id: 'glossary', name: { ja: '用語', en: 'Terms' }, text: '用語集と食い違うところを挙げて', when: ['model'] }];
        expect(resolveConfig(JSON.stringify({ templates }), FILE).templates as unknown).toEqual(templates);
        expect(message('{ "templates": 1, "classifier": [] }')).toContain("'classifier' must be an object");
    });

    test('knowledge: checked last; the project of files named after the root unless named', () => {
        expect(message('{ "knowledge": { "store": "x" }, "templates": 1 }')).toContain("'templates' must be an array");
        expect(resolveConfig('{}', path.join(path.resolve('/work/My Shop'), 'domaintrail.json')).knowledge.project).toBe(projectName('my-shop'));
        expect(resolveConfig('{ "knowledge": { "project": "shop" } }', FILE).knowledge).toEqual({
            ...KNOWLEDGE_DEFAULTS,
            project: projectName('shop'),
            projectFrom: 'config',
        });
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

describe('the local override (domaintrail.local.jsonc)', () => {
    const LOCAL = path.join(ROOT, 'domaintrail.local.jsonc');
    const withLocal = (project: string | undefined, local: string): ResolvedConfig =>
        resolveConfigWithLocal(project === undefined ? undefined : { text: project, file: FILE }, { text: local, file: LOCAL });
    const refused = (project: string | undefined, local: string): string => {
        try {
            withLocal(project, local);
        } catch (e) {
            expect(e).toBeInstanceOf(ConfigError);
            return e instanceof Error ? e.message : String(e);
        }
        throw new Error('not refused');
    };

    test('merged into the project file: objects key by key, arrays and scalars replaced', () => {
        expect(mergeConfig({ a: { b: 1, c: [1, 2] }, d: 'x' }, { a: { c: [3] }, d: null, e: true })).toEqual({ a: { b: 1, c: [3] }, d: null, e: true });
        expect(mergeConfig({ a: { b: 1 } }, { a: [1] })).toEqual({ a: [1] });
        expect(mergeConfig([1, 2], { a: 1 })).toEqual({ a: 1 });
        const c = withLocal(
            '{ "sources": ["domain/**/*.dt"], "agent": { "run": { "model": "sonnet", "allowedTools": ["Read", "Edit"] }, "answer": { "timeout": 60 } } }',
            '// mine\n{ "agent": { "run": { "allowedTools": ["Read"] }, "answer": { "model": "opus" } }, "open": { "port": 4440 }, }',
        );
        expect(c.file).toBe(FILE);
        expect(c.localFile).toBe(LOCAL);
        expect(c.root).toBe(ROOT);
        expect(c.sources).toEqual(['domain/**/*.dt']);
        expect(c.open.port).toBe(4440);
        expect(c.agent.run.allowedTools).toEqual(['Read']);
        expect(c.agent.run.model).toBe('sonnet');
        expect(c.agent.answer).toEqual({ ...AGENT_DEFAULTS.answer, timeout: 60, model: 'opus' });
    });

    test("the knowledge store switched to files for oneself: the project's Worker URL is left unused", () => {
        const c = withLocal(
            '{ "knowledge": { "store": "cloudflare", "project": "shop", "url": "https://k.example.com" } }',
            '{ "knowledge": { "store": "files" } }',
        );
        expect(c.knowledge).toEqual({ ...KNOWLEDGE_DEFAULTS, project: projectName('shop'), projectFrom: 'config' });
    });

    test('a key named __proto__ is a key, never a prototype', () => {
        const merged = mergeConfig({}, JSON.parse('{ "__proto__": { "polluted": true } }'));
        expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
        expect(Object.keys(merged as object)).toEqual(['__proto__']);
        expect(refused('{}', '{ "__proto__": { "x": 1 } }')).toBe(`${LOCAL}: unknown key '__proto__'`);
    });

    test("the project file's errors name it; the merge's name the local file", () => {
        expect(refused('{ "nope": 1 }', '{}')).toBe(`${FILE}: unknown key 'nope'`);
        expect(refused('{ "sources": [', '{}')).toStartWith(`${FILE}: invalid JSON`);
        expect(refused('{}', '{ "agent": { "run": { "nope": 1 } } }')).toBe(`${LOCAL}: unknown key 'agent.run.nope'`);
        expect(refused('{}', '{ "open": { "port": "x" } }')).toStartWith(`${LOCAL}: 'open.port'`);
        expect(refused('{}', '[]')).toBe(`${LOCAL}: expected an object`);
        expect(refused('{}', '{ "session": {} }')).toStartWith(`${LOCAL}: 'session' was renamed`);
        // a setting the merge makes wrong: the local file's
        expect(refused('{ "agent": { "run": { "warm": true } } }', '{ "agent": { "run": 3 } }')).toBe(`${LOCAL}: 'agent.run' must be an object`);
        // the check that reads the disk, on the merge too
        expect(refused('{}', '{ "agent": { "run": { "dt": ["node", "tools/dt.js"] } } }')).toStartWith(
            `${LOCAL}: 'agent.run.dt' may not run anything inside the workspace`,
        );
    });

    test('alone (no project file): it is the configuration, rooted at its directory', () => {
        const c = withLocal(undefined, '{ "sources": ["m/*.dt"] }');
        expect(c.file).toBeUndefined();
        expect(c.localFile).toBe(LOCAL);
        expect(c.root).toBe(ROOT);
        expect(c.sources).toEqual(['m/*.dt']);
        expect(refused(undefined, '{ "x": 1 }')).toBe(`${LOCAL}: unknown key 'x'`);
    });

    test('its names: domaintrail.local.jsonc then .local.json beside the default names; <name>.local.<ext> beside another (-c)', () => {
        expect(localConfigFiles(FILE)).toEqual([path.join(ROOT, 'domaintrail.local.jsonc'), path.join(ROOT, 'domaintrail.local.json')]);
        expect(localConfigFiles(path.join(ROOT, 'domaintrail.jsonc'))).toEqual([LOCAL, path.join(ROOT, 'domaintrail.local.json')]);
        expect(localConfigFiles(path.join(ROOT, 'conf', 'team.jsonc'))).toEqual([path.join(ROOT, 'conf', 'team.local.jsonc')]);
        expect(localConfigFiles(path.join(ROOT, 'team'))).toEqual([path.join(ROOT, 'team.local')]);
        expect(CONFIG_FILE_FORMAT.localFiles).toBe(localConfigFiles);
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
