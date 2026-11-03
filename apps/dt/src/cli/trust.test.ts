// The approval of a workspace's security-relevant settings: what is hashed (the effective, merged settings), when the
// person is asked, refused without anyone to ask, recorded outside the workspace with private permissions.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { defaultConfig, resolveConfig, resolveConfigWithLocal } from '../config/config.js';
import { approveSettings, fileTrustStore, NotApproved, securitySettings, settingsHash, trustFile } from './trust.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const scratch = async (): Promise<string> => {
    const d = await realpath(await mkdtemp(path.join(tmpdir(), 'domaintrail-trust-')));
    dirs.push(d);
    return d;
};

describe('the security-relevant settings', () => {
    test('their hash: stable whatever the order of keys, changed by any of them, never by others (a port, a model)', () => {
        const file = path.resolve('/w/domaintrail.jsonc');
        const a = resolveConfig('{ "agent": { "run": { "allowedTools": ["Read"], "model": "opus" } }, "collab": { "port": 1 } }', file);
        const b = resolveConfig('{ "collab": { "port": 2 }, "agent": { "run": { "model": "sonnet", "allowedTools": ["Read"] } } }', file);
        expect(settingsHash(securitySettings(a))).toBe(settingsHash(securitySettings(b)));
        expect(settingsHash(securitySettings(a))).toMatch(/^[0-9a-f]{64}$/);
        const differs = (text: string): boolean =>
            settingsHash(securitySettings(resolveConfig(text, file))) !== settingsHash(securitySettings(defaultConfig('/w')));
        expect(differs('{ "open": { "port": 9 }, "agent": { "run": { "model": "x" }, "answer": { "timeout": 5 } } }')).toBe(false);
        expect(differs('{ "agent": { "run": { "allowedTools": ["Read", "Bash(npm test:*)"] } } }')).toBe(true);
        expect(differs('{ "agent": { "run": { "dt": ["node", "/elsewhere/dt.js"] } } }')).toBe(true);
        expect(differs('{ "open": { "host": "0.0.0.0" } }')).toBe(true);
        expect(differs('{ "collab": { "host": "::1" } }')).toBe(true);
        expect(differs('{ "classifier": { "enabled": true, "accountId": "0123456789abcdef0123456789abcdef" } }')).toBe(true);
        expect(differs('{ "classifier": { "threshold": 0.5 } }')).toBe(false);
        expect(Object.keys(securitySettings(a))).toEqual([
            'agent.read (answer)',
            'agent.read (run)',
            'agent.run.allowedTools',
            'agent.run.dt',
            'collab.identity',
            'collab.host',
            'collab.access',
            'open.host',
            'classifier',
        ]);
    });

    test('of the merge: a changed local file changes them', () => {
        const project = { text: '{}', file: path.resolve('/w/domaintrail.jsonc') };
        const local = (text: string) => resolveConfigWithLocal(project, { text, file: path.resolve('/w/domaintrail.local.jsonc') });
        const before = settingsHash(securitySettings(local('{ "agent": { "read": { "paths": ["/srv/specs"] } } }')));
        expect(settingsHash(securitySettings(local('{ "agent": { "read": { "paths": ["/srv/other"] } } }')))).not.toBe(before);
        expect(securitySettings(local('{ "agent": { "run": { "read": { "paths": ["/srv/x"] } } } }'))['agent.read (run)']).toEqual([path.resolve('/srv/x')]);
    });
});

describe('approving them', () => {
    const changed = (root: string, text = '{ "agent": { "run": { "allowedTools": ["Read", "Edit"] } } }') =>
        resolveConfig(text, path.join(root, 'domaintrail.jsonc'));

    test('asked once: approved, they are kept by the workspace real path, outside it, private; declined, refused', async () => {
        const root = await scratch();
        const store = fileTrustStore(path.join(await scratch(), 'nested', 'domaintrail', 'trust.json'));
        const asked: string[] = [];
        const out: string[] = [];
        let answer = false;
        const deps = { trust: store, confirm: async (q: string) => (asked.push(q), answer), out: (l: string) => out.push(l) };
        const refused = await approveSettings(changed(root), deps, false).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(refused).toEqual(new NotApproved('Not started: the settings were not approved.'));
        expect(asked).toEqual(['Start with these settings? [y/N] ']);
        expect(out[0]).toBe(`Security-relevant settings not yet approved for this workspace (${root}):`);
        expect(out).toContain('  agent.run.allowedTools: ["Read","Edit"]');
        expect(await store.approved(root)).toBeUndefined();
        answer = true;
        await approveSettings(changed(root), deps, false);
        expect(await store.approved(root)).toBe(settingsHash(securitySettings(changed(root))));
        // the same settings again: not asked
        await approveSettings(changed(root), deps, false);
        expect(asked).toHaveLength(2);
        // changed: asked again
        await approveSettings(changed(root, '{ "agent": { "run": { "allowedTools": ["Read"] } } }'), deps, false);
        expect(asked).toHaveLength(3);
    });

    test('no one to ask: refused unless --yes, which records them; the defaults are never asked about', async () => {
        const root = await scratch();
        const file = path.join(await scratch(), 'domaintrail', 'trust.json');
        const store = fileTrustStore(file);
        const out: string[] = [];
        const refused = await approveSettings(changed(root), { trust: store, out: (l) => out.push(l) }, false).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(refused).toEqual(new NotApproved('Not started: approve these settings in a terminal, or pass --yes.'));
        await approveSettings(changed(root), { trust: store, out: (l) => out.push(l) }, true);
        expect(out.at(-1)).toBe('Approved for this workspace.');
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
            version: 1,
            workspaces: { [root]: { hash: settingsHash(securitySettings(changed(root))), approvedAt: expect.any(String) } },
        });
        // the defaults: nothing asked, nothing recorded
        const other = await scratch();
        await approveSettings(defaultConfig(other), { trust: store, out: () => {} }, false);
        expect(await store.approved(other)).toBeUndefined();
    });

    test('the file: under $XDG_CONFIG_HOME/domaintrail, else ~/.config/domaintrail (macOS too)', () => {
        expect(trustFile({ XDG_CONFIG_HOME: '/x/conf' })).toBe(path.resolve('/x/conf/domaintrail/trust.json'));
        expect(trustFile({ XDG_CONFIG_HOME: 'relative' })).toMatch(/\.config[\\/]domaintrail[\\/]trust\.json$/);
        expect(trustFile({})).toMatch(/\.config[\\/]domaintrail[\\/]trust\.json$/);
    });
});
