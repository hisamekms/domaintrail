// Finding and reading the config file; the workspace knows none of its sections (the sections composed:
// packages/presentation/src/config/config.test.ts).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { type ConfigFileFormat, findConfigFile, loadConfig } from './config.js';

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
});
