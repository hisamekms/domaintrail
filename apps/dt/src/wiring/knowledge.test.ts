// The one factory of the knowledge store: `files` in `<root>/knowledge` with its state in `<state>/knowledge`, and
// `cloudflare` at `knowledge.url` with the environment's service token (refused, in one line, without one), only with
// the proof that the workspace's settings — the URL among them — are approved as they are now.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Knowledge, projectFromDirName } from '@domaintrail/knowledge';
import { resolveConfig, type ResolvedConfig } from '../config/config.js';
import { approveSettings, checkApproved, type SettingsApproval, type TrustStore } from '../cli/trust.js';
import { analyzeStormings } from '@domaintrail/storming';
import { Collaboration, readJourney } from '@domaintrail/collaboration';
import type { Presence } from '@domaintrail/collaboration/protocol';
import { journeyStormings, knowledgeForAgents, NOT_APPROVED, openKnowledgeStore, stickyFocus } from './knowledge.js';

const made = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
};

let root: string;
let state: string;
beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'domaintrail-knowledge-store-'));
    state = await mkdtemp(path.join(tmpdir(), 'domaintrail-knowledge-state-'));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
});

/** The config of the workspace at `root` with `knowledge` as its section. */
const config = (knowledge: object = {}): ResolvedConfig => resolveConfig(JSON.stringify({ knowledge }), path.join(root, 'domaintrail.jsonc'));
/** Approved without a trust store (a test's dependencies). */
const approved = (cfg: ResolvedConfig): Promise<SettingsApproval | undefined> => checkApproved(cfg, undefined);

/** Approvals kept in memory. */
function memoryTrust(): TrustStore {
    const kept = new Map<string, string>();
    return { approved: async (w) => kept.get(w), approve: async (w, h) => void kept.set(w, h) };
}

/** A fetch that records its requests and answers an empty page. */
function recordingFetch(): { fetch: typeof globalThis.fetch; seen: Request[] } {
    const seen: Request[] = [];
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stand-in with fetch's call signature only
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push(new Request(input, init));
        return Response.json({ items: [] });
    }) as typeof globalThis.fetch;
    return { fetch, seen };
}

const TOKEN = { DOMAINTRAIL_KNOWLEDGE_CLIENT_ID: 'id.access', DOMAINTRAIL_KNOWLEDGE_CLIENT_SECRET: 'secret' };
const cloudflare = (url = 'https://knowledge.example.com'): object => ({ store: 'cloudflare', project: 'shop', url });
const noState = { stateDir: (): Promise<string> => Promise.reject(new Error('the state directory is not opened for cloudflare')) };

