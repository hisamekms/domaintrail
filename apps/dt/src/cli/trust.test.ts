// The approval of a workspace's security-relevant settings: what is hashed (the effective, merged settings), when the
// person is asked, refused without anyone to ask, recorded outside the workspace with private permissions.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { defaultConfig, resolveConfig, resolveConfigWithLocal } from '../config/config.js';
import {
    approvedFor,
    approveSettings,
    fileTrustStore,
    NotApproved,
    pinnedApproval,
    PUBLISH_PROJECT_ENV,
    PUBLISH_URL_ENV,
    securitySettings,
    settingsHash,
    trustFile,
} from './trust.js';

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

    test('the link identity mode, its public URL and --tunnel (the session on the internet) change them', () => {
        const file = path.resolve('/w/domaintrail.jsonc');
        const plain = settingsHash(securitySettings(defaultConfig('/w')));
        const link = resolveConfig('{ "collab": { "identity": "link" } }', file);
        expect(settingsHash(securitySettings(link))).not.toBe(plain);
        const proxied = resolveConfig('{ "collab": { "identity": "link", "link": { "publicUrl": "https://dt.example.com" } } }', file);
        expect(securitySettings(proxied)['collab.link']).toEqual({ publicUrl: 'https://dt.example.com' });
        expect(settingsHash(securitySettings(proxied))).not.toBe(settingsHash(securitySettings(link)));
        // --tunnel: the defaults of the file are no longer the defaults started with
        expect(settingsHash(securitySettings(defaultConfig('/w'), { tunnel: true }))).not.toBe(plain);
        expect(Object.keys(securitySettings(defaultConfig('/w'), { tunnel: true }))).toContain('collab --tunnel');
    });

    test("the knowledge store's Worker and project change them (the service token goes there), the files store and the timing do not", () => {
        const file = path.resolve('/w/domaintrail.jsonc');
        const plain = settingsHash(securitySettings(defaultConfig('/w')));
        const files = resolveConfig('{ "knowledge": { "project": "shop", "extraction": { "quietSeconds": 5 } } }', file);
        expect(settingsHash(securitySettings(files))).toBe(plain);
        const cloudflare = (url: string): Record<string, unknown> =>
            securitySettings(resolveConfig(`{ "knowledge": { "store": "cloudflare", "project": "shop", "url": "${url}" } }`, file));
        expect(cloudflare('https://k.example.com')['knowledge (cloudflare)']).toEqual({ url: 'https://k.example.com', project: 'shop' });
        expect(settingsHash(cloudflare('https://k.example.com'))).not.toBe(plain);
        expect(settingsHash(cloudflare('https://k.example.com'))).not.toBe(settingsHash(cloudflare('https://elsewhere.example.com')));
    });

    test('--tunnel asks for approval even with the default settings, and is refused without a terminal or --yes', async () => {
        const root = await scratch();
        const store = fileTrustStore(path.join(await scratch(), 'trust.json'));
        const out: string[] = [];
        const refused = await approveSettings(defaultConfig(root), { trust: store, out: (l) => out.push(l) }, false, { tunnel: true }).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(refused).toBeInstanceOf(NotApproved);
        expect(out.some((l) => l.includes('collab --tunnel'))).toBe(true);
        await approveSettings(defaultConfig(root), { trust: store, out: () => undefined }, true, { tunnel: true });
        expect(await store.approved(root)).toBe(settingsHash(securitySettings(defaultConfig(root), { tunnel: true })));
        // the same start again is not asked; without --tunnel, the defaults need no approval
        await approveSettings(defaultConfig(root), { trust: store, out: () => undefined }, false, { tunnel: true });
        await approveSettings(defaultConfig(root), { trust: store, out: () => undefined }, false);
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

describe('the destination pinned for CI (`dt publish`)', () => {
    const cloudflare = (root: string, url = 'https://knowledge.example.com', project = 'shop'): ReturnType<typeof resolveConfig> =>
        resolveConfig(JSON.stringify({ knowledge: { store: 'cloudflare', project, url } }), path.join(root, 'domaintrail.jsonc'));
    const pin = { [PUBLISH_URL_ENV]: 'https://knowledge.example.com/', [PUBLISH_PROJECT_ENV]: 'shop' };

    test('nothing pinned: no approval from it (the trust store or a terminal decides)', async () => {
        expect(pinnedApproval(cloudflare(await scratch()), {})).toBeUndefined();
    });

    test('pinned and named alike by the config: approved for that config only, which opens the store', async () => {
        const root = await scratch();
        const cfg = cloudflare(root);
        const proof = pinnedApproval(cfg, pin);
        expect(proof).toBeDefined();
        expect(approvedFor(proof, cfg)).toBe(true);
        // a config changed since proves nothing
        expect(approvedFor(proof, cloudflare(root, 'https://elsewhere.example.com'))).toBe(false);
    });

    test('a config naming another Worker or project, a half pin, or the files store: refused, the token never sent', async () => {
        const root = await scratch();
        expect(() => pinnedApproval(cloudflare(root, 'https://attacker.example.com'), pin)).toThrow(NotApproved);
        expect(() => pinnedApproval(cloudflare(root, 'https://knowledge.example.com', 'other'), pin)).toThrow(/is not the one/);
        expect(() => pinnedApproval(cloudflare(root), { [PUBLISH_URL_ENV]: 'https://knowledge.example.com' })).toThrow(/both/);
        expect(() => pinnedApproval(resolveConfig('{}', path.join(root, 'domaintrail.jsonc')), pin)).toThrow(/not "cloudflare"/);
    });
});
