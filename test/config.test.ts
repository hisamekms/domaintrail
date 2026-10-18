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
        expect(c).toMatchObject({ root: dir, file: path.join(dir, 'domaintrail.json'), sources: ['**/*.dt'], tsOut: 'src/gen', tsContexts: {}, view: { port: 4321, host: '127.0.0.1' } });
    });

    test('generate.ts.contexts maps context names to output directories', async () => {
        const dir = await project({ 'domaintrail.json': '{ "generate": { "ts": { "contexts": { "C": { "out": "shared/gen" } } } } }' });
        expect(await loadConfig({ start: dir })).toMatchObject({ tsOut: 'generated/domain', tsContexts: { C: 'shared/gen' } });
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
        ['{ "generate": { "ts": { "outDir": "x" } } }', "unknown key 'generate.ts.outDir'"],
        ['{ "generate": { "ts": { "contexts": [] } } }', "'generate.ts.contexts' must be an object keyed by context name"],
        ['{ "generate": { "ts": { "contexts": { "C": "x" } } } }', "'generate.ts.contexts.C' must be an object"],
        ['{ "generate": { "ts": { "contexts": { "C": {} } } } }', "'generate.ts.contexts.C.out' is required"],
        ['{ "generate": { "ts": { "contexts": { "C": { "out": "../x" } } } } }', "'generate.ts.contexts.C.out' must stay inside the directory of the config file"],
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

describe('output directories per context', () => {
    const SPLIT_MODEL = {
        'c.dt': 'shared context C { value V { n: Int } }',
        's.dt': 'context S { id AId: UUID aggregate A { id: AId v: V } }',
    };
    const config = (ts: object) => JSON.stringify({ generate: { ts } });
    const ls = (dir: string) => readdir(dir).then((names) => names.sort());

    test('listed contexts go to their own directory, the others to out; --out replaces only out', async () => {
        const dir = await project({ 'domaintrail.json': config({ out: 'gen', contexts: { C: { out: 'shared/gen' } } }), ...SPLIT_MODEL });
        const r = await run('-r', dir, 'generate', 'ts');
        expect(r.code).toBe(0);
        expect(await ls(path.join(dir, 'gen'))).toEqual(['S.ts', '_runtime.ts', 'index.ts']);
        expect(await ls(path.join(dir, 'shared', 'gen'))).toEqual(['C.ts', '_runtime.ts', 'index.ts']);
        expect(await Bun.file(path.join(dir, 'gen', 'S.ts')).text()).toContain(`import type * as C from '../shared/gen/C.js';`);

        expect((await run('-r', dir, 'generate', 'ts', '--out', 'other')).code).toBe(0);
        expect(await ls(path.join(dir, 'other'))).toEqual(['S.ts', '_runtime.ts', 'index.ts']);
        expect(await ls(path.join(dir, 'shared', 'gen'))).toEqual(['C.ts', '_runtime.ts', 'index.ts']);
    });

    test('a context name the model does not have is a config error (exit 2) and nothing is written', async () => {
        const dir = await project({ 'domaintrail.json': config({ contexts: { Nope: { out: 'x' } } }), ...SPLIT_MODEL });
        const r = await run('-r', dir, 'generate', 'ts');
        expect(r.code).toBe(2);
        expect(r.err.at(-1)).toBe(`${path.join(dir, 'domaintrail.json')}: 'generate.ts.contexts' names 'Nope', which is not a context of the model (contexts: C, S).`);
        expect(await ls(dir)).toEqual(['c.dt', 'domaintrail.json', 's.dt']);
    });

    test('files of earlier runs that are no longer generated are removed; hand-written files stay', async () => {
        const dir = await project({ 'domaintrail.json': config({ out: 'gen', contexts: { C: { out: 'shared/gen' } } }), ...SPLIT_MODEL });
        expect((await run('-r', dir, 'generate', 'ts')).code).toBe(0);
        const manifest = JSON.parse(await Bun.file(path.join(dir, '.domaintrail', 'generated.json')).text());
        expect(manifest).toEqual({ version: 1, files: ['gen/S.ts', 'gen/_runtime.ts', 'gen/index.ts', 'shared/gen/C.ts', 'shared/gen/_runtime.ts', 'shared/gen/index.ts'] });

        // C moves back to out: its old directory is emptied and removed
        await writeFile(path.join(dir, 'domaintrail.json'), config({ out: 'gen' }));
        expect((await run('-r', dir, 'generate', 'ts')).code).toBe(0);
        expect(await ls(path.join(dir, 'gen'))).toEqual(['C.ts', 'S.ts', '_runtime.ts', 'index.ts']);
        expect(await ls(path.join(dir, 'shared'))).toEqual([]);

        // out moves; a hand-written file in the old directory keeps it alive, an edited generated file is not deleted
        await writeFile(path.join(dir, 'gen', 'app.ts'), 'export const handWritten = 1;\n');
        await writeFile(path.join(dir, 'gen', 'C.ts'), 'export const edited = 1;\n');
        await writeFile(path.join(dir, 'domaintrail.json'), config({ out: 'src/gen' }));
        expect((await run('-r', dir, 'generate', 'ts')).code).toBe(0);
        expect(await ls(path.join(dir, 'gen'))).toEqual(['C.ts', 'app.ts']);
        expect(await ls(path.join(dir, 'src', 'gen'))).toEqual(['C.ts', 'S.ts', '_runtime.ts', 'index.ts']);

        // a removed context
        await rm(path.join(dir, 'c.dt'));
        await writeFile(path.join(dir, 's.dt'), MODEL);
        expect((await run('-r', dir, 'generate', 'ts')).code).toBe(0);
        expect(await ls(path.join(dir, 'src', 'gen'))).toEqual(['S.ts', '_runtime.ts', 'index.ts']);
    });
});

describe('generated output safety', () => {
    test('labels cannot break out of comments in generated code', async () => {
        const { check } = await import('./helpers.js');
        const { generateTypeScript } = await import('../src/generator/typescript.js');
        const evil = 'x\\nexport const injected = 1;';
        const a = await check({
            'a.dt': `context S {
  enum E { A "${evil}" B "y\u2028export const injected2 = 2;" }
  primitive P: Int { invariant i "${evil}" { value > 0 } }
  id AId: UUID
  aggregate X "${evil}" { id: AId note: String "${evil}" command go() "${evil}" }
}`,
        });
        expect(a.ok).toBe(true);
        const code = generateTypeScript(a.model!).find((f) => f.path === 'S.ts')!.content;
        const lines = code.split(/\r\n|[\n\r\u2028\u2029]/);
        expect(lines.filter((l) => /^\s*export const injected/.test(l))).toEqual([]);
        expect(code).toContain("| 'A' // x export const injected = 1;");
    });

    test('generate refuses symlinks in the output (dangling ones included) and symlinked output directories', async () => {
        const { symlink } = await import('node:fs/promises');
        const { existsSync } = await import('node:fs');
        const outside = await project({ 'keep.txt': 'keep' });
        const dir = await project({ 'domaintrail.json': '{ "generate": { "ts": { "out": "gen" } } }', 's.dt': MODEL });
        await mkdir(path.join(dir, 'gen'));
        await symlink(path.join(outside, 'created-by-attack.ts'), path.join(dir, 'gen', 'index.ts'));
        const r = await run('-r', dir, 'generate', 'ts');
        expect(r.code).toBe(1);
        expect(r.err.at(-1)).toContain('index.ts');
        expect(existsSync(path.join(outside, 'created-by-attack.ts'))).toBe(false);

        const dir2 = await project({ 'domaintrail.json': '{ "generate": { "ts": { "out": "gen" } } }', 's.dt': MODEL });
        await symlink(outside, path.join(dir2, 'gen'));
        const r2 = await run('-r', dir2, 'generate', 'ts');
        expect(r2.code).toBe(1);
        expect(r2.err.at(-1)).toContain('is a symlink');
        expect((await readdir(outside)).sort()).toEqual(['keep.txt']);
    });
});