describe('openKnowledgeStore', () => {
    test('files: the items in <root>/knowledge, the deleted ones in <state>/knowledge, the project of the config', async () => {
        const opened = await openKnowledgeStore(config({ project: 'shop' }), undefined, { stateDir: async () => state });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const { store, project, kind, sweep } = opened.value;
        expect(kind).toBe('files');
        expect(project).toBe(made(Knowledge.makeProjectName('shop')));
        expect(sweep).toBeFunction();
        // nothing is made until a call writes
        expect(await readdir(root)).toEqual([]);
        const id = made(Knowledge.makeKnowledgeItemId('kn_00000001'));
        await store.applyExtraction(project, {
            by: { session: made(Knowledge.makeSessionRef('s1')), number: made(Knowledge.makeExtractionNumber(1)) },
            operations: [
                {
                    kind: 'Add',
                    id,
                    content: {
                        text: made(Knowledge.makeItemText('A finding.')),
                        labels: { when: 'as_is', kind: 'rule', origin: 'said' },
                        about: [made(Knowledge.makeStickyRef('Ordering.Placed'))],
                    },
                    sources: [
                        {
                            session: made(Knowledge.makeSessionRef('s1')),
                            message: made(Knowledge.makeMessageRef('m1')),
                            at: new Date('2026-11-05T09:00:00Z'),
                            quote: made(Knowledge.makeQuote('so it is')),
                        },
                    ],
                },
            ],
        });
        expect(await readdir(path.join(root, 'knowledge'))).toContain('kn_00000001.md');
        await store.delete(project, id, made(Knowledge.makeUserName('alice@example.com')));
        expect(await readdir(path.join(state, 'knowledge', 'deleted'))).toEqual(['kn_00000001.md']);
    });

    test('files without a project: the one named after the workspace directory', async () => {
        const opened = await openKnowledgeStore(config(), undefined, { stateDir: async () => state });
        expect(opened.ok && opened.value.project).toBe(projectFromDirName(path.basename(root)));
    });

    test('cloudflare, approved: the Worker at knowledge.url, with the service token of the environment', async () => {
        const cfg = config(cloudflare());
        const { fetch, seen } = recordingFetch();
        const opened = await openKnowledgeStore(cfg, await approved(cfg), { ...noState, env: TOKEN, fetch });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        expect(opened.value.kind).toBe('cloudflare');
        expect(opened.value.sweep).toBeUndefined();
        await opened.value.store.search(opened.value.project, {});
        expect(seen).toHaveLength(1);
        expect(new URL(seen[0].url).origin).toBe('https://knowledge.example.com');
        expect(seen[0].headers.get('CF-Access-Client-Id')).toBe('id.access');
        expect(seen[0].headers.get('CF-Access-Client-Secret')).toBe('secret');
    });

    test('cloudflare after knowledge.url changed without approving again: refused, no token sent anywhere', async () => {
        const trust = memoryTrust();
        const before = config(cloudflare());
        const proof = await approveSettings(before, { trust, out: () => {} }, true);
        expect(await checkApproved(before, trust)).toBeDefined();
        // a commit points the Worker elsewhere
        const after = config(cloudflare('https://attacker.example.net'));
        const { fetch, seen } = recordingFetch();
        const refused = { ok: false, error: { type: 'KnowledgeStoreUnavailable', store: 'cloudflare', message: NOT_APPROVED } } as const;
        // as dt mcp asks: the settings now are not the ones approved
        expect(await checkApproved(after, trust)).toBeUndefined();
        expect(await openKnowledgeStore(after, await checkApproved(after, trust), { ...noState, env: TOKEN, fetch })).toEqual(refused);
        // the proof of the approval before the change proves nothing for the new URL; nor does a look-alike object
        expect(await openKnowledgeStore(after, proof, { ...noState, env: TOKEN, fetch })).toEqual(refused);
        expect(
            await openKnowledgeStore(after, { root, knowledge: { url: 'https://attacker.example.net', project: 'shop' } }, { ...noState, env: TOKEN, fetch }),
        ).toEqual(refused);
        expect(await openKnowledgeStore(after, undefined, { ...noState, env: TOKEN, fetch })).toEqual(refused);
        expect(seen).toEqual([]);
    });

    test('cloudflare without a service token: the variables to set, in one line (none needed on loopback)', async () => {
        const cfg = config(cloudflare());
        const opened = await openKnowledgeStore(cfg, await approved(cfg), { ...noState, env: { DOMAINTRAIL_KNOWLEDGE_CLIENT_ID: 'id.access' } });
        expect(opened).toEqual({
            ok: false,
            error: {
                type: 'KnowledgeStoreUnavailable',
                store: 'cloudflare',
                message: "the knowledge store 'cloudflare' needs an Access service token: set DOMAINTRAIL_KNOWLEDGE_CLIENT_SECRET",
            },
        });
        const local = config(cloudflare('http://localhost:8787'));
        expect((await openKnowledgeStore(local, await approved(local), { ...noState, env: {} })).ok).toBe(true);
    });
});

