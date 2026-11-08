// Finding and reading the config file; the workspace knows none of its sections (the sections composed:
// apps/dt/src/config/config.test.ts).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { type ConfigFileFormat, existsExactly, findConfigFile, findConfigFiles, loadConfig } from './config.js';

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

const FILES = ['domaintrail.jsonc', 'domaintrail.json'];
/** A format that only says what it was given. */
const format: ConfigFileFormat<{ text?: string; file?: string; root?: string }> = {
    files: FILES,
    resolve: (text, file) => ({ text, file }),
    defaults: (root) => ({ root }),
    notFound: (configPath) => new RangeError(`missing ${configPath}`),
};

describe('config file', () => {
    test('is found in the start directory or a parent; the first name wins in one directory', async () => {
        const dir = await project({ 'domaintrail.json': '{}', 'domaintrail.jsonc': '{}', 'a/b/x.txt': '' });
        expect(findConfigFile(path.join(dir, 'a', 'b'), FILES)).toBe(path.join(dir, 'domaintrail.jsonc'));
        expect(findConfigFile(path.join(dir, 'a', 'b'), ['domaintrail.json'])).toBe(path.join(dir, 'domaintrail.json'));
        expect(findConfigFile(path.join(dir, 'a'), ['nothing.json'])).toBeUndefined();
    });

    test('its text goes to the format with its path; without a file, the defaults rooted at the start', async () => {
        const dir = await project({ 'domaintrail.json': '{ "x": 1 }', 'sub/x.txt': '' });
        expect(await loadConfig({ start: path.join(dir, 'sub') }, format)).toEqual({ text: '{ "x": 1 }', file: path.join(dir, 'domaintrail.json') });
        const bare = await project({ 'a.txt': '' });
        expect(await loadConfig({ start: bare }, { ...format, files: ['nothing.json'] })).toEqual({ root: bare });
    });

    test('an explicit file is read wherever it is, and its absence is the error the format gives', async () => {
        const dir = await project({ 'conf/custom.json': '{}' });
        expect(await loadConfig({ start: dir, configPath: path.join(dir, 'conf', 'custom.json') }, format)).toEqual({
            text: '{}',
            file: path.join(dir, 'conf', 'custom.json'),
        });
        const e: unknown = await loadConfig({ start: dir, configPath: 'nope.json' }, format).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(RangeError);
        expect(String(e)).toContain('missing nope.json');
    });

    test('the local override beside the file found, or alone in a directory: merged by the format', async () => {
        const local: ConfigFileFormat<{ project?: string; local?: string; root?: string }> = {
            files: FILES,
            resolve: (text, file) => ({ project: `${file}:${text}` }),
            localFiles: (file) => [path.join(path.dirname(file), 'domaintrail.local.jsonc'), path.join(path.dirname(file), 'domaintrail.local.json')],
            resolveWithLocal: (project, l) => ({ ...(project && { project: `${project.file}:${project.text}` }), local: `${l.file}:${l.text}` }),
            defaults: (root) => ({ root }),
            notFound: (configPath) => new RangeError(`missing ${configPath}`),
        };
        const dir = await project({
            'domaintrail.json': 'P',
            'domaintrail.local.json': 'L2',
            'domaintrail.local.jsonc': 'L',
            'alone/domaintrail.local.json': 'A',
            'alone/sub/x.txt': '',
            'conf/team.jsonc': 'T',
            'conf/domaintrail.local.jsonc': 'not-for-team',
            'conf/team.local.jsonc': 'TL',
        });
        // .local.jsonc first, beside domaintrail.json too
        expect(await loadConfig({ start: dir }, local)).toEqual({
            project: `${path.join(dir, 'domaintrail.json')}:P`,
            local: `${path.join(dir, 'domaintrail.local.jsonc')}:L`,
        });
        // a local file alone is the nearest configuration
        expect(findConfigFiles({ start: path.join(dir, 'alone', 'sub') }, local)).toEqual({ local: path.join(dir, 'alone', 'domaintrail.local.json') });
        expect(await loadConfig({ start: path.join(dir, 'alone', 'sub') }, local)).toEqual({ local: `${path.join(dir, 'alone', 'domaintrail.local.json')}:A` });
        // -c: the format names the local file beside it
        const team = { ...local, localFiles: (file: string) => [file.replace(/\.jsonc$/, '.local.jsonc')] };
        expect(findConfigFiles({ start: dir, configPath: path.join(dir, 'conf', 'team.jsonc') }, team)).toEqual({
            file: path.join(dir, 'conf', 'team.jsonc'),
            local: path.join(dir, 'conf', 'team.local.jsonc'),
        });
        // a format without a local override reads the file alone
        expect(await loadConfig({ start: dir }, format)).toEqual({ text: 'P', file: path.join(dir, 'domaintrail.json') });
    });

    test('a case variant of a name is never taken for it (an agent could write one past a case-sensitive rule)', async () => {
        const dir = await project({ 'DomainTrail.JSONC': '{}', 'DomainTrail.Local.JSONC': '{}', 'sub/x.txt': '' });
        const local = { ...format, localFiles: (file: string) => [path.join(path.dirname(file), 'domaintrail.local.jsonc')] };
        expect(findConfigFiles({ start: path.join(dir, 'sub') }, local)).toEqual({});
        expect(findConfigFile(dir, FILES)).toBeUndefined();
        expect(existsExactly(path.join(dir, 'DomainTrail.JSONC'))).toBe(true);
        expect(existsExactly(path.join(dir, 'domaintrail.jsonc'))).toBe(false);
    });
});
