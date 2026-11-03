// The journey file end to end (the plan's "The journey file"): `dt check` validates it against its schema (J001, an
// error: exit 1) and warns of a journey naming a storming or context the workspace lacks (J002, J003: exit 0); the
// session server reads it, and a change on disk — from git or another tool — reaches the pages, as `.dt` changes do.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps, runCli, startSessionServer, type SessionServer } from '@domaintrail/dt';
import { DEFAULT_AGENT_TOOLS } from '@domaintrail/agent';

const DT = 'context Billing {\n  id InvoiceId: UUID\n}\n';
const DTES = 'storming Issue "交付" {\n  event Requested\n}\n';

const journey = (over: Record<string, unknown> = {}): string =>
    `${JSON.stringify(
        {
            version: 1,
            stormings: { Issue: { purpose: '交付の流れ', participants: [], use: 'modeling', level: 'BigPicture', state: 'active', marks: [] } },
            modeling: [
                {
                    id: 'billing',
                    name: 'Billing の深掘り',
                    purpose: '請求を正す',
                    participants: [],
                    pattern: 'OneContext',
                    from: { context: 'Billing' },
                    goal: 'invariants',
                    state: 'active',
                    marks: { steps: [], contexts: {} },
                },
            ],
            ...over,
        },
        null,
        2,
    )}\n`;

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function workspace(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-journey-'));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
    return dir;
}

async function run(...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, cliDeps());
    return { code, out, err };
}

describe('dt check on domaintrail.journey.json', () => {
    test('a valid file: nothing to say; a storming or context gone: a warning (exit 0)', async () => {
        expect((await run('-r', await workspace({ 'b.dt': DT, 'i.dtes': DTES, 'domaintrail.journey.json': journey() }), 'check')).code).toBe(0);
        const gone = await workspace({
            'b.dt': DT.replace('Billing', 'Invoicing'),
            'i.dtes': DTES.replace('Issue', 'Issuance'),
            'domaintrail.journey.json': journey(),
        });
        const r = await run('-r', gone, 'check');
        expect(r.code).toBe(0);
        expect(r.out.filter((l) => l.startsWith('domaintrail.journey.json'))).toEqual([
            "domaintrail.journey.json:4:5 - warning J002: The journey 'es:Issue' names storming 'Issue', which does not exist.",
            expect.stringMatching(/^domaintrail\.journey\.json:\d+:\d+ - warning J003: The journey 'billing' names context 'Billing', which does not exist\.$/),
        ]);
    });

    test('against its schema: an error where it is (exit 1), in JSON too; generation is not blocked by it', async () => {
        const dir = await workspace({ 'b.dt': DT, 'i.dtes': DTES, 'domaintrail.journey.json': journey().replace('"invariants"', '"policies"') });
        const r = await run('-r', dir, 'check');
        expect(r.code).toBe(1);
        expect(r.err.find((l) => l.includes('J001'))).toMatch(
            /^domaintrail\.journey\.json:\d+:\d+ - error J001: modeling\[0\]\.goal: Expected one of commands, invariants\.$/,
        );
        const json: string[] = [];
        expect(await runCli(['-r', dir, 'check', '--format', 'json'], { out: (l) => json.push(l), err: () => {} }, cliDeps())).toBe(1);
        expect(JSON.parse(json.join('\n')).diagnostics).toMatchObject([{ file: 'domaintrail.journey.json', code: 'J001', severity: 'error' }]);
        expect((await run('-r', dir, 'generate', 'ts')).code).toBe(0);
    });
});

describe('the session server and the journey file', () => {
    let server: SessionServer | undefined;
    afterEach(async () => {
        await server?.stop();
        server = undefined;
    });

    test('a change on disk (git, another tool) is read again and sent to the pages', async () => {
        const root = await workspace({ 'b.dt': DT, 'i.dtes': DTES });
        server = await startSessionServer({
            root,
            debounceMs: 30,
            mode: 'Solo',
            session: {
                port: 0,
                host: '127.0.0.1',
                identity: 'dev',
                agent: { port: 0, allowedTools: [...DEFAULT_AGENT_TOOLS], maxPreviousRunDiff: 20 * 1024 },
                maxParticipants: 50,
                quickReactions: ['👍'],
                classifier: { enabled: false, provider: 'cloudflare-clef', model: 'clef-flash', apiTokenEnv: 'CLOUDFLARE_API_TOKEN', threshold: 0.5 },
            },
        });
        await server.ready;
        const link = await fetch(server.facilitatorLink, { redirect: 'manual' });
        const cookie = (link.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
        const body = async (): Promise<{ file: { modeling: unknown[] } | null }> =>
            (
                (await (await fetch(`${server?.url}api/session/journey`, { headers: { cookie } })).json()) as {
                    journey: { file: { modeling: unknown[] } | null };
                }
            ).journey;
        expect(await body()).toMatchObject({ file: null, problems: [], requests: [] });
        await writeFile(path.join(root, 'domaintrail.journey.json'), journey());
        const until = async (ok: (b: Awaited<ReturnType<typeof body>>) => boolean): Promise<void> => {
            for (let i = 0; i < 100; i++) {
                if (ok(await body())) return;
                await Bun.sleep(50);
            }
            throw new Error('the journey file was not read again');
        };
        await until((b) => b.file?.modeling.length === 1);
        await writeFile(path.join(root, 'domaintrail.journey.json'), journey({ modeling: [] }));
        await until((b) => b.file?.modeling.length === 0);
    });
});
