import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runCli } from '../src/cli/main.js';
import { ConfigError, findConfigFile, loadConfig, parseJsonc } from '../src/core/config.js';
import { findDomainFiles } from '../src/core/files.js';

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

const MODEL = 'context S { id AId: UUID aggregate A { id: AId } }';

async function run(...args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out, err };
}

describe('config file', () => {
    test('JSONC: comments and trailing commas', () => {
        expect(parseJsonc('{\n // c\n "a": "x // not a comment", /* b */ "b": [1, 2,],\n}')).toEqual({ a: 'x // not a comment', b: [1, 2] });
    });

    test('is found in the start directory or a parent; domaintrail.jsonc wins over domaintrail.json', async () => {
        const dir = await project({ 'domaintrail.json': '{}', 'domaintrail.jsonc': '{}', 'a/b/x.txt': '' });
        expect(findConfigFile(path.join(dir, 'a', 'b'))).toBe(path.join(dir, 'domaintrail.jsonc'));
    });

    test('paths are relative to the config file; defaults apply', async () => {
        const dir = await project({ 'domaintrail.json': '{ "generate": { "ts": { "out": "src/gen" } } }', 'sub/x.txt': '' });
        const c = await loadConfig({ start: path.join(dir, 'sub') });
        expect(c).toMatchObject({ root: dir, file: path.join(dir, 'domaintrail.json'), sources: ['**/*.dt'], tsOut: 'src/gen', view: { port: 4321, host: '127.0.0.1' } });
    });

    test.each([
        ['{ "source": [] }', "unknown key 'source'"],
        ['{ "sources": "a" }', "'sources' must be an array of glob strings"],
        ['{ "sources": ["!x/**"] }', "'sources' needs at least one include pattern"],
        ['{ "generate": { "rust": {} } }', "unknown generator 'generate.rust' (supported: ts)"],
        ['{ "view": { "port": "80" } }', "'view.port' must be a port number"],
        ['{ "sources": [ }', 'invalid JSON'],
        ['{ "generate": { "ts": { "out": "../elsewhere" } } }', "'generate.ts.out' must stay inside the directory of the config file"],
        ['{ "generate": { "ts": { "out": "/tmp/x" } } }', "'generate.ts.out' must stay inside the directory of the config file"],
    ])('invalid config %s', async (text, message) => {
        const dir = await project({ 'domaintrail.json': text });
        const e = await loadConfig({ start: dir }).catch((x) => x);
        expect(e).toBeInstanceOf(ConfigError);
        expect(e.message).toContain(message);
    });
});

describe('sources', () => {
    test('globs include and exclude; ignored directories are never scanned', async () => {
        const dir = await project({
            'domain/sales/order.dt': MODEL,
            'domain/drafts/wip.dt': MODEL,
            'other/x.dt': MODEL,
            'node_modules/pkg/y.dt': MODEL,
        });
        expect(await findDomainFiles(dir)).toEqual(['domain/drafts/wip.dt', 'domain/sales/order.dt', 'other/x.dt']);
        expect(await findDomainFiles(dir, ['domain/**/*.dt', '!domain/drafts/**'])).toEqual(['domain/sales/order.dt']);
    });
});

describe('CLI with a config', () => {
    test('check and generate use sources and generate.ts.out from the config found in a parent', async () => {
        const dir = await project({
            'domaintrail.jsonc': '{ // model lives in domain/\n "sources": ["domain/**/*.dt"], "generate": { "ts": { "out": "src/generated" } } }',
            'domain/s.dt': MODEL,
            'scratch/broken.dt': 'context {',
            'app/readme.txt': '',
        });
        const check = await run('-r', path.join(dir, 'app'), 'check');
        expect(check.code).toBe(0);
        expect(check.out).toEqual(['1 file(s) checked: 0 error(s), 0 warning(s).']);

        const gen = await run('-r', path.join(dir, 'app'), 'generate', 'ts');
        expect(gen.code).toBe(0);
        expect((await readdir(path.join(dir, 'src', 'generated'))).sort()).toEqual(['S.ts', '_runtime.ts', 'index.ts']);
    });

    test('--out overrides the config; --config picks a file explicitly', async () => {
        const dir = await project({
            'conf/custom.json': '{ "sources": ["../model/*.dt"] }',
            'domaintrail.json': '{ "sources": ["model/*.dt"], "generate": { "ts": { "out": "gen-a" } } }',
            'model/s.dt': MODEL,
        });
        const gen = await run('-r', dir, 'generate', 'ts', '--out', 'gen-b');
        expect(gen.code).toBe(0);
        expect(await readdir(dir)).toContain('gen-b');
        expect(await readdir(dir)).not.toContain('gen-a');

        const explicit = await run('--config', path.join(dir, 'conf', 'custom.json'), 'check');
        expect(explicit.code).toBe(2);
        expect(explicit.err[0]).toContain("'sources' must stay inside the directory of the config file: '../model/*.dt'");
        const missing = await run('--config', path.join(dir, 'nope.json'), 'check');
        expect(missing).toMatchObject({ code: 2, err: [`Config file not found: ${path.join(dir, 'nope.json')}`] });
    });

    test('generation never deletes or overwrites hand-written files in the output directory', async () => {
        const dir = await project({
            'domaintrail.json': '{ "generate": { "ts": { "out": "src" } } }',
            's.dt': MODEL,
            'src/app.ts': 'export const handWritten = 1;\n',
        });
        expect((await run('-r', dir, 'generate', 'ts')).code).toBe(0);
        expect((await run('-r', dir, 'generate', 'ts')).code).toBe(0); // regenerating replaces only generated files
        expect((await readdir(path.join(dir, 'src'))).sort()).toEqual(['S.ts', '_runtime.ts', 'app.ts', 'index.ts']);

        await writeFile(path.join(dir, 'src', 'index.ts'), 'export * from "./app";\n');
        const r = await run('-r', dir, 'generate', 'ts');
        expect(r.code).toBe(1);
        expect(r.err.at(-1)).toContain('index.ts');
        expect(r.err.at(-1)).toContain('not generated by domaintrail');
        expect(await Bun.file(path.join(dir, 'src', 'index.ts')).text()).toBe('export * from "./app";\n');
    });

    test('an invalid config is reported with exit code 2', async () => {
        const dir = await project({ 'domaintrail.json': '{ "sourcez": [] }' });
        const r = await run('-r', dir, 'check');
        expect(r.code).toBe(2);
        expect(r.err[0]).toBe(`${path.join(dir, 'domaintrail.json')}: unknown key 'sourcez'`);
    });
});
