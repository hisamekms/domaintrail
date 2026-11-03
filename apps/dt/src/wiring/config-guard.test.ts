// The configuration files kept from the runner: its deny rules name a `-c` file and its local override by every path
// they may be reached by, and the files named like a configuration file in any case beside a `-c` file outside the
// workspace are scanned before and after each run (a case-insensitive file system lets a variant past a rule).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { configFileRules, configGuardScan } from './config-guard.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const scratch = async (): Promise<string> => {
    const d = await realpath(await mkdtemp(path.join(tmpdir(), 'domaintrail-config-guard-')));
    dirs.push(d);
    return d;
};

describe('the configuration files kept from the runner', () => {
    test('a -c file and its local override: as given, by their real paths, and relative to the workspace below it', async () => {
        const base = await scratch();
        await mkdir(path.join(base, 'ws', 'conf'), { recursive: true });
        await symlink(path.join(base, 'ws'), path.join(base, 'ws-link'));
        const viaLink = path.join(base, 'ws-link', 'conf', 'team.jsonc');
        expect(configFileRules(viaLink, path.join(base, 'ws-link')).sort()).toEqual(
            [
                viaLink,
                path.join(base, 'ws-link', 'conf', 'team.local.jsonc'),
                path.join(base, 'ws', 'conf', 'team.jsonc'),
                path.join(base, 'ws', 'conf', 'team.local.jsonc'),
                'conf/team.jsonc',
                'conf/team.local.jsonc',
            ].sort(),
        );
        // outside the workspace: absolute only
        expect(configFileRules(path.join(base, 'conf', 'domaintrail.jsonc'), path.join(base, 'ws'))).toEqual([
            path.join(base, 'conf', 'domaintrail.jsonc'),
            path.join(base, 'conf', 'domaintrail.local.jsonc'),
            path.join(base, 'conf', 'domaintrail.local.json'),
        ]);
    });

    test('beside a -c file outside the workspace: every name of a configuration file in any case, in the scan', async () => {
        const base = await scratch();
        await mkdir(path.join(base, 'ws'));
        await mkdir(path.join(base, 'conf'));
        const team = path.join(base, 'conf', 'team.jsonc');
        await writeFile(team, '{}');
        await writeFile(path.join(base, 'conf', 'notes.md'), 'n');
        const before = await configGuardScan(team, path.join(base, 'ws'));
        expect([...before.keys()]).toEqual([team]);
        await writeFile(path.join(base, 'conf', 'Team.Local.JSONC'), '{}');
        await writeFile(path.join(base, 'conf', 'DomainTrail.Local.Json'), '{}');
        const after = await configGuardScan(team, path.join(base, 'ws'));
        expect([...after.keys()].sort()).toEqual([path.join(base, 'conf', 'DomainTrail.Local.Json'), path.join(base, 'conf', 'Team.Local.JSONC'), team].sort());
        // nothing without -c, or with its directory in the workspace (scanned whole)
        expect((await configGuardScan(undefined, path.join(base, 'ws'))).size).toBe(0);
        expect((await configGuardScan(path.join(base, 'ws', 'domaintrail.jsonc'), path.join(base, 'ws'))).size).toBe(0);
    });
});
