/**
 * The modes' commands (ADR 0030, plan modes M5): `dt open` (one person, the facilitator without signing in; read-only
 * on a non-loopback host; refused on an open collab session), `dt collab` (continuing a `dt open` session), `dt collab
 * link`, `dt agent` (`--role`), the agent in process (started when Claude Code is usable, skipped with a reason, or
 * not with `--no-agent`), and the removed commands and config sections.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Me, SessionStateBody } from '@domaintrail/collaboration/protocol';
import {
    type CliDeps,
    cliDeps,
    issueFacilitatorLink,
    runCli,
    SessionError,
    type SessionServer,
    type SessionServerOptions,
    startSessionServer,
} from '@domaintrail/dt';
import { DEFAULT_AGENT_TOOLS } from '@domaintrail/agent';
import { tempCopyOfExamples } from './helpers.js';

const ROOT = path.join(import.meta.dir, '..');
const FAKE = path.join(import.meta.dir, 'fixtures', 'agent', 'fake-claude.mjs');

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function copy(): Promise<string> {
    const dir = await tempCopyOfExamples();
    dirs.push(dir);
    return dir;
}

type Run = { code: number; out: string[]; err: string[] };

async function run(deps: CliDeps, ...args: string[]): Promise<Run> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, deps);
    return { code, out, err };
}

const settings: SessionServerOptions['session'] = {
    port: 0,
    host: '127.0.0.1',
    identity: 'dev',
    agent: { port: 0, allowedTools: [...DEFAULT_AGENT_TOOLS], maxPreviousRunDiff: 20 * 1024 },
    maxParticipants: 50,
    quickReactions: ['👍'],
    classifier: { enabled: false, provider: 'cloudflare-clef', model: 'clef-flash', apiTokenEnv: 'CLOUDFLARE_API_TOKEN', threshold: 0.5 },
};

const start = (root: string, mode: 'Solo' | 'Collab'): Promise<SessionServer> => startSessionServer({ root, debounceMs: 30, mode, session: settings });

const json = { 'content-type': 'application/json' };

/** A call of the session API, with `cookie` if given (none: `dt open`'s one person). */
const api = (server: { url: string }, p: string, body?: unknown, cookie?: string): Promise<Response> =>
    fetch(`${server.url}api/session/${p}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(cookie && { cookie }), ...(body !== undefined && json) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
    });

/** What the fake CLI deps were asked, and what they answer. */
interface Calls {
    view: unknown[];
    sessions: SessionServerOptionsLike[];
    agents: { roles: readonly string[]; once: boolean }[];
    stopped: number;
}
type SessionServerOptionsLike = Parameters<CliDeps['startSessionServer']>[0];

/** `cliDeps()` with the servers and the agent faked: the session closes at once, so the commands return. */
function fakeDeps(
    usable: Awaited<ReturnType<CliDeps['checkAgent']>>,
    opened: 'started' | 'resumed' | 'collaborated' = 'started',
): { deps: CliDeps; calls: Calls } {
    const calls: Calls = { view: [], sessions: [], agents: [], stopped: 0 };
    const deps: CliDeps = {
        ...cliDeps(),
        startViewServer: async (options) => {
            calls.view.push(options);
            // read-only and never ending: a system error (reported as one line) stands in for the server here
            throw Object.assign(new Error('stop here'), { code: 'EACCES' });
        },
        startSessionServer: async (options) => {
            calls.sessions.push(options);
            return {
                url: 'http://127.0.0.1:1/',
                agentUrl: 'http://127.0.0.1:2/',
                session: 's1',
                opened,
                ...(options.mode === 'Collab' && { facilitatorLink: 'http://127.0.0.1:1/session/facilitator?code=x' }),
                closed: Promise.resolve(),
                stop: async () => {
                    calls.stopped++;
                },
            };
        },
        checkAgent: async () => usable,
        startAgent: async (options) => {
            calls.agents.push({ roles: options.roles, once: options.once });
            return {
                session: 's1',
                roles: options.roles.filter((r) => r === 'run'),
                done: Promise.resolve(options.once ? ('once' as const) : ('closed' as const)),
                stop: async () => 'stopped',
            };
        },
    };
    return { deps, calls };
}

const USABLE = { ok: true, version: '9.9.9 (Claude Code)' } as const;
const MISSING = { ok: false, reason: 'claude not found on PATH' } as const;

describe('removed commands and sections', () => {
    test.each([
        [['view'], "'dt view' was removed; use 'dt open' (or 'dt open --host <address>' for a read-only Live View)"],
        [['view', '--port', '8080', '--base', 'main'], "'dt view' was removed; use 'dt open'"],
        [['session'], "'dt session' was removed; use 'dt collab' (start), 'dt collab link' or 'dt agent'"],
        [['session', 'start', '--port', '0'], "'dt session start' was removed; use 'dt collab'"],
        [['session', 'link'], "'dt session link' was removed; use 'dt collab link'"],
        [['session', 'subscribe', '--agent', 'claude', '--once'], "'dt session subscribe' was removed; use 'dt agent'"],
        [['view', '--help'], "'dt view' was removed"],
    ])('dt %p is an error naming its replacement (exit 2), not an alias', async (args, message) => {
        const r = await run(cliDeps(), ...args);
        expect(r.code).toBe(2);
        expect(r.out).toEqual([]);
        expect(r.err).toHaveLength(1);
        expect(r.err[0]).toStartWith(message);
    });

    test('the help lists the new commands, not the removed ones', async () => {
        const r = await run(cliDeps(), '--help');
        const commands = r.out
            .join('\n')
            .split('Commands:')[1]
            .split('\n')
            .map((l) => /^ {2}(\S+)/.exec(l)?.[1])
            .filter(Boolean);
        expect(commands).toEqual(expect.arrayContaining(['open', 'collab', 'agent']));
        expect(commands).not.toContain('view');
        expect(commands).not.toContain('session');
    });

    test('a config with session or view is refused at load, by every command that reads it (exit 2)', async () => {
        const dir = await copy();
        await writeFile(path.join(dir, 'domaintrail.jsonc'), JSON.stringify({ session: { port: 5000, agent: { allowedTools: ['Read'] } } }));
        for (const args of [['check'], ['open'], ['collab'], ['agent']]) {
            const r = await run(cliDeps(), '-r', dir, ...args);
            expect(r.code).toBe(2);
            expect(r.err).toEqual([
                `${path.join(dir, 'domaintrail.jsonc')}: 'session' was renamed: move session.port to collab; session.agent.allowedTools to agent.run.allowedTools`,
            ]);
        }
        await writeFile(path.join(dir, 'domaintrail.jsonc'), JSON.stringify({ view: { port: 8080 } }));
        expect((await run(cliDeps(), '-r', dir, 'open')).err).toEqual([
            `${path.join(dir, 'domaintrail.jsonc')}: 'view' was renamed to 'open': move view.port to open.port`,
        ]);
    });
});

describe('dt open and dt collab: the agent in process', () => {
    test('dt open: a Solo session on open.port, no facilitator link; the agent started with both roles when Claude Code is usable', async () => {
        const dir = await copy();
        const { deps, calls } = fakeDeps(USABLE);
        const r = await run(deps, '-r', dir, 'open');
        expect(r.code).toBe(0);
        expect(calls.sessions).toHaveLength(1);
        expect(calls.sessions[0]).toMatchObject({ mode: 'Solo', session: { port: 4321, host: '127.0.0.1', identity: 'dev' } });
        expect(calls.agents).toEqual([{ roles: ['answer', 'run'], once: false }]);
        expect(r.out).toContain('Live View: http://127.0.0.1:1/');
        expect(r.out).toContain('Session: s1 (started, solo)');
        expect(r.out).toContain('AI: started in this process (claude 9.9.9 (Claude Code); role run)');
        expect(r.out.join('\n')).not.toContain('Facilitator link');
        expect(r.out.at(-1)).toBe('Session closed.');
    });

    test('dt collab: a Collab session on collab.port with its link; continuing a dt open session says so', async () => {
        const dir = await copy();
        await writeFile(path.join(dir, 'domaintrail.jsonc'), JSON.stringify({ open: { port: 1111 }, collab: { port: 2222 } }));
        const { deps, calls } = fakeDeps(USABLE, 'collaborated');
        const r = await run(deps, '-r', dir, 'collab', '--port', '3333');
        expect(r.code).toBe(0);
        expect(calls.sessions[0]).toMatchObject({ mode: 'Collab', session: { port: 3333 } });
        expect(r.out).toContain('Session: s1 (continued from dt open, identity dev)');
        expect(r.out).toContain('Facilitator link (single use, expires in 10 minutes): http://127.0.0.1:1/session/facilitator?code=x');
        expect(calls.agents).toHaveLength(1);
        expect((await run(fakeDeps(USABLE).deps, '-r', dir, 'open')).out).toContain('Live View: http://127.0.0.1:1/');
    });

    test('without a usable Claude Code the server starts without the agent, with one line why; --no-agent does not try', async () => {
        const dir = await copy();
        for (const command of ['open', 'collab']) {
            const missing = fakeDeps(MISSING);
            const r = await run(missing.deps, '-r', dir, command);
            expect(r.code).toBe(0);
            expect(missing.calls.agents).toEqual([]);
            expect(r.out.filter((l) => l.startsWith('AI:'))).toEqual(['AI: not started (claude not found on PATH); start it later with `dt agent`']);

            const off = fakeDeps(USABLE);
            const n = await run(off.deps, '-r', dir, command, '--no-agent');
            expect(n.code).toBe(0);
            expect(off.calls.agents).toEqual([]);
            expect(n.out.filter((l) => l.startsWith('AI:'))).toEqual(['AI: not started (--no-agent); start it with `dt agent`']);
        }
    });

    test('--agent claude makes an unusable Claude Code an error, and stops the server', async () => {
        const dir = await copy();
        const { deps, calls } = fakeDeps(MISSING);
        const r = await run(deps, '-r', dir, 'open', '--agent', 'claude');
        expect(r.code).toBe(1);
        expect(r.err).toEqual(['AI: cannot start: claude not found on PATH']);
        expect(calls.stopped).toBe(1);
        expect((await run(deps, '-r', dir, 'open', '--agent', 'other')).code).toBe(1);
    });

    test('dt open --host <non-loopback> serves the Live View read-only: no session, no agent', async () => {
        const dir = await copy();
        const { deps, calls } = fakeDeps(USABLE);
        const r = await run(deps, '-r', dir, 'open', '--host', '0.0.0.0', '--port', '0');
        expect(calls.view).toHaveLength(1);
        expect(calls.sessions).toEqual([]);
        expect(calls.agents).toEqual([]);
        expect(r.err).toEqual(['stop here']);
        const explicit = await run(deps, '-r', dir, 'open', '--host', '0.0.0.0', '--agent', 'claude');
        expect(explicit.err).toEqual(['No agent with a read-only Live View: 0.0.0.0 is not a loopback address.']);
    });
});

describe('dt agent', () => {
    test('both roles by default, one with --role; the answerer alone is not available yet', async () => {
        const dir = await copy();
        const { deps, calls } = fakeDeps(USABLE);
        const both = await run(deps, '-r', dir, 'agent', '--once');
        expect(both.code).toBe(0);
        expect(both.out).toEqual(['Agent on session s1 with claude (role run) (one run); waiting.', 'Done.']);
        expect((await run(deps, '-r', dir, 'agent', '--role', 'run')).out.at(-1)).toBe('Session closed.');
        expect(calls.agents).toEqual([
            { roles: ['answer', 'run'], once: true },
            { roles: ['run'], once: false },
        ]);
        expect((await run(deps, '-r', dir, 'agent', '--role', 'judge')).code).toBe(1);

        const answer = await run(cliDeps(), '-r', dir, 'agent', '--role', 'answer');
        expect(answer.code).toBe(1);
        expect(answer.err).toEqual(['The answerer role is not available yet: run `dt agent` or `dt agent --role run`.']);
        const none = await run(cliDeps(), '-r', dir, 'agent');
        expect(none.code).toBe(1);
        expect(none.err).toEqual(['No session server is running for this workspace (start one with `dt open` or `dt collab`).']);
    });
});

describe('the modes on one workspace (decision 13)', () => {
    test('dt open: its one person is the facilitator without a form or a link; no one else joins', async () => {
        const root = await copy();
        const server = await start(root, 'Solo');
        try {
            expect([server.mode, server.opened, server.facilitatorLink]).toEqual(['Solo', 'started', '']);
            const me = (await (await api(server, 'me')).json()) as Me;
            expect(me.participant.role).toBe('facilitator');
            expect((await fetch(server.url)).status).toBe(200);
            const joined = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Eve' }) });
            expect(joined.status).not.toBe(201);
            const link = await issueFacilitatorLink(root).then(
                () => undefined,
                (e: unknown) => e,
            );
            expect(link).toBeInstanceOf(SessionError);
            expect(String(link)).toContain('The running server is `dt open`');
        } finally {
            await server.stop();
        }
    });

    test('dt open refuses a workspace with an open collab session; dt collab continues a dt open session with its history', async () => {
        const root = await copy();
        const solo = await start(root, 'Solo');
        const sent = await api(solo, 'requests', { targets: [], body: 'Rename Order to 受注.' });
        expect(sent.status).toBe(201);
        await solo.stop();

        const collab = await start(root, 'Collab');
        try {
            expect([collab.mode, collab.opened, collab.resumed, collab.session]).toEqual(['Collab', 'collaborated', true, solo.session]);
            // the history stays; the person needs the facilitator link now (or signs in as anyone else would)
            expect((await api(collab, 'me')).status).toBe(401);
            const join = await fetch(`${collab.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Ada' }) });
            const cookie = (join.headers.get('set-cookie') ?? '').split(';')[0];
            const state = (await (await fetch(`${collab.url}api/session/state`, { headers: { cookie } })).json()) as SessionStateBody;
            expect(state.requests.map((r) => r.body)).toEqual(['Rename Order to 受注.']);
            expect(collab.facilitatorLink).toStartWith(`${collab.url}session/facilitator?code=`);
        } finally {
            await collab.stop();
        }

        const refused = await start(root, 'Solo').then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(refused).toBeInstanceOf(SessionError);
        expect(String(refused)).toContain('This workspace has an open collab session: resume it with `dt collab`');
        const cli = await run(cliDeps(), '-r', root, 'open', '--no-agent', '--port', '0');
        expect(cli.code).toBe(1);
        expect(cli.err).toEqual(['This workspace has an open collab session: resume it with `dt collab`, or end it from its collab menu before `dt open`.']);
    }, 30_000);
});

