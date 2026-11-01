import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { checkTsContexts, ConfigError, policyModes } from '@domaintrail/modeling';
import { findConfigFile, loadConfig } from './config.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-cfg-'));
    dirs.push(dir);
    for (const [p, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(dir, p)), { recursive: true });
        await writeFile(path.join(dir, p), text);
    }
    return dir;
}

describe('config file', () => {
    test('is found in the start directory or a parent; domaintrail.jsonc wins over domaintrail.json', async () => {
        const dir = await project({ 'domaintrail.json': '{}', 'domaintrail.jsonc': '{}', 'a/b/x.txt': '' });
        expect(findConfigFile(path.join(dir, 'a', 'b'))).toBe(path.join(dir, 'domaintrail.jsonc'));
    });

    test('paths are relative to the config file; defaults apply', async () => {
        const dir = await project({ 'domaintrail.json': '{ "generate": { "ts": { "out": "src/gen" } } }', 'sub/x.txt': '' });
        const c = await loadConfig({ start: path.join(dir, 'sub') });
        expect(c).toMatchObject({
            root: dir,
            file: path.join(dir, 'domaintrail.json'),
            sources: ['**/*.dt', '**/*.dtes'],
            tsOut: 'src/gen',
            tsContexts: {},
            view: { port: 4321, host: '127.0.0.1' },
        });
    });

    test('generate.ts.contexts maps context names to output directories', async () => {
        const dir = await project({ 'domaintrail.json': '{ "generate": { "ts": { "contexts": { "C": { "out": "shared/gen" } } } } }' });
        expect(await loadConfig({ start: dir })).toMatchObject({ tsOut: 'generated/domain', tsContexts: { C: 'shared/gen' } });
    });

    test('policies: the mode of a context, else that of the project, else optional', async () => {
        const dir = await project({
            'domaintrail.json': '{ "generate": { "ts": { "policies": "required", "contexts": { "A": { "policies": "optional" }, "B": { "out": "b" } } } } }',
        });
        const c = await loadConfig({ start: dir });
        expect(c).toMatchObject({ tsContexts: { B: 'b' }, tsPolicies: { project: 'required', contexts: { A: 'optional' } } });
        expect(policyModes(c, ['A', 'B', 'C'])).toEqual({ A: 'optional', B: 'required', C: 'required' });
        expect(policyModes(await loadConfig({ start: await project({}) }), ['A'])).toEqual({ A: 'optional' });
        expect(() => checkTsContexts({ ...c, tsPolicies: { project: 'optional', contexts: { X: 'required' } } }, ['A', 'B'])).toThrow(
            "'generate.ts.contexts' names 'X'",
        );
    });

    test.each([
        ['{ "source": [] }', "unknown key 'source'"],
        ['{ "sources": "a" }', "'sources' must be an array of glob strings"],
        ['{ "respectGitignore": "no" }', "'respectGitignore' must be true or false"],
        ['{ "lintHint": "off" }', "'lintHint' must be true or false"],
        ['{ "sources": ["!x/**"] }', "'sources' needs at least one include pattern"],
        ['{ "generate": { "rust": {} } }', "unknown generator 'generate.rust' (supported: ts)"],
        ['{ "view": { "port": "80" } }', "'view.port' must be a port number"],
        ['{ "sources": [ }', 'invalid JSON'],
        ['{ "generate": { "ts": { "out": "../elsewhere" } } }', "'generate.ts.out' must stay inside the directory of the config file"],
        ['{ "generate": { "ts": { "out": "/tmp/x" } } }', "'generate.ts.out' must stay inside the directory of the config file"],
        ['{ "generate": { "ts": { "outDir": "x" } } }', "unknown key 'generate.ts.outDir'"],
        ['{ "generate": { "ts": { "contexts": [] } } }', "'generate.ts.contexts' must be an object keyed by context name"],
        ['{ "generate": { "ts": { "contexts": { "C": "x" } } } }', "'generate.ts.contexts.C' must be an object"],
        ['{ "generate": { "ts": { "contexts": { "C": {} } } } }', "'generate.ts.contexts.C' needs 'out' or 'policies'"],
        ['{ "generate": { "ts": { "policies": "always" } } }', "'generate.ts.policies' must be one of 'optional', 'required'"],
        ['{ "generate": { "ts": { "contexts": { "C": { "policies": true } } } } }', "'generate.ts.contexts.C.policies' must be one of 'optional', 'required'"],
        [
            '{ "generate": { "ts": { "contexts": { "C": { "out": "../x" } } } } }',
            "'generate.ts.contexts.C.out' must stay inside the directory of the config file",
        ],
        ['{ "generate": { "ts": { "tests": true } } }', "'generate.ts.tests' must be an object"],
        ['{ "generate": { "ts": { "tests": { "runner": "mocha" } } } }', "'generate.ts.tests.runner' must be one of 'bun', 'vitest', 'jest', 'node'"],
        ['{ "generate": { "ts": { "tests": { "out": "../t" } } } }', "'generate.ts.tests.out' must stay inside the directory of the config file"],
        ['{ "generate": { "ts": { "tests": { "dir": "t" } } } }', "unknown key 'generate.ts.tests.dir'"],
    ])('invalid config %s', async (text, message) => {
        const dir = await project({ 'domaintrail.json': text });
        const e = await loadConfig({ start: dir }).catch((x) => x);
        expect(e).toBeInstanceOf(ConfigError);
        expect(e.message).toContain(message);
    });
});