describe('knowledgeForAgents', () => {
    test('files: usable once knowledge/ exists; before, quietly not (nothing to read yet)', async () => {
        expect(knowledgeForAgents(config(), undefined)).toEqual({ usable: false, reason: 'no knowledge/ in the workspace', quiet: true });
        await mkdir(path.join(root, 'knowledge'));
        expect(knowledgeForAgents(config(), undefined)).toEqual({ usable: true });
    });

    test('cloudflare: only approved as it is now and with a service token (none needed on loopback), as openKnowledgeStore opens it', async () => {
        const cfg = config(cloudflare());
        expect(knowledgeForAgents(cfg, await approved(cfg), TOKEN)).toEqual({ usable: true });
        expect(knowledgeForAgents(cfg, undefined, TOKEN)).toEqual({ usable: false, reason: NOT_APPROVED });
        // approved before knowledge.url changed: proves nothing
        const moved = config(cloudflare('https://attacker.example.net'));
        expect(knowledgeForAgents(moved, await approved(cfg), TOKEN)).toEqual({ usable: false, reason: NOT_APPROVED });
        const without = knowledgeForAgents(cfg, await approved(cfg), {});
        expect(without.usable).toBe(false);
        expect(!without.usable && without.reason).toContain('DOMAINTRAIL_KNOWLEDGE_CLIENT_ID');
        const local = config(cloudflare('http://127.0.0.1:8787'));
        expect(knowledgeForAgents(local, await approved(local), {})).toEqual({ usable: true });
    });
});

describe('what the session looks at, for the stickies of an extraction', () => {
    const DTES = `storming Ordering "注文" {
  actor Customer "お客さま"
  event Placed "注文された"
  hotspot Q "締めは？" {
    on Placed
  }
  timeline Main "本線" {
    Placed
  }
}
storming Returns "返品" {
  event Requested "返品が依頼された"
}
`;
    const page = (role: 'facilitator' | 'participant', location: Presence['location']): Pick<Presence, 'participant' | 'location'> => ({
        participant: { id: made(Collaboration.makeParticipantId(`dev:${role}`)), name: role, role },
        location,
    });
    const onStorming = (stormingId: string): Presence['location'] => ({ kind: 'dtes', stormingId, level: 'big-picture', layoutKey: 'k' });
    const onModel: Presence['location'] = { kind: 'dt', viewKey: 'structure', layoutKey: 'k' };

    test("every storming's stickies (not its timelines), the storming the facilitator's page has open, else any page's", async () => {
        const { stormings } = await analyzeStormings([{ path: 'shop.dtes', text: DTES }], undefined);
        const focus = stickyFocus(stormings, [page('participant', onStorming('Returns')), page('facilitator', onStorming('Ordering'))], ['Returns']);
        expect<unknown>(focus.stormings).toEqual([
            {
                id: 'Ordering',
                stickies: [
                    { local: 'Customer', label: 'お客さま', kind: 'actor' },
                    { local: 'Placed', label: '注文された', kind: 'event' },
                    { local: 'Q', label: '締めは？', kind: 'hotspot' },
                ],
            },
            { id: 'Returns', stickies: [{ local: 'Requested', label: '返品が依頼された', kind: 'event' }] },
        ]);
        expect<unknown>([focus.open, focus.journey]).toEqual([['Ordering'], ['Returns']]);
        expect<unknown>(stickyFocus(stormings, [page('facilitator', onModel), page('participant', onStorming('Returns'))], []).open).toEqual(['Returns']);
        expect<unknown>(stickyFocus(stormings, [], []).open).toEqual([]);
    });

    test("the current journey's stormings: the one chosen, else the most recent active one; none without a file", () => {
        const { file, problems } = readJourney(
            JSON.stringify({
                version: 1,
                stormings: { Ordering: { purpose: 'p', participants: [], use: 'modeling', level: 'BigPicture', state: 'active', marks: [] } },
                modeling: [
                    {
                        id: 'carve',
                        name: 'n',
                        purpose: 'p',
                        participants: [],
                        pattern: 'FromStorming',
                        from: { stormings: ['Ordering', 'Returns'] },
                        goal: 'invariants',
                        state: 'active',
                        marks: { steps: [], contexts: {} },
                    },
                ],
            }),
        );
        expect<unknown>(problems).toEqual([]);
        expect<unknown>(journeyStormings(file, undefined)).toEqual(['Ordering', 'Returns']);
        expect<unknown>(journeyStormings(file, 'es:Ordering')).toEqual(['Ordering']);
        expect<unknown>(journeyStormings(undefined, 'es:Ordering')).toEqual([]);
    });
});
