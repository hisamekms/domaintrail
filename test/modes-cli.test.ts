/**
 * The modes' commands (ADR 0030, plan modes M5): `dt open` (one person, the facilitator without signing in; read-only
 * on a non-loopback host; refused on an open collab session), `dt collab` (continuing a `dt open` session), `dt collab
 * link`, `dt agent` (`--role`), the agent in process (started when Claude Code is usable, skipped with a reason, or
 * not with `--no-agent`), and the removed commands and config sections.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Me, SessionStateBody } from '@domaintrail/collaboration/protocol';
import {
    type CliDeps,
    cliDeps,
    issueAgentLink,
    issueOpenLink,
    issueFacilitatorLink,
    pairAgent,
    runCli,
    SessionError,
    type SessionServer,
    type SessionServerOptions,
    startSessionServer,
} from '@domaintrail/dt';
import { DEFAULT_AGENT_TOOLS } from '@domaintrail/agent';
import {
    createSessionAccess,
    createUnitOfWork,
    FACILITATOR_NAME,
    FACILITATOR_PARTICIPANT,
    openSessionDatabase,
    randomSecrets,
    systemClock,
} from '@domaintrail/collaboration';
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

/** Opens `dt open`'s one-time link as a browser would: the cookie it sets (HttpOnly, SameSite=Strict). */
async function signInSolo(link: string): Promise<string> {
    const res = await fetch(link, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    const cookie = res.headers.get('set-cookie') ?? '';
    // a name of this server's own, a session cookie (no Max-Age), HttpOnly, SameSite=Strict
    expect(cookie).toMatch(/^dt_open_[0-9a-f]{12}=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/);
    return cookie.split(';')[0];
}

/** What the fake CLI deps were asked, and what they answer. */
interface Calls {
    view: unknown[];
    sessions: SessionServerOptionsLike[];
    agents: { roles: readonly string[]; once: boolean }[];
    connects: unknown[];
    stopped: number;
}
type SessionServerOptionsLike = Parameters<CliDeps['startSessionServer']>[0];

/** `cliDeps()` with the servers and the agent faked: the session closes at once, so the commands return. */
function fakeDeps(
    usable: Awaited<ReturnType<CliDeps['checkAgent']>>,
    opened: 'started' | 'resumed' | 'collaborated' = 'started',
): { deps: CliDeps; calls: Calls } {
    const calls: Calls = { view: [], sessions: [], agents: [], connects: [], stopped: 0 };
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
                agentToken: 'in-memory-token',
                session: 's1',
                opened,
                facilitatorLink: options.mode === 'Collab' ? 'http://127.0.0.1:1/session/facilitator?code=x' : 'http://127.0.0.1:1/session/open?code=y',
                closed: Promise.resolve(),
                stop: async () => {
                    calls.stopped++;
                },
            };
        },
        checkAgent: async () => usable,
        startAgent: async (options) => {
            calls.agents.push({ roles: options.roles, once: options.once });
            calls.connects.push(options.connect);
            return {
                session: 's1',
                roles: options.roles,
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
        for (const args of [['check'], ['open'], ['collab'], ['agent', '--code', 'x']]) {
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
        expect(r.out).toContain('Live View: http://127.0.0.1:1/session/open?code=y');
        expect(r.out).toContain(
            '  (a link for you only: opened once within 60 minutes, it signs that browser in; then http://127.0.0.1:1/; `dt open link` prints another)',
        );
        expect(r.out).toContain('Session: s1 (started, solo)');
        expect(r.out).toContain('AI: started in this process (claude 9.9.9 (Claude Code); roles answer, run)');
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
        // dt open never takes collab's port, nor its access settings
        const open = fakeDeps(USABLE);
        await writeFile(
            path.join(dir, 'domaintrail.jsonc'),
            JSON.stringify({
                open: { port: 1111 },
                collab: { identity: 'access', access: { teamDomain: 't.cloudflareaccess.com', audience: 'a', allowedHosts: ['tunnel.example.com'] } },
            }),
        );
        expect((await run(open.deps, '-r', dir, 'open')).code).toBe(0);
        expect(open.calls.sessions[0].session).toEqual(expect.objectContaining({ port: 1111, identity: 'dev' }));
        expect(open.calls.sessions[0].session.access).toBeUndefined();
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
    test('both roles by default, one with --role', async () => {
        const dir = await copy();
        const { deps, calls } = fakeDeps(USABLE);
        const both = await run(deps, '-r', dir, 'agent', '--code', 'c1', '--once');
        expect(both.code).toBe(0);
        expect(both.out).toEqual(['Agent on session s1 with claude (roles answer, run) (one run); waiting.', 'Done.']);
        expect((await run(deps, '-r', dir, 'agent', '--code', 'c2', '--url', 'http://127.0.0.1:9/', '--role', 'run')).out.at(-1)).toBe('Session closed.');
        expect(calls.connects).toEqual([{ code: 'c1' }, { code: 'c2', url: 'http://127.0.0.1:9/' }]);
        // a standalone agent pairs with a code: there is no credential file to read
        const without = await run(deps, '-r', dir, 'agent');
        expect(without.code).toBe(1);
        expect(without.err.join('\n')).toContain("required option '--code <code>' not specified");
        expect(calls.agents).toEqual([
            { roles: ['answer', 'run'], once: true },
            { roles: ['run'], once: false },
        ]);
        expect((await run(deps, '-r', dir, 'agent', '--code', 'c', '--role', 'judge')).code).toBe(1);

        const answer = await run(cliDeps(), '-r', dir, 'agent', '--code', 'c', '--role', 'answer');
        expect(answer.code).toBe(1);
        expect(answer.err).toEqual(['No session server is running for this workspace (start one with `dt open` or `dt collab`).']);
        const none = await run(cliDeps(), '-r', dir, 'agent', '--code', 'c');
        expect(none.code).toBe(1);
        expect(none.err).toEqual(['No session server is running for this workspace (start one with `dt open` or `dt collab`).']);
    });
});

describe('pairing a standalone dt agent (the credential never on disk)', () => {
    test('dt collab agent-link prints a one-time code that pairs once; expired, reused and facilitator codes are refused', async () => {
        const root = await copy();
        // what an older version left: removed when a server starts
        await mkdir(path.join(root, '.domaintrail', 'session'), { recursive: true });
        await writeFile(path.join(root, '.domaintrail', 'session', 'agent.json'), JSON.stringify({ url: 'http://127.0.0.1:1/', token: 'old' }));
        const lines: string[] = [];
        const server = await startSessionServer({ root, debounceMs: 30, mode: 'Collab', session: settings, log: (l) => lines.push(l) });
        try {
            expect(await readFile(path.join(root, '.domaintrail', 'session', 'agent.json'), 'utf8').catch(() => 'gone')).toBe('gone');
            expect(lines).toContain('Removed .domaintrail/session/agent.json (an agent credential an older version wrote).');
            const printed = await run(cliDeps(), '-r', root, 'collab', 'agent-link');
            expect(printed.code).toBe(0);
            const code = /^Agent code \(single use, expires in 10 minutes\): (\S+)$/.exec(printed.out[0])?.[1] ?? '';
            expect(printed.out.slice(1)).toEqual([`Agent API: ${server.agentUrl}`, `Run: dt agent --code ${code}`]);

            const credential = await pairAgent(root, code);
            expect(credential).toEqual({ url: server.agentUrl, token: server.agentToken, session: server.session });
            const reused = await pairAgent(root, code).catch((e: unknown) => e);
            expect(reused).toBeInstanceOf(SessionError);
            expect(String(reused)).toContain('The pairing code is unknown, used or expired');

            // a facilitator link's code is not an agent code, nor the reverse
            const facilitator = new URL(server.facilitatorLink).searchParams.get('code') ?? '';
            expect(await pairAgent(root, facilitator).catch((e: unknown) => e)).toBeInstanceOf(SessionError);
            const { code: agentCode } = await issueAgentLink(root);
            const ada = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Ada' }) });
            const cookie = (ada.headers.get('set-cookie') ?? '').split(';')[0];
            await fetch(`${server.url}session/facilitator?code=${agentCode}`, { headers: { cookie }, redirect: 'manual' });
            expect(((await (await api(server, 'me', undefined, cookie)).json()) as Me).participant.role).toBe('participant');
            expect((await pairAgent(root, agentCode, server.agentUrl)).token).toBe(server.agentToken);

            // expired
            const db = await openSessionDatabase(root);
            const access = createSessionAccess({ uow: createUnitOfWork(db), clock: systemClock, secrets: randomSecrets });
            const short = await access.issueAgentCode({ session: server.session, ttlMs: 1 });
            db.close();
            await Bun.sleep(10);
            expect(await pairAgent(root, short.ok ? short.value.code : '').catch((e: unknown) => e)).toBeInstanceOf(SessionError);
            // only to the agent API on this machine
            expect(String(await pairAgent(root, 'x', 'http://example.com:1/').catch((e: unknown) => e))).toContain('on this machine only');
            // nothing secret on disk
            expect(await readFile(path.join(root, '.domaintrail', 'session', 'agent.json'), 'utf8').catch(() => 'gone')).toBe('gone');
            expect(await readFile(path.join(root, '.domaintrail', 'session', 'server.json'), 'utf8')).not.toContain(server.agentToken);
        } finally {
            await server.stop();
        }
        // unused codes die with the server
        const again = await startSessionServer({ root, debounceMs: 30, mode: 'Collab', session: settings });
        const { code: left } = await issueAgentLink(root);
        await again.stop();
        const third = await startSessionServer({ root, debounceMs: 30, mode: 'Collab', session: settings });
        try {
            expect(await pairAgent(root, left).catch((e: unknown) => e)).toBeInstanceOf(SessionError);
        } finally {
            await third.stop();
        }
    }, 30_000);

    test('dt open agent-link pairs with a dt open server too; no server, no code', async () => {
        const root = await copy();
        expect((await run(cliDeps(), '-r', root, 'open', 'agent-link')).err).toEqual([
            'No session server is running for this workspace (start one with `dt open` or `dt collab`).',
        ]);
        const server = await start(root, 'Solo');
        try {
            const printed = await run(cliDeps(), '-r', root, 'open', 'agent-link');
            const code = /: (\S+)$/.exec(printed.out[0])?.[1] ?? '';
            expect((await pairAgent(root, code)).session).toBe(server.session);
        } finally {
            await server.stop();
        }
    });
});

describe('the modes on one workspace (decision 13)', () => {
    test('dt open: its one person signs in with the printed one-time link (a cookie), no form; nobody else is identified', async () => {
        const root = await copy();
        const server = await start(root, 'Solo');
        let firstCookie = '';
        try {
            expect([server.mode, server.opened]).toEqual(['Solo', 'started']);
            expect(server.facilitatorLink).toStartWith(`${server.url}session/open?code=`);
            // without the cookie: not identified (another local process or OS user), and no join form
            expect((await api(server, 'me')).status).toBe(401);
            const page = await fetch(server.url);
            expect(page.status).toBe(401);
            expect(await page.text()).toContain('open the link it printed');
            const joined = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Eve' }) });
            expect(joined.status).not.toBe(201);
            // the link: once, it sets an HttpOnly, SameSite=Strict cookie and goes to the Live View
            const cookie = await signInSolo(server.facilitatorLink);
            firstCookie = cookie;
            expect(((await (await api(server, 'me', undefined, cookie)).json()) as Me).participant.role).toBe('facilitator');
            expect((await fetch(server.url, { headers: { cookie } })).status).toBe(200);
            expect((await fetch(server.facilitatorLink, { redirect: 'manual' })).status).toBe(403);
            expect((await api(server, 'me', undefined, 'dt_session=' + 'x'.repeat(43))).status).toBe(401);
            expect((await api(server, 'me', undefined, `${cookie.split('=')[0]}=${'x'.repeat(43)}`)).status).toBe(401);
            // the link is not a facilitator link: the facilitator's page does not take its code
            const code = new URL(server.facilitatorLink).searchParams.get('code') ?? '';
            expect((await fetch(`${server.url}session/facilitator?code=${code}`, { headers: { cookie }, redirect: 'manual' })).status).toBe(404);
            const link = await issueFacilitatorLink(root).then(
                () => undefined,
                (e: unknown) => e,
            );
            expect(link).toBeInstanceOf(SessionError);
            expect(String(link)).toContain('The running server is `dt open`');
        } finally {
            await server.stop();
        }
        // the cookie is this server instance's only: a restart forgets it, and prints a new link
        const again = await start(root, 'Solo');
        try {
            expect((await api(again, 'me', undefined, firstCookie)).status).toBe(401);
            expect(again.facilitatorLink).not.toBe(server.facilitatorLink);
        } finally {
            await again.stop();
        }
    });

    test('dt open link prints another one-time sign-in link for the running dt open server; refused for dt collab', async () => {
        const root = await copy();
        expect((await run(cliDeps(), '-r', root, 'open', 'link')).err).toEqual(['No session server is running for this workspace (start one with `dt open`).']);
        const server = await start(root, 'Solo');
        let left = '';
        try {
            const printed = await run(cliDeps(), '-r', root, 'open', 'link');
            expect(printed.code).toBe(0);
            const link = /^Sign-in link \(single use, expires in 60 minutes\): (\S+)$/.exec(printed.out[0])?.[1] ?? '';
            expect(link).toStartWith(`${server.url}session/open?code=`);
            expect(link).not.toBe(server.facilitatorLink);
            // it signs a browser in as the printed link does, once
            const cookie = await signInSolo(link);
            expect(((await (await api(server, 'me', undefined, cookie)).json()) as Me).participant.role).toBe('facilitator');
            expect((await fetch(link, { redirect: 'manual' })).status).toBe(403);
            // the printed link still works on its own
            await signInSolo(server.facilitatorLink);
            // neither a facilitator link nor an agent code
            const { link: another } = await issueOpenLink(root);
            const code = new URL(another).searchParams.get('code') ?? '';
            expect(await pairAgent(root, code).catch((e: unknown) => e)).toBeInstanceOf(SessionError);
            expect((await fetch(another, { redirect: 'manual' })).status).toBe(303);
            // an agent code is not a sign-in link
            const { code: agentCode } = await issueAgentLink(root);
            expect((await fetch(`${server.url}session/open?code=${agentCode}`, { redirect: 'manual' })).status).toBe(403);
            // expired
            const db = await openSessionDatabase(root);
            const access = createSessionAccess({ uow: createUnitOfWork(db), clock: systemClock, secrets: randomSecrets });
            const short = await access.issueOpenCode({ session: server.session, ttlMs: 1 });
            db.close();
            await Bun.sleep(10);
            expect((await fetch(`${server.url}session/open?code=${short.ok ? short.value.code : ''}`, { redirect: 'manual' })).status).toBe(403);
            left = (await issueOpenLink(root)).link;
        } finally {
            await server.stop();
        }
        // unused links die with the server
        const again = await start(root, 'Solo');
        try {
            const code = new URL(left).searchParams.get('code') ?? '';
            expect((await fetch(`${again.url}session/open?code=${code}`, { redirect: 'manual' })).status).toBe(403);
        } finally {
            await again.stop();
        }
        // a dt collab server: refused, as dt collab link refuses a dt open one
        const collab = await start(root, 'Collab');
        try {
            const refused = await run(cliDeps(), '-r', root, 'open', 'link');
            expect(refused.code).toBe(1);
            expect(refused.err).toEqual(['The running server is `dt collab`: people join with its address, and `dt collab link` prints a facilitator link.']);
        } finally {
            await collab.stop();
        }
    }, 30_000);

    test('dt open link run as its own process, several times in a row: each link signs a browser in once', async () => {
        // the command runs beside the server, as from a terminal: its database connection is another process's
        const root = await copy();
        const server = await start(root, 'Solo');
        const linkFromAnotherProcess = (): string => {
            const r = Bun.spawnSync(['bun', path.join(ROOT, 'bin', 'dt.ts'), '-r', root, 'open', 'link']);
            expect(r.exitCode).toBe(0);
            return /^Sign-in link \(single use, expires in 60 minutes\): (\S+)$/m.exec(r.stdout.toString())?.[1] ?? '';
        };
        try {
            await signInSolo(server.facilitatorLink);
            const links = [linkFromAnotherProcess(), linkFromAnotherProcess(), linkFromAnotherProcess()];
            // issued before any is used, then one after another is used
            for (const link of links) await signInSolo(link);
            for (const link of [linkFromAnotherProcess(), linkFromAnotherProcess()]) await signInSolo(link);
            // a used link stays used
            for (const link of links) expect((await fetch(link, { redirect: 'manual' })).status).toBe(403);
            // and an expired one is refused
            const db = await openSessionDatabase(root);
            const access = createSessionAccess({ uow: createUnitOfWork(db), clock: systemClock, secrets: randomSecrets });
            const short = await access.issueOpenCode({ session: server.session, ttlMs: 1 });
            db.close();
            await Bun.sleep(10);
            expect((await fetch(`${server.url}session/open?code=${short.ok ? short.value.code : ''}`, { redirect: 'manual' })).status).toBe(403);
        } finally {
            await server.stop();
        }
    }, 30_000);

    test('dt open answers loopback only, whatever collab.access allows', async () => {
        const root = await copy();
        const server = await startSessionServer({
            root,
            debounceMs: 30,
            mode: 'Solo',
            session: {
                ...settings,
                access: {
                    teamDomain: 't.cloudflareaccess.com',
                    audience: 'a',
                    allowedHosts: ['tunnel.example.com'],
                    allowedOrigins: ['https://tunnel.example.com'],
                    acceptCookie: false,
                    avatarHosts: [],
                },
            },
        });
        try {
            const cookie = await signInSolo(server.facilitatorLink);
            expect((await api(server, 'me', undefined, cookie)).status).toBe(200);
            const tunnel = await fetch(`${server.url}api/session/me`, { headers: { cookie, host: 'tunnel.example.com' } });
            expect(tunnel.status).toBe(403);
            const origin = await fetch(`${server.url}api/session/requests`, {
                method: 'POST',
                headers: { cookie, ...json, origin: 'https://tunnel.example.com' },
                body: JSON.stringify({ targets: [], body: 'x' }),
            });
            expect(origin.status).toBe(403);
        } finally {
            await server.stop();
        }
    });

    test('one live server per workspace; a dt open server identifies no one once its session is no longer Solo', async () => {
        const root = await copy();
        const solo = await start(root, 'Solo');
        try {
            const cookie = await signInSolo(solo.facilitatorLink);
            const second = await start(root, 'Collab').then(
                () => undefined,
                (e: unknown) => e,
            );
            expect(second).toBeInstanceOf(SessionError);
            expect(String(second)).toContain('A session server is already running for this workspace');
            const cli = await run(cliDeps(), '-r', root, 'collab', '--no-agent', '--port', '0');
            expect(cli.code).toBe(1);
            expect(cli.err[0]).toStartWith('A session server is already running for this workspace');
            // the session continued as Collab behind the Solo server's back: it fails closed
            const continued = await solo.collaboration.openSession({ mode: 'Collab', facilitator: FACILITATOR_PARTICIPANT, name: FACILITATOR_NAME });
            expect(continued.ok && continued.value.opened).toBe('collaborated');
            expect((await api(solo, 'me', undefined, cookie)).status).toBe(401);
        } finally {
            await solo.stop();
        }
        // stopped, the workspace can be served again
        const again = await start(root, 'Collab');
        await again.stop();
    });

    test('dt open refuses a workspace with an open collab session; dt collab continues a dt open session with its history', async () => {
        const root = await copy();
        const solo = await start(root, 'Solo');
        const soloCookie = await signInSolo(solo.facilitatorLink);
        const sent = await api(solo, 'requests', { targets: [], body: 'Rename Order to 受注.' }, soloCookie);
        expect(sent.status).toBe(201);
        await solo.stop();

        const collab = await start(root, 'Collab');
        try {
            expect([collab.mode, collab.opened, collab.resumed, collab.session]).toEqual(['Collab', 'collaborated', true, solo.session]);
            // the history stays
            expect((await api(collab, 'me')).status).toBe(401);
            // dt open's cookie and link are worth nothing here: the person takes the facilitator link dt collab prints
            expect((await api(collab, 'me', undefined, soloCookie)).status).toBe(401);
            const join = await fetch(`${collab.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Ada' }) });
            const cookie = (join.headers.get('set-cookie') ?? '').split(';')[0];
            const soloCode = new URL(solo.facilitatorLink).searchParams.get('code') ?? '';
            await fetch(`${collab.url}session/facilitator?code=${soloCode}`, { headers: { cookie }, redirect: 'manual' });
            expect(((await (await api(collab, 'me', undefined, cookie)).json()) as Me).participant.role).toBe('participant');
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
        const realRoot = await realpath(root);
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
            const link = await listening.promise;
            const server = { url: new URL('/', link).href };
            const cookie = await signInSolo(link);
            expect(out).toContain('AI: started in this process (claude 9.9.9 (Claude Code); roles answer, run)');
            const sent = (await (await api(server, 'requests', { targets: [], body: '返品の取り消しを足してください' }, cookie)).json()) as {
                request: { id: string };
            };
            const queued = await api(server, 'runs', { requests: [sent.request.id] }, cookie);
            expect(queued.status).toBe(201);
            let state: SessionStateBody | undefined;
            for (let i = 0; i < 200; i++) {
                state = (await (await api(server, 'state', undefined, cookie)).json()) as SessionStateBody;
                if (state.runs.some((r) => r.state === 'Completed' || r.state === 'Failed')) break;
                await Bun.sleep(100);
            }
            expect(state?.runs.map((r) => r.state)).toEqual(['Completed']);
            expect(await readFile(path.join(root, returns), 'utf8')).toContain('ReturnCancelled');
            // the runner ran once in the workspace (the answerer, in its view, triaged the message: every one is addressed in Solo)
            const invocations = (await readFile(`${planFile}.log`, 'utf8'))
                .split('\n')
                .filter(Boolean)
                .map((l) => JSON.parse(l) as { cwd: string });
            expect(invocations.filter((i) => i.cwd === realRoot)).toHaveLength(1);
            expect((await api(server, 'close', {}, cookie)).status).toBe(200);
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
