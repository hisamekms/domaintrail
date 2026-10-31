import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps } from '@domaintrail/composition/cli';
import { runCli } from '@domaintrail/presentation/cli/main';
import { ConfigError, checkTsContexts, parseJsonc, policyModes } from '@domaintrail/modeling/core/config';
import { findConfigFile, loadConfig } from '@domaintrail/workspace/infrastructure/config';
import { findDomainFiles } from '@domaintrail/workspace/infrastructure/files';

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
    const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, cliDeps());
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

describe('.gitignore', () => {
    const OTHER = 'context T { id BId: UUID aggregate B { id: BId } }';

    test('an ignored directory holding a copy of the model is not loaded (a grammar cloned by an editor extension)', async () => {
        const dir = await project({
            'examples/shop/s.dt': MODEL,
            'editors/zed/.gitignore': '/target/\n/grammars/\n*.wasm\n',
            'editors/zed/grammars/domaintrail/examples/shop/s.dt': MODEL,
        });
        expect(await findDomainFiles(dir)).toEqual(['examples/shop/s.dt']);
        expect(await run('-r', dir, 'check')).toMatchObject({ code: 0, out: ['1 file(s) checked: 0 error(s), 0 warning(s).'] });
    });

    test("git's rules: negation, directory patterns, anchoring, comments", async () => {
        const dir = await project({
            '.gitignore': '# drafts stay local\ndrafts/*.dt\n!drafts/keep.dt\nbuild/\n/top.dt\n',
            'drafts/wip.dt': MODEL,
            'drafts/keep.dt': MODEL,
            'build/x.dt': MODEL,
            'src/build/y.dt': MODEL,
            'build.dt': MODEL,
            'top.dt': MODEL,
            'sub/top.dt': MODEL,
        });
        expect(await findDomainFiles(dir)).toEqual(['build.dt', 'drafts/keep.dt', 'sub/top.dt']);
    });

    test('a nested .gitignore applies below its directory and wins over the ones above it', async () => {
        const dir = await project({
            '.gitignore': '*.local.dt\na/b/\n',
            'a/.gitignore': '!b/\nscratch.dt\n!keep.local.dt\n',
            'a/b/s.dt': MODEL,
            'a/c/scratch.dt': MODEL,
            'scratch.dt': MODEL,
            'a/keep.local.dt': MODEL,
            'a/other.local.dt': MODEL,
            'x.local.dt': MODEL,
        });
        expect(await findDomainFiles(dir)).toEqual(['a/b/s.dt', 'a/keep.local.dt', 'scratch.dt']);
    });

    test('the .gitignore files above the root up to the top of the git repository apply, and .git/info/exclude', async () => {
        const dir = await project({
            '.git/info/exclude': 'private/\n',
            '.gitignore': 'scratch/\n/domain/top-only.dt\n',
            'domain/s.dt': MODEL,
            'domain/top-only.dt': MODEL,
            'domain/scratch/s.dt': MODEL,
            'domain/private/s.dt': MODEL,
        });
        expect(await findDomainFiles(path.join(dir, 'domain'))).toEqual(['s.dt']);
        // a root inside an ignored directory is checked as it is, with the rules from the root down only
        expect(await findDomainFiles(path.join(dir, 'domain', 'scratch'))).toEqual(['s.dt']);
    });

    test('"respectGitignore": false loads the ignored files too; explicit files are formatted whatever .gitignore says', async () => {
        const dir = await project({ '.gitignore': 'copy/\n', 's.dt': MODEL, 'copy/s.dt': MODEL, 't.dt': OTHER });
        expect(await findDomainFiles(dir, undefined, false)).toEqual(['copy/s.dt', 's.dt', 't.dt']);
        expect((await run('-r', dir, 'check')).code).toBe(0);
        await writeFile(path.join(dir, 'domaintrail.jsonc'), '{ "respectGitignore": false }');
        const off = await run('-r', dir, 'check', '--format', 'json');
        expect(JSON.parse(off.out.join('\n')).summary.files).toBe(3);
        expect(off.code).toBe(1);

        await writeFile(path.join(dir, 'copy', 's.dt'), 'context S {\nid AId: UUID }\n');
        const cwd = process.cwd();
        process.chdir(dir);
        try {
            expect((await run('fmt', '--check', path.join('copy', 's.dt'))).out).toEqual([path.join('copy', 's.dt')]);
        } finally {
            process.chdir(cwd);
        }
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

    test('generate.ts.tests writes the contract tests, by default into tests below out (or --out), importing every directory', async () => {
        const dir = await project({ 'domaintrail.json': config({ out: 'gen', contexts: { C: { out: 'shared/gen' } }, tests: {} }), ...SPLIT_MODEL });
        expect((await run('-r', dir, 'generate', 'ts')).code).toBe(0);
        expect(await ls(path.join(dir, 'gen', 'tests'))).toEqual(['C.ts', 'S.ts', '_testing.ts', 'index.ts']);
        expect(await Bun.file(path.join(dir, 'gen', 'tests', 'C.ts')).text()).toContain(`from '../../shared/gen/C.js';`);
        expect((await run('-r', dir, 'generate', 'ts', '--out', 'other')).code).toBe(0);
        expect(await ls(path.join(dir, 'other', 'tests'))).toEqual(['C.ts', 'S.ts', '_testing.ts', 'index.ts']);
        expect(await ls(path.join(dir, 'gen'))).toEqual([]); // the earlier run's files are removed

        await writeFile(path.join(dir, 'domaintrail.json'), config({ out: 'gen', tests: { out: 'spec/contract', runner: 'vitest' } }));
        expect((await run('-r', dir, 'generate', 'ts')).code).toBe(0);
        expect(await ls(path.join(dir, 'spec', 'contract'))).toEqual(['C.ts', 'S.ts', '_register.ts', '_testing.ts', 'index.ts']);
        expect(await Bun.file(path.join(dir, 'spec', 'contract', '_register.ts')).text()).toContain(`import { describe, test } from 'vitest';`);
        expect(await Bun.file(path.join(dir, 'spec', 'contract', 'S.ts')).text()).toContain(`from '../../gen/S.js';`);
    });

    test('a context name the model does not have is a config error (exit 2) and nothing is written', async () => {
        const dir = await project({ 'domaintrail.json': config({ contexts: { Nope: { out: 'x' } } }), ...SPLIT_MODEL });
        const r = await run('-r', dir, 'generate', 'ts');
        expect(r.code).toBe(2);
        expect(r.err.at(-1)).toBe(
            `${path.join(dir, 'domaintrail.json')}: 'generate.ts.contexts' names 'Nope', which is not a context of the model (contexts: C, S).`,
        );
        expect(await ls(dir)).toEqual(['c.dt', 'domaintrail.json', 's.dt']);
    });

    test('files of earlier runs that are no longer generated are removed; hand-written files stay', async () => {
        const dir = await project({ 'domaintrail.json': config({ out: 'gen', contexts: { C: { out: 'shared/gen' } } }), ...SPLIT_MODEL });
        expect((await run('-r', dir, 'generate', 'ts')).code).toBe(0);
        const manifest = JSON.parse(await Bun.file(path.join(dir, '.domaintrail', 'generated.json')).text());
        expect(manifest).toEqual({
            version: 1,
            files: ['gen/S.ts', 'gen/_runtime.ts', 'gen/index.ts', 'shared/gen/C.ts', 'shared/gen/_runtime.ts', 'shared/gen/index.ts'],
        });

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
        const { generateTypeScript } = await import('@domaintrail/modeling/generator/typescript');
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

        // --out is checked the same way
        const dir3 = await project({ 's.dt': MODEL });
        await symlink(outside, path.join(dir3, 'linked'));
        const r3 = await run('-r', dir3, 'generate', 'ts', '--out', 'linked/gen');
        expect(r3.code).toBe(1);
        expect(r3.err.at(-1)).toContain('is a symlink');
        expect((await readdir(outside)).sort()).toEqual(['keep.txt']);
    });

    test('--out outside the root is a config error (exit 2) and nothing is written', async () => {
        const parent = await project({});
        const dir = path.join(parent, 'a', 'b');
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 's.dt'), MODEL);
        for (const out of ['../..', '../x', path.join(parent, 'abs')]) {
            const r = await run('-r', dir, 'generate', 'ts', '--out', out);
            expect(r.code).toBe(2);
            expect(r.err.at(-1)).toBe(`--out must stay inside ${dir} (the directory of the config file, else the root): '${out}'`);
        }
        expect((await readdir(parent)).sort()).toEqual(['a']);
        expect(await readdir(path.join(parent, 'a'))).toEqual(['b']);
        expect(await readdir(dir)).toEqual(['s.dt']);
    });

    test('generated.json entries outside the root or through a symlink are never deleted', async () => {
        const { symlink } = await import('node:fs/promises');
        const { existsSync } = await import('node:fs');
        const marked = '// Generated by domaintrail.\nexport {};\n';
        const outside = await project({ 'victim/gen/S.ts': marked, 'victim/abs.ts': marked, 'linked/S.ts': marked });
        const dir = await project({ 's.dt': MODEL });
        await symlink(path.join(outside, 'linked'), path.join(dir, 'link'));
        const rel = path
            .relative(dir, path.join(outside, 'victim', 'gen', 'S.ts'))
            .split(path.sep)
            .join('/');
        const files = [rel, path.join(outside, 'victim', 'abs.ts'), 'link/S.ts', `generated/domain/../../${rel}`];
        await mkdir(path.join(dir, '.domaintrail'));
        await writeFile(path.join(dir, '.domaintrail', 'generated.json'), JSON.stringify({ version: 1, files }));
        expect((await run('-r', dir, 'generate', 'ts')).code).toBe(0);
        expect(existsSync(path.join(outside, 'victim', 'gen', 'S.ts'))).toBe(true);
        expect(existsSync(path.join(outside, 'victim', 'abs.ts'))).toBe(true);
        expect(existsSync(path.join(outside, 'linked', 'S.ts'))).toBe(true);
        const manifest = JSON.parse(await Bun.file(path.join(dir, '.domaintrail', 'generated.json')).text());
        expect(manifest.files).toEqual(['generated/domain/S.ts', 'generated/domain/_runtime.ts', 'generated/domain/index.ts']);
    });
});

describe('session section (ADR 0026)', () => {
    test('defaults: dev identity on loopback, the default agent tools, 50 participants', async () => {
        const c = await loadConfig({ start: await project({ 'domaintrail.json': '{}' }) });
        expect(c.session).toEqual({
            port: 4321,
            host: '127.0.0.1',
            identity: 'dev',
            agent: { port: 0, allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(dt fmt:*)', 'Bash(dt check:*)'] },
            maxParticipants: 50,
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
                agent: { port: 9000, allowedTools: ['Read'] },
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
            agent: { port: 9000, allowedTools: ['Read'] },
            maxParticipants: 5,
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
        [{ maxParticipants: 0 }, "'session.maxParticipants'"],
        [{ token: 'x' }, "unknown key 'session.token'"],
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
