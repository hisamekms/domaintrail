/**
 * `dt migrate dtes` (ADR 0032) on the fixtures of test/fixtures/migrate: v0.1 files (`actor`, `target` in a command) are
 * rewritten to the ones in `migrated/`, keyword by keyword and nothing else; what it cannot rewrite is listed, and so are
 * the errors that remain for people (or the AI) to decide.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps, runCli } from '@domaintrail/dt';
import { formatStorming, migrateStorming } from '@domaintrail/storming';

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'migrate');

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** The v0.1 fixtures, copied into a workspace of their own. */
async function copy(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-migrate-'));
    dirs.push(dir);
    await cp(path.join(FIXTURES, 'v0.1'), dir, { recursive: true });
    return dir;
}

async function run(...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, cliDeps());
    return { code, out, err };
}

describe('dt migrate dtes', () => {
    test('rewrites `actor` and `target` of every command in place, keeping everything else, and lists them', async () => {
        const dir = await copy();
        const r = await run('-r', dir, 'migrate', 'dtes');
        for (const name of await readdir(path.join(FIXTURES, 'migrated'))) {
            expect(await readFile(path.join(dir, name), 'utf8')).toBe(await readFile(path.join(FIXTURES, 'migrated', name), 'utf8'));
        }
        expect(r.out).toContain('delivery-cancellation.dtes:25:5 - actor Customer → by Customer (command CancelShipment)');
        expect(r.out).toContain('delivery-cancellation.dtes:27:5 - target Shipment → handledBy Shipment (command CancelShipment)');
        expect(r.out).toContain('3 file(s): 7 keyword(s) rewritten in 2 file(s), 2 left.');
        // what it cannot rewrite: a `target` outside a command, a file that does not parse (an ID that is now a keyword)
        expect(r.err).toContain(
            "odd.dtes:7:5 - not rewritten: `target Desk` in policy 'Misplaced': only a command's `target` has a replacement (`handledBy`); move the relation into the command it belongs to, or remove it",
        );
        expect(r.err.some((l) => l.startsWith('broken.dtes:2:9 - not rewritten: does not parse'))).toBe(true);
        expect(await readFile(path.join(dir, 'broken.dtes'), 'utf8')).toBe(await readFile(path.join(FIXTURES, 'v0.1', 'broken.dtes'), 'utf8'));
        // the decisions left: a command without its issuer (S024), the policy's `target` (S023), …
        expect(r.err.at(-1)).toMatch(/^\d+ error\(s\) remain for `dt check` to show \(.*S024 ×1.*S023 ×1.*\)/);
        expect(r.code).toBe(1);
        // a second run has nothing more to rewrite
        const again = await run('-r', dir, 'migrate', 'dtes', path.join(dir, 'delivery-cancellation.dtes'));
        expect(again.out[0]).toBe('1 file(s): 0 keyword(s) rewritten in 0 file(s), 0 left.');
        expect(again.code).toBe(0);
    });

    test('--dry-run writes nothing', async () => {
        const dir = await copy();
        const r = await run('-r', dir, 'migrate', 'dtes', '--dry-run');
        expect(r.out).toContain('3 file(s): 7 keyword(s) to rewrite in 2 file(s), 2 left.');
        expect(await readFile(path.join(dir, 'odd.dtes'), 'utf8')).toBe(await readFile(path.join(FIXTURES, 'v0.1', 'odd.dtes'), 'utf8'));
    });

    test('the migrated fixtures are formatted, and the rewrite changes only keywords', async () => {
        for (const name of await readdir(path.join(FIXTURES, 'migrated'))) {
            const before = await readFile(path.join(FIXTURES, 'v0.1', name), 'utf8');
            const after = migrateStorming(before);
            expect(after.text).toBe(await readFile(path.join(FIXTURES, 'migrated', name), 'utf8'));
            // line by line: a changed line is the same line with its keyword replaced
            const lines = before.split('\n');
            after.text.split('\n').forEach((line, i) => {
                if (line !== lines[i]) expect(line).toBe(lines[i]!.replace(/^(\s*)actor /, '$1by ').replace(/^(\s*)target /, '$1handledBy '));
            });
            expect(formatStorming(after.text)).toBe(after.text);
        }
    });
});