describe('the agent in process, with a fake claude on the PATH', () => {
    /** A `claude` that answers --version and --help as Claude Code does, and runs the fake agent with `plan` otherwise. */
    async function fakeClaude(plan: object): Promise<{ bin: string; planFile: string }> {
        const bin = await mkdtemp(path.join(tmpdir(), 'domaintrail-modes-bin-'));
        dirs.push(bin);
        const planFile = path.join(bin, 'plan.json');
        await writeFile(planFile, JSON.stringify(plan));
        const claude = path.join(bin, 'claude');
        await writeFile(
            claude,
            [
                '#!/bin/sh',
                'case "$1" in',
                '  --version) echo "9.9.9 (Claude Code)"; exit 0;;',
                '  --help) echo "--setting-sources --strict-mcp-config --tools --allowedTools --input-format --model dontAsk"; exit 0;;',
                'esac',
                `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} ${JSON.stringify(planFile)} "$@"`,
                '',
            ].join('\n'),
        );
        await chmod(claude, 0o755);
        return { bin, planFile };
    }

    test('dt open starts the agent in process: a run queued in the page is carried out by it; closing the session ends both', async () => {
        const root = await copy();
        // the agent's dt (and dt fmt / dt check after a run): this repository's, outside the workspace
        await writeFile(
            path.join(root, 'domaintrail.jsonc'),
            JSON.stringify({ agent: { run: { dt: ['bun', path.join(ROOT, 'bin', 'dt.ts')], warm: false } } }),
        );
        const returns = 'stormings/returns.dtes';
        const { bin, planFile } = await fakeClaude({
            runs: [
                {
                    edits: [
                        {
                            path: returns,
                            replace: [
                                '  event ItemDisposed "商品を廃棄した"\n',
                                '  event ItemDisposed "商品を廃棄した"\n  event ReturnCancelled "返品を取り消した"\n',
                            ],
                        },
                    ],
                },
            ],
        });
        const PATH = process.env.PATH;
        process.env.PATH = `${bin}${path.delimiter}${PATH ?? ''}`;
        const out: string[] = [];
        let url: string | undefined;
        const listening = Promise.withResolvers<string>();
        const done = runCli(
            ['-r', root, 'open', '--port', '0'],
            {
                out: (l) => {
                    out.push(l);
                    url ??= /^Live View: (\S+)/.exec(l)?.[1];
                    if (url && l.startsWith('AI: started')) listening.resolve(url);
                },
                err: (l) => out.push(l),
            },
            cliDeps(),
        );
        try {
            const server = { url: await listening.promise };
            expect(out).toContain('AI: started in this process (claude 9.9.9 (Claude Code); role run)');
            const sent = (await (await api(server, 'requests', { targets: [], body: '返品の取り消しを足してください' })).json()) as { request: { id: string } };
            const queued = await api(server, 'runs', { requests: [sent.request.id] });
            expect(queued.status).toBe(201);
            let state: SessionStateBody | undefined;
            for (let i = 0; i < 200; i++) {
                state = (await (await api(server, 'state')).json()) as SessionStateBody;
                if (state.runs.some((r) => r.state === 'Completed' || r.state === 'Failed')) break;
                await Bun.sleep(100);
            }
            expect(state?.runs.map((r) => r.state)).toEqual(['Completed']);
            expect(await readFile(path.join(root, returns), 'utf8')).toContain('ReturnCancelled');
            expect((await readFile(`${planFile}.log`, 'utf8')).split('\n').filter(Boolean)).toHaveLength(1);
            expect((await api(server, 'close', {})).status).toBe(200);
            expect(await done).toBe(0);
            expect(out.at(-1)).toBe('Session closed.');
        } finally {
            process.env.PATH = PATH;
        }
    }, 60_000);

    test('a claude that does not answer as Claude Code does is skipped with the reason', async () => {
        const root = await copy();
        const bin = await mkdtemp(path.join(tmpdir(), 'domaintrail-modes-bin-'));
        dirs.push(bin);
        await writeFile(path.join(bin, 'claude'), '#!/bin/sh\necho "1.0.0"\n');
        await chmod(path.join(bin, 'claude'), 0o755);
        const PATH = process.env.PATH;
        process.env.PATH = `${bin}${path.delimiter}${PATH ?? ''}`;
        try {
            const usable = await cliDeps().checkAgent('claude');
            expect(usable).toEqual({ ok: false, reason: expect.stringContaining('claude does not know --setting-sources') });
        } finally {
            process.env.PATH = PATH;
        }
        // the same with the commands: skipped with the reason, the server served without it
        const { deps, calls } = fakeDeps({ ok: false, reason: 'claude does not know --tools (update Claude Code)' });
        const r = await run(deps, '-r', root, 'collab');
        expect(r.out).toContain('AI: not started (claude does not know --tools (update Claude Code)); start it later with `dt agent`');
        expect(calls.agents).toEqual([]);
    });
});
