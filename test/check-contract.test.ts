/**
 * Baseline of ADR 0027 (plan T0): what `dt check` prints and exits with over the fixtures — `.dt` only, `.dtes` only,
 * both, a `.dtes` whose refs are broken, syntax errors in either language, and examples/shop. Splitting the analysis
 * (T4), moving the TypeScript name check (T5), moving the packages (T8) and the checkers onto the typed model (T10)
 * keep every diagnostic: rule, message, hint, range, order, the stream it goes to, and the exit code. A deliberate
 * change updates the snapshots with `bun test -u` and says why in its commit.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps, runCli } from '@domaintrail/dt';
import { EXAMPLES } from './helpers.js';

const FIXTURES = path.join(import.meta.dir, 'fixtures');

/** Each case: a directory checked as the root of a workspace. */
const CASES: Record<string, string> = {
    'dt only': path.join(FIXTURES, 'check', 'dt-only'),
    'dtes only': path.join(FIXTURES, 'dtes'),
    'dt and dtes': path.join(FIXTURES, 'check', 'mixed'),
    'broken refs': path.join(FIXTURES, 'check', 'broken-ref'),
    'dt syntax error': path.join(FIXTURES, 'check', 'dt-syntax'),
    'dtes syntax error': path.join(FIXTURES, 'check', 'dtes-syntax'),
    'examples/shop': EXAMPLES,
};

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/**
 * A fixture copied outside the repository: it has no config file, and in place the root domaintrail.jsonc (DomainTrail's
 * own model) would be found above it.
 */
async function outside(fixture: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-check-'));
    dirs.push(dir);
    await cp(fixture, dir, { recursive: true });
    return dir;
}

/** What one run printed, line by line with its stream, and its exit code; the root is `<root>`. */
async function check(fixture: string, ...args: string[]): Promise<{ code: number; lines: string[] }> {
    const root = fixture === EXAMPLES ? fixture : await outside(fixture);
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(`out: ${l}`), err: (l: string) => lines.push(`err: ${l}`) };
    const code = await runCli(['-r', root, 'check', ...args], io, cliDeps());
    return { code, lines: lines.map((l) => l.replaceAll(root, '<root>')) };
}

describe('dt check', () => {
    for (const [name, root] of Object.entries(CASES)) {
        test(`${name}: text`, async () => {
            expect(await check(root)).toMatchSnapshot();
        });

        test(`${name}: json`, async () => {
            // the document as printed: the order of its keys is part of it
            expect(await check(root, '--format', 'json')).toMatchSnapshot();
        });
    }
});
