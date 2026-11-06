/**
 * `dt migrate dtes` (ADR 0032) on the fixtures of test/fixtures/migrate: v0.1 files (`actor`, `target` in a command) are
 * rewritten to the ones in `migrated/`, keyword by keyword and nothing else; what it cannot rewrite is listed, and so are
 * the errors that remain for people (or the AI) to decide.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
        expect(r.out).toContain('3 file(s): 7 keyword(s) rewritten and 0 `reads` moved in 2 file(s), 3 left.');
        // what it cannot rewrite: a `target` outside a command, a file that does not parse (an ID that is now a keyword)
        expect(r.err).toContain(
            "odd.dtes:7:5 - not rewritten: `target Desk` in policy 'Misplaced': only a command's `target` has a replacement (`handledBy`); move the relation into the command it belongs to, or remove it",
        );
        expect(r.err.some((l) => l.startsWith('broken.dtes:2:9 - not rewritten: does not parse'))).toBe(true);
        expect(await readFile(path.join(dir, 'broken.dtes'), 'utf8')).toBe(await readFile(path.join(FIXTURES, 'v0.1', 'broken.dtes'), 'utf8'));
        // the decisions left: a command without its issuer (S024), the policy's `target` (S023), …
        expect(r.err.at(-1)).toMatch(/^\d+ error\(s\) remain for `dt check` to show \(.*S024 ×1.*S023 ×1.*\)/);
        expect(r.code).toBe(1);
        // the v0.1 sample's policy issues two commands (S031): listed, to split by hand
        expect(r.err).toContain(
            "delivery-cancellation.dtes:45:5 - not rewritten: policy 'CleanupAfterCancel' issues 'ReleaseBike' and 'ReleaseSlot': a policy issues one command (S031); split it into one policy per command, each with the `reads` it looks at, then run this again (the `reads` of its commands are left where they are)",
        );
        // a second run has nothing more to rewrite, and lists the same
        const again = await run('-r', dir, 'migrate', 'dtes', path.join(dir, 'delivery-cancellation.dtes'));
        expect(again.out[0]).toBe('1 file(s): 0 keyword(s) rewritten and 0 `reads` moved in 0 file(s), 1 left.');
        expect(again.err[0]).toStartWith("delivery-cancellation.dtes:45:5 - not rewritten: policy 'CleanupAfterCancel' issues");
        expect(again.code).toBe(1);
    });

    test('--dry-run writes nothing', async () => {
        const dir = await copy();
        const r = await run('-r', dir, 'migrate', 'dtes', '--dry-run');
        expect(r.out).toContain('3 file(s): 7 keyword(s) to rewrite and 0 `reads` to move in 2 file(s), 3 left.');
        expect(await readFile(path.join(dir, 'odd.dtes'), 'utf8')).toBe(await readFile(path.join(FIXTURES, 'v0.1', 'odd.dtes'), 'utf8'));
    });

    test('0.8: moves the `reads` of a command one policy issues into the policy, lists what it cannot, and a second run changes nothing', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-migrate-'));
        dirs.push(dir);
        const before = `storming Dispatch {
  event Cutoff
  event Failed
  event Allocated
  readmodel Requests
  readmodel Drivers
  aggregate Plan
  command BuildAllocation {
    // what is looked at to decide
    reads Requests
    handledBy Plan
    emits Allocated, Failed
  }
  command Reassign {
    reads Drivers
    handledBy Plan
    emits Allocated
  }
  policy AtCutoff {
    on Cutoff
    issues BuildAllocation
  }
  policy OnFailure {
    on Failed
    issues Reassign
  }
  policy Retry {
    on Failed
    issues Reassign
  }
}
`;
        await writeFile(path.join(dir, 'dispatch.dtes'), before);
        const r = await run('-r', dir, 'migrate', 'dtes');
        expect(r.out).toEqual([
            'dispatch.dtes:10:5 - reads Requests: command BuildAllocation → policy AtCutoff',
            '1 file(s): 0 keyword(s) rewritten and 1 `reads` moved in 1 file(s), 1 left.',
        ]);
        expect(r.err[0]).toBe(
            "dispatch.dtes:15:5 - not rewritten: `reads Drivers` in command 'Reassign', which the policies 'OnFailure' and 'Retry' issue: write it in the `reads` of the policy that looks at it, and remove it here (S030); it is not copied to each",
        );
        expect(r.err.at(-1)).toMatch(/^1 error\(s\) remain for `dt check` to show \(S030 ×1\)/);
        expect(r.code).toBe(1);
        const after = await readFile(path.join(dir, 'dispatch.dtes'), 'utf8');
        expect(after).toBe(
            before
                .replace('    // what is looked at to decide\n    reads Requests\n', '')
                .replace(
                    '    on Cutoff\n    issues BuildAllocation',
                    '    on Cutoff\n    // what is looked at to decide\n    reads Requests\n    issues BuildAllocation',
                ),
        );
        expect(formatStorming(after)).toBe(after);
        const again = await run('-r', dir, 'migrate', 'dtes');
        expect(again.out).toEqual(['1 file(s): 0 keyword(s) rewritten and 0 `reads` moved in 0 file(s), 1 left.']);
        // the same left, at its place in the migrated file (two lines up)
        expect(again.err[0]).toBe(r.err[0]!.replace('dispatch.dtes:15:5', 'dispatch.dtes:13:5'));
        expect(await readFile(path.join(dir, 'dispatch.dtes'), 'utf8')).toBe(after);
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