describe('session section (ADR 0026)', () => {
    test('defaults: dev identity on loopback, the default agent tools, 50 participants', async () => {
        const c = await loadConfig({ start: await project({ 'domaintrail.json': '{}' }) });
        expect(c.session).toEqual({
            port: 4321,
            host: '127.0.0.1',
            identity: 'dev',
            agent: { port: 0, allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(dt fmt:*)', 'Bash(dt check:*)'], maxPreviousRunDiff: 20480 },
            maxParticipants: 50,
            quickReactions: ['👍', '👀', '🤔', '🎉', '❤️', '🙏'],
            classifier: { enabled: false, provider: 'cloudflare-clef', model: 'clef-flash', apiTokenEnv: 'CLOUDFLARE_API_TOKEN', threshold: 0.5 },
        });
    });

    test('access: the team, the audience and the explicit hosts and origins', async () => {
        const text = JSON.stringify({
            session: {
                identity: 'access',
                access: {
                    teamDomain: 'team.cloudflareaccess.com',
                    audience: 'aud',
                    publicUrl: 'https://s.example.com',
                    allowedHosts: ['s.example.com'],
                    allowedOrigins: ['https://s.example.com'],
                },
                agent: { port: 9000, allowedTools: ['Read'], maxPreviousRunDiff: 4096 },
                maxParticipants: 5,
            },
        });
        const c = await loadConfig({ start: await project({ 'domaintrail.json': text }) });
        expect(c.session).toEqual({
            port: 4321,
            host: '127.0.0.1',
            identity: 'access',
            access: {
                teamDomain: 'team.cloudflareaccess.com',
                audience: 'aud',
                publicUrl: 'https://s.example.com',
                allowedHosts: ['s.example.com'],
                allowedOrigins: ['https://s.example.com'],
                acceptCookie: false,
                avatarHosts: [],
            },
            agent: { port: 9000, allowedTools: ['Read'], maxPreviousRunDiff: 4096 },
            maxParticipants: 5,
            quickReactions: ['👍', '👀', '🤔', '🎉', '❤️', '🙏'],
            classifier: { enabled: false, provider: 'cloudflare-clef', model: 'clef-flash', apiTokenEnv: 'CLOUDFLARE_API_TOKEN', threshold: 0.5 },
        });
    });

    test("the agent's dt: a runtime and a script relative to the config file, or one executable", async () => {
        const dir = await project({ 'domaintrail.json': JSON.stringify({ session: { agent: { dt: ['bun', '../clone/bin/dt.ts'] } } }) });
        expect((await loadConfig({ start: dir })).session.agent.dt).toEqual(['bun', path.resolve(dir, '../clone/bin/dt.ts')]);
        const exe = await project({ 'domaintrail.json': JSON.stringify({ session: { agent: { dt: ['../bin/dt'] } } }) });
        expect((await loadConfig({ start: exe })).session.agent.dt).toEqual([path.resolve(exe, '../bin/dt')]);
    });

    test('the quick reactions: one emoji each, kept in the form reactions are (❤ as ❤️)', async () => {
        const text = JSON.stringify({ session: { quickReactions: ['❤', '👨‍👩‍👧‍👦', '👍🏽', '🇯🇵', '1⃣'] } });
        const c = await loadConfig({ start: await project({ 'domaintrail.json': text }) });
        expect(c.session.quickReactions).toEqual(['❤️', '👨‍👩‍👧‍👦', '👍🏽', '🇯🇵', '1️⃣']);
    });

    test('the classifier: opt-in, Clef Flash, the token by the name of its variable', async () => {
        const text = JSON.stringify({
            session: { classifier: { enabled: true, accountId: '0123456789abcdef0123456789abcdef', model: 'clef', threshold: 0.7 } },
        });
        const c = await loadConfig({ start: await project({ 'domaintrail.json': text }) });
        expect(c.session.classifier).toEqual({
            enabled: true,
            provider: 'cloudflare-clef',
            model: 'clef',
            accountId: '0123456789abcdef0123456789abcdef',
            apiTokenEnv: 'CLOUDFLARE_API_TOKEN',
            threshold: 0.7,
        });
    });

    test.each([
        [{ identity: 'basic' }, "'session.identity' must be one of"],
        [{ identity: 'access' }, "needs 'session.access'"],
        [{ access: { teamDomain: 't' } }, "'session.access.audience'"],
        [{ access: { teamDomain: 't', audience: 'a', allowedOrigins: ['https://x.example/path'] } }, "'session.access.allowedOrigins'"],
        [{ access: { teamDomain: 't', audience: 'a', allowedHosts: ['*.example.com'] } }, "'session.access.allowedHosts'"],
        [{ access: { teamDomain: 'https://t.example.com/path', audience: 'a' } }, "'session.access.teamDomain' must be a host name"],
        [{ access: { teamDomain: 't', audience: 'a', acceptCookie: 'yes' } }, "'session.access.acceptCookie'"],
        [{ access: { teamDomain: 't', audience: 'a', avatarHosts: ['https://x.example'] } }, "'session.access.avatarHosts'"],
        [{ agent: { allowedTools: [''] } }, "'session.agent.allowedTools'"],
        [{ agent: { port: 70000 } }, "'session.agent.port'"],
        [{ agent: { maxPreviousRunDiff: -1 } }, "'session.agent.maxPreviousRunDiff'"],
        [{ agent: { maxPreviousRunDiff: 1.5 } }, "'session.agent.maxPreviousRunDiff'"],
        [{ maxParticipants: 0 }, "'session.maxParticipants'"],
        [{ quickReactions: [] }, "'session.quickReactions' must be an array of 1 to 8 emoji"],
        [{ quickReactions: '👍' }, "'session.quickReactions' must be an array"],
        [{ quickReactions: ['👍', '👍', '👍', '👍', '👍', '👍', '👍', '👍', '👍'] }, "'session.quickReactions' must be an array of 1 to 8 emoji"],
        [{ quickReactions: ['ok'] }, "'session.quickReactions' must hold one emoji per entry: 'ok'"],
        [{ quickReactions: ['👍👍'] }, "'session.quickReactions' must hold one emoji per entry"],
        [{ quickReactions: ['❤', '❤️'] }, "'session.quickReactions' must not repeat an emoji"],
        [{ token: 'x' }, "unknown key 'session.token'"],
        [{ agent: { dt: [] } }, "'session.agent.dt' must be a command"],
        [{ agent: { dt: ['node', ''] } }, "'session.agent.dt' must be a command"],
        [{ agent: { dt: 'node dist/dt.js' } }, "'session.agent.dt' must be a command"],
        [{ classifier: { enabled: true } }, "needs 'accountId'"],
        [{ classifier: { provider: 'openai' } }, "'session.classifier.provider'"],
        [{ classifier: { model: 'jev' } }, "'session.classifier.model'"],
        [{ classifier: { accountId: 'acct' } }, "'session.classifier.accountId'"],
        [{ classifier: { apiTokenEnv: 'cf-token value' } }, "'session.classifier.apiTokenEnv'"],
        [{ classifier: { threshold: 1 } }, "'session.classifier.threshold'"],
        [{ classifier: { token: 'x' } }, "unknown key 'session.classifier.token'"],
    ])('%j is refused', async (session, message) => {
        const dir = await project({ 'domaintrail.json': JSON.stringify({ session }) });
        const e = await loadConfig({ start: dir }).then(
            () => undefined,
            (x: unknown) => x,
        );
        expect(e).toBeInstanceOf(ConfigError);
        expect(String(e)).toContain(message);
    });
});
