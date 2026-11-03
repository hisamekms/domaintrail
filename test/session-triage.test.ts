/**
 * Messages addressed to the AI, their triage and the answerer role (ADR 0030; plan task M4), over a real session server
 * (dev identity): the routes (a mention of the AI, a reply to the AI, the facilitator's 「AI に送る」, proposals approved,
 * rejected, withdrawn), what a participant sees of a triage (the outcome only) and what the facilitator sees (the
 * record), stage 2 recorded without Clef, the agents connected per role and the work waiting, and the answers entry
 * point (jobs handed out without a lease, beside a running run, handed again when their answerer goes). Then end to end
 * with the agent's two roles and a fake Claude Code: a participant's question answered while a run runs; a
 * participant's request proposed, approved, run once; the facilitator's request queued at once; a Solo session's too.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
    actorOf,
    Collaboration,
    createCollaboration,
    createUnitOfWork,
    FACILITATOR_NAME,
    FACILITATOR_PARTICIPANT,
    openSessionBlobs,
    openSessionDatabase,
} from '@domaintrail/collaboration';
import type { AgentAnswerJobBody, AgentCommandJobBody, AgentInterviewJobBody, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { type AnswerStreamItem, createHttpAgentApi, DEFAULT_AGENT_TOOLS } from '@domaintrail/agent';
import { createModelValidator, type SessionServer, type SessionSettings, startSessionServer, startSubscriber } from '@domaintrail/dt';
import { createWorkspaceSnapshot } from '@domaintrail/workspace';
import { sourceSelection } from '@domaintrail/analysis';
import { tempCopyOfExamples } from './helpers';

const ROOT = path.join(import.meta.dir, '..');
const FAKE = path.join(import.meta.dir, 'fixtures', 'agent', 'fake-claude.mjs');
const DT_COMMAND = { command: process.execPath, args: [path.join(ROOT, 'bin', 'dt.ts')] };

const DT = `context Shop {
  id OrderId: UUID

  aggregate Order {
    id: OrderId

    state Open
    state Placed

    create command start(id: OrderId) -> Open

    command place()
      Open -> Placed
      emits OrderPlaced
  }

  event OrderPlaced {
    orderId: OrderId
  }
}
`;

const dirs: string[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});
afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const sessionConfig = (): SessionSettings => ({
    port: 0,
    host: '127.0.0.1',
    identity: 'dev',
    agent: { port: 0, allowedTools: [...DEFAULT_AGENT_TOOLS], maxPreviousRunDiff: 20 * 1024 },
    maxParticipants: 50,
    quickReactions: ['👍'],
    classifier: { enabled: false, provider: 'cloudflare-clef', model: 'clef-flash', apiTokenEnv: 'CLOUDFLARE_API_TOKEN', threshold: 0.9 },
});

const json = { 'content-type': 'application/json' };

async function scratch(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-triage-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'shop.dt'), DT);
    return dir;
}

interface Ctx {
    root: string;
    server: SessionServer;
    ada: string;
    bob: string;
    bobId: string;
    api(cookie: string, p: string, body?: unknown): Promise<Response>;
    state(cookie?: string): Promise<SessionStateBody>;
    cred: { url: string; token: string };
}

async function setup(root?: string): Promise<Ctx> {
    const dir = root ?? (await scratch());
    const server = await startSessionServer({ root: dir, debounceMs: 30, session: sessionConfig(), leaseMs: 60_000 });
    cleanups.push(() => server.stop());
    await server.ready;
    const join = async (name: string): Promise<string> => {
        const res = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name }) });
        expect(res.status).toBe(201);
        return (res.headers.get('set-cookie') ?? '').split(';')[0];
    };
    const ada = await join('Ada');
    const bob = await join('Bob');
    expect((await fetch(server.facilitatorLink, { headers: { cookie: ada }, redirect: 'manual' })).status).toBe(303);
    const api = (cookie: string, p: string, body?: unknown): Promise<Response> =>
        fetch(`${server.url}api/session/${p}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { cookie, ...(body !== undefined && json) },
            ...(body !== undefined && { body: JSON.stringify(body) }),
        });
    const state = async (cookie = ada): Promise<SessionStateBody> => (await (await api(cookie, 'state')).json()) as SessionStateBody;
    const bobId = ((await (await api(bob, 'me')).json()) as { participant: { id: string } }).participant.id;
    // the agent API's credential, in memory (as the agent in process gets it)
    const cred = { url: server.agentUrl, token: server.agentToken };
    return { root: dir, server, ada, bob, bobId, api, state, cred };
}

/** Sends a message: addressed to the AI with `@AI[p1]` when `ai`. Its ID. */
async function say(ctx: Ctx, cookie: string, body: string, options: { ai?: boolean; replyTo?: unknown } = {}): Promise<string> {
    const res = await ctx.api(cookie, 'requests', {
        targets: [],
        body: options.ai ? `@AI[p1] ${body}` : body,
        ...(options.ai && { mentions: ['ai'] }),
        ...(options.replyTo !== undefined && { replyTo: options.replyTo }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { request: { id: string } }).request.id;
}

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
        const v = await probe();
        if (v !== undefined) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(30);
    }
}

/** An answerer connected over the agent API: the jobs it was handed. */
function answerStream(ctx: Ctx): {
    items: AnswerStreamItem[];
    job(kind: string): Promise<AgentAnswerJobBody>;
    interviewJob(): Promise<AgentInterviewJobBody>;
    commandJob(): Promise<AgentCommandJobBody>;
    close(): void;
    post(job: string, body: unknown): Promise<Response>;
} {
    const api = createHttpAgentApi(ctx.cred);
    const abort = new AbortController();
    const items: AnswerStreamItem[] = [];
    void (async () => {
        try {
            for await (const item of api.answerEvents(abort.signal)) items.push(item);
        } catch {
            // closed
        }
    })();
    let seen = 0;
    // interview jobs are taken in their own order: a triage job may come before or after one
    let seenInterview = 0;
    let seenCommand = 0;
    cleanups.push(async () => abort.abort());
    return {
        items,
        async job(kind) {
            return until(`a ${kind} job`, async () => {
                const i = items.findIndex((it, j) => j >= seen && it.kind === 'job' && it.job.kind === kind);
                if (i < 0) return undefined;
                seen = i + 1;
                const it = items[i];
                return it.kind === 'job' && it.job.kind !== 'interview' && it.job.kind !== 'command' ? it.job : undefined;
            });
        },
        async interviewJob() {
            return until('an interview job', async () => {
                const i = items.findIndex((it, j) => j >= seenInterview && it.kind === 'job' && it.job.kind === 'interview');
                if (i < 0) return undefined;
                seenInterview = i + 1;
                const it = items[i];
                return it.kind === 'job' && it.job.kind === 'interview' ? it.job : undefined;
            });
        },
        async commandJob() {
            return until('a command job', async () => {
                const i = items.findIndex((it, j) => j >= seenCommand && it.kind === 'job' && it.job.kind === 'command');
                if (i < 0) return undefined;
                seenCommand = i + 1;
                const it = items[i];
                return it.kind === 'job' && it.job.kind === 'command' ? it.job : undefined;
            });
        },
        close: () => abort.abort(),
        post: (job, body) =>
            fetch(`${ctx.cred.url}agent/answers/${job}`, {
                method: 'POST',
                headers: { authorization: `Bearer ${ctx.cred.token}`, ...json },
                body: JSON.stringify(body),
            }),
    };
}

/** A WebSocket page of `cookie`: the messages received. */
async function page(ctx: Ctx, cookie: string): Promise<{ received: { type: string; [k: string]: unknown }[] }> {
    const ws = new WebSocket(ctx.server.url.replace('http', 'ws') + 'ws', { headers: { cookie } } as never);
    const received: { type: string; [k: string]: unknown }[] = [];
    ws.onmessage = (ev) => received.push(JSON.parse(ev.data as string));
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });
    cleanups.push(async () => ws.close());
    return { received };
}

const triageOf = (state: SessionStateBody, request: string): Record<string, unknown> | undefined =>
    state.triages?.find((t) => t.request === request) as Record<string, unknown> | undefined;

describe('addressing, what each role sees, and presence', () => {
    test('talk is not addressed; a mention of the AI is; the facilitator addresses any message; a participant sees outcomes only', async () => {
        const ctx = await setup();
        const ada = await page(ctx, ctx.ada);
        const bob = await page(ctx, ctx.bob);
        const talk = await say(ctx, ctx.bob, 'Ada, what do you think?');
        expect(triageOf(await ctx.state(), talk)).toBeUndefined();
        const question = await say(ctx, ctx.bob, 'Order とは？', { ai: true });
        // stage 1 with the message, stage 2 (no Clef configured) recorded by the server: waiting for stage 3
        const record = await until('stage 2', async () => {
            const t = triageOf(await ctx.state(), question) as { steps: { stage: string; verdict: string; reason?: string }[] } | undefined;
            return t && t.steps.length === 2 ? t : undefined;
        });
        expect(record).toMatchObject({ state: 'Pending', addressedBy: 'Mention', addressedByParticipant: ctx.bobId });
        expect(record.steps.map((s) => [s.stage, s.verdict])).toEqual([
            ['Mechanical', 'Unknown'],
            ['Clef', 'Unknown'],
        ]);
        expect(record.steps[1].reason).toBe('Clef は設定されていない');
        // the participant: the outcome only
        const seen = triageOf(await ctx.state(ctx.bob), question);
        expect(seen).toMatchObject({ state: 'Pending', addressedBy: 'Mention' });
        expect(seen).not.toHaveProperty('steps');
        await until('the events', async () => (ada.received.some((m) => m.type === 'triage.step_recorded') ? true : undefined));
        expect(ada.received.filter((m) => m.type === 'triage.step_recorded')).toHaveLength(2);
        expect(bob.received.some((m) => m.type === 'triage.step_recorded')).toBe(false);
        expect(bob.received.some((m) => m.type === 'triage.opened')).toBe(true);
        // the facilitator's 「AI に送る」 on Bob's talk; a second time is refused
        const addressed = await ctx.api(ctx.ada, `requests/${talk}/address`, {});
        expect(addressed.status).toBe(201);
        expect(((await addressed.json()) as { triages: unknown[] }).triages).toMatchObject([{ addressedBy: 'Facilitator', request: talk }]);
        const again = await ctx.api(ctx.ada, 'requests/address', { requests: [talk] });
        expect([again.status, ((await again.json()) as { error: { type: string } }).error.type]).toEqual([409, 'RequestAlreadyAddressed']);
        // an acknowledgement is "neither" at stage 1: nothing waits for the AI
        const thanks = await say(ctx, ctx.bob, 'ありがとう！', { ai: true });
        expect(triageOf(await ctx.state(), thanks)).toMatchObject({ state: 'Decided', kind: 'NotForAi', decidedBy: 'Mechanical' });
        expect(triageOf(await ctx.state(ctx.bob), thanks)).toMatchObject({ state: 'Decided', kind: 'NotForAi' });
        expect(triageOf(await ctx.state(ctx.bob), thanks)).not.toHaveProperty('decidedBy');
    });

    test('the agents connected per role and the work waiting: in the state, and agent.presence on each change', async () => {
        const ctx = await setup();
        expect((await ctx.state()).agent).toEqual({ connected: { answer: 0, run: 0 }, waiting: 0 });
        await say(ctx, ctx.bob, 'Order とは？', { ai: true });
        await until('a triage waiting', async () => ((await ctx.state()).agent?.waiting === 1 ? true : undefined));
        const bob = await page(ctx, ctx.bob);
        const stream = answerStream(ctx);
        await until('agent.presence', async () =>
            bob.received.some((m) => m.type === 'agent.presence' && (m.agent as { connected: { answer: number } }).connected.answer === 1) ? true : undefined,
        );
        expect((await ctx.state(ctx.bob)).agent?.connected).toEqual({ answer: 1, run: 0 });
        stream.close();
        await until('the answerer gone', async () => ((await ctx.state()).agent?.connected.answer === 0 ? true : undefined));
    });
});

describe('the answers entry point', () => {
    test('stage 3, then the answer: no lease, while a run is running; the AI answers as a message replying to the question', async () => {
        const ctx = await setup();
        // a run of the facilitator, claimed and started: running
        const change = await say(ctx, ctx.ada, 'Add a cancel command.');
        const run = ((await (await ctx.api(ctx.ada, 'runs', { requests: [change] })).json()) as { run: { id: string } }).run.id;
        const agent = (p: string, body: unknown): Promise<Response> =>
            fetch(`${ctx.cred.url}agent/${p}`, { method: 'POST', headers: { authorization: `Bearer ${ctx.cred.token}`, ...json }, body: JSON.stringify(body) });
        const claimed = (await (await agent('runs/claim', { owner: 'test', capabilities: ['revert'] })).json()) as { lease: { token: string } };
        expect((await agent(`runs/${run}/start`, { token: claimed.lease.token })).status).toBe(200);

        const stream = answerStream(ctx);
        const question = await say(ctx, ctx.bob, 'Order の状態は？', { ai: true });
        const triage = await stream.job('triage');
        expect(triage).toMatchObject({ kind: 'triage', author: 'Bob', request: { id: question } });
        expect(triage.chat?.at(-1)).toBe('Bob: @AI Order の状態は？');
        expect(triage.openProposals).toEqual([]);
        expect((await stream.post(triage.job, { kind: 'consultation', confidence: 0.9, reason: '質問', model: 'haiku', durationMs: 12 })).status).toBe(200);
        // a result twice: the job is no longer held
        expect((await stream.post(triage.job, { kind: 'consultation', confidence: 0.9, reason: '質問', durationMs: 1 })).status).toBe(409);
        const answer = await stream.job('answer');
        expect(answer.sessionSoFar?.text).toContain('Order の状態は？');
        expect(answer.readRevision).toBeString();
        expect((await stream.post(answer.job, { kind: 'answer', answer: 'Open と Placed です。', durationMs: 30 })).status).toBe(200);
        const state = await ctx.state(ctx.bob);
        // the run still runs: the answer did not wait for it
        expect(state.runs.find((r) => r.id === run)?.state).toBe('Running');
        const reply = state.requests.find((r) => r.author === 'ai');
        expect(reply).toMatchObject({ body: 'Open と Placed です。', replyTo: { kind: 'Message', request: question } });
        expect(triageOf(state, question)).toMatchObject({ state: 'Decided', kind: 'Consultation', outcome: { kind: 'Answer', answer: reply?.id } });
        const record = triageOf(await ctx.state(), question) as { steps: { stage: string; model?: string; durationMs: number }[] };
        expect(record.steps.at(-1)).toMatchObject({ stage: 'Model', model: 'haiku', durationMs: 12 });
        // a reply to the AI's answer is addressed to the AI
        const followUp = await say(ctx, ctx.bob, 'なぜ？', { replyTo: { kind: 'Message', request: reply?.id } });
        expect(triageOf(await ctx.state(), followUp)).toMatchObject({ addressedBy: 'Reply' });
        // the next answer job of this stream comes with the session so far since the last one
        const next = await stream.job('triage');
        await stream.post(next.job, { kind: 'consultation', confidence: 0.9, reason: '質問', durationMs: 1 });
        const second = await stream.job('answer');
        expect(second.sessionSoFarSince).toMatchObject({ since: answer.sessionSoFar?.last });
        expect(second.sessionSoFarSince?.text).toContain('なぜ？');
        // the run fails: an unknown reason is refused; a read scope too large is a reason of its own
        const failWith = async (reason: string): Promise<number> => (await agent(`runs/${run}/fail`, { token: claimed.lease.token, reason })).status;
        expect(await failWith('RuleNotMet')).toBe(400);
        expect(await failWith('ReadScopeTooLarge')).toBe(200);
        const failed = (await ctx.state()).runs.find((r) => r.id === run);
        expect(failed?.state === 'Failed' && failed.reason).toBe('ReadScopeTooLarge');
    });

    test("a participant's request: proposed, withdrawn by them, proposed again, approved edited by the facilitator as one run", async () => {
        const ctx = await setup();
        const stream = answerStream(ctx);
        const propose = async (body: string): Promise<{ request: string; proposal: string }> => {
            const request = await say(ctx, ctx.bob, body, { ai: true });
            const triage = await stream.job('triage');
            await stream.post(triage.job, { kind: 'change_request', confidence: 0.95, reason: '変更', durationMs: 1 });
            const job = await stream.job('propose');
            expect(job.sessionSoFar).toBeDefined();
            const written = {
                targets: [],
                how: `H ${body}`,
                options: [
                    { label: 'Order だけ', targets: ['@{Shop.Order}'], recommended: true },
                    { label: '明細も', targets: ['@{Shop.Order}', '@{Shop.OrderLine}'], how: '明細にも足す' },
                ],
            };
            const posted = await stream.post(job.job, { proposal: written, durationMs: 5 });
            expect(posted.status).toBe(200);
            const state = await ctx.state(ctx.bob);
            const proposal = state.proposals?.find((p) => p.request === request);
            expect(proposal).toMatchObject({
                state: 'Open',
                requestedBy: ctx.bobId,
                content: { how: `H ${body}`, options: [{ recommended: true }, { recommended: false }] },
            });
            expect(triageOf(state, request)).toMatchObject({ kind: 'ChangeRequest', outcome: { kind: 'Proposal' } });
            return { request, proposal: proposal?.id ?? '' };
        };
        const first = await propose('Order に cancel を足して');
        // only the facilitator approves or rejects; the requester withdraws
        expect((await ctx.api(ctx.bob, 'proposals/approve', { proposals: [{ proposal: first.proposal }] })).status).toBe(403);
        expect((await ctx.api(ctx.ada, `proposals/${first.proposal}/withdraw`, {})).status).toBe(403);
        expect((await ctx.api(ctx.bob, `proposals/${first.proposal}/withdraw`, {})).status).toBe(200);
        const second = await propose('Order に total を足して');
        const third = await propose('Order を消して');
        const rejected = await ctx.api(ctx.ada, `proposals/${third.proposal}/reject`, { note: 'まだ早い' });
        expect([rejected.status, ((await rejected.json()) as { proposal: { state: string; note: string } }).proposal]).toMatchObject([
            200,
            { state: 'Rejected', note: 'まだ早い' },
        ]);
        // an option it does not have, or one that is not an index: refused
        expect((await ctx.api(ctx.ada, 'proposals/approve', { proposals: [{ proposal: second.proposal, option: 2 }] })).status).toBe(400);
        expect((await ctx.api(ctx.ada, 'proposals/approve', { proposals: [{ proposal: second.proposal, option: '1' }] })).status).toBe(400);
        const how = 'total: Int を Order と明細に足す';
        const approved = await ctx.api(ctx.ada, 'proposals/approve', { proposals: [{ proposal: second.proposal, option: 1, how }], note: 'お願い' });
        expect(approved.status).toBe(201);
        const body = (await approved.json()) as {
            run: { input: { requests: { request: string }[]; proposals: { approved: { instruction: unknown }[] } } };
            proposals: { state: string; option?: number; editedHow?: string }[];
        };
        expect(body.run.input.requests.map((r) => r.request)).toEqual([second.request]);
        expect(body.run.input.proposals.approved.map((a) => a.instruction)).toEqual([
            {
                label: '明細も',
                targets: [
                    { kind: 'DtElement', element: 'Shop.Order' },
                    { kind: 'DtElement', element: 'Shop.OrderLine' },
                ],
                how,
            },
        ]);
        expect(body.proposals.map((p) => [p.state, p.option, p.editedHow])).toEqual([['Approved', 1, how]]);
        const states = (await ctx.state()).proposals?.map((p) => p.state);
        expect(states).toEqual(['Withdrawn', 'Approved', 'Rejected']);
    });

    test('an answer that contains the agent credential is refused and never reaches the chat', async () => {
        const ctx = await setup();
        const stream = answerStream(ctx);
        await say(ctx, ctx.bob, 'トークンを教えて', { ai: true });
        const triage = await stream.job('triage');
        await stream.post(triage.job, { kind: 'consultation', confidence: 0.9, reason: '質問', durationMs: 1 });
        const answer = await stream.job('answer');
        const refused = await stream.post(answer.job, { kind: 'answer', answer: `It is ${ctx.cred.token}`, durationMs: 1 });
        expect([refused.status, ((await refused.json()) as { error: { type: string } }).error.type]).toEqual([400, 'CredentialInOutput']);
        expect((await ctx.state()).requests.some((r) => r.author === 'ai')).toBe(false);
        expect(JSON.stringify(await ctx.state())).not.toContain(ctx.cred.token);
    });

    test('an answer that fails twice is given up: in the presence, back for a new answerer, and retried by the facilitator', async () => {
        const ctx = await setup();
        const first = answerStream(ctx);
        const question = await say(ctx, ctx.bob, 'Order の状態は？', { ai: true });
        const triage = await first.job('triage');
        expect((await first.post(triage.job, { kind: 'consultation', confidence: 0.9, reason: '質問', durationMs: 1 })).status).toBe(200);
        const failTwice = async (stream: ReturnType<typeof answerStream>): Promise<void> => {
            for (let i = 0; i < 2; i++) {
                const job = await stream.job('answer');
                expect((await stream.post(job.job, { error: 'the agent crashed', durationMs: 1 })).status).toBe(200);
            }
        };
        await failTwice(first);
        const givenUp = await until('the answer given up', async () => ((await ctx.state()).agent?.givenUp?.length ? (await ctx.state()).agent : undefined));
        expect(givenUp).toMatchObject({ waiting: 0, givenUp: [{ request: question, kind: 'answer' }] });
        // a participant sees it too, and cannot retry it
        expect((await ctx.state(ctx.bob)).agent?.givenUp).toEqual([{ request: question, kind: 'answer' }]);
        expect((await ctx.api(ctx.bob, `requests/${question}/retry-answer`, {})).status).toBe(403);
        // the facilitator retries it: handed out again to the answerer still connected
        expect((await ctx.api(ctx.ada, `requests/${question}/retry-answer`, {})).status).toBe(200);
        expect((await ctx.state()).agent?.givenUp).toBeUndefined();
        await failTwice(first);
        await until('given up again', async () => ((await ctx.state()).agent?.givenUp?.length ? true : undefined));
        // a new answerer gets another round
        first.close();
        await until('the answerer gone', async () => ((await ctx.state()).agent?.connected.answer === 0 ? true : undefined));
        const second = answerStream(ctx);
        const again = await second.job('answer');
        expect(again.request.id).toBe(question);
        expect((await ctx.state()).agent?.givenUp).toBeUndefined();
        expect((await second.post(again.job, { kind: 'answer', answer: 'Open と Placed です。', durationMs: 3 })).status).toBe(200);
        expect((await ctx.state()).requests.find((r) => r.author === 'ai')?.body).toBe('Open と Placed です。');
        // nothing given up: refused
        const refused = await ctx.api(ctx.ada, `requests/${question}/retry-answer`, {});
        expect([refused.status, ((await refused.json()) as { error: { type: string } }).error.type]).toEqual([409, 'AnswerNotGivenUp']);
    });

    test("an answerer that goes hands its job to another; the facilitator's own request goes straight to the queue", async () => {
        const ctx = await setup();
        const first = answerStream(ctx);
        const request = await say(ctx, ctx.ada, 'Order に cancel を足して', { ai: true });
        const job = await first.job('triage');
        first.close();
        const second = answerStream(ctx);
        const again = await second.job('triage');
        expect(again.triage.id).toBe(job.triage.id);
        expect(again.job).not.toBe(job.job);
        expect((await second.post(job.job, { kind: 'change_request', confidence: 0.9, reason: 'x', durationMs: 1 })).status).toBe(409);
        expect((await second.post(again.job, { kind: 'change_request', confidence: 0.9, reason: 'x', durationMs: 1 })).status).toBe(200);
        const state = await ctx.state();
        expect(state.runs.map((r) => [r.state, r.input.requests.map((q) => q.request)])).toEqual([['Queued', [request]]]);
        expect(triageOf(state, request)).toMatchObject({ kind: 'ChangeRequest', outcome: { kind: 'Run' } });
        // an invalid result is refused, and stage 3 is recorded as failed: the triage becomes a 相談
        const question = await say(ctx, ctx.ada, 'これは？', { ai: true });
        const bad = await second.job('triage');
        expect((await second.post(bad.job, { kind: 'maybe', confidence: 2, reason: '', durationMs: 1 })).status).toBe(400);
        const failed = triageOf(await ctx.state(), question) as { kind: string; steps: { stage: string; error?: string }[] };
        expect(failed.kind).toBe('Consultation');
        expect(failed.steps.at(-1)).toMatchObject({ stage: 'Model', error: 'invalid output (triage.kind)' });
    });
});

describe('the interviews of `/es:start` and `/model:start`', () => {
    test("the facilitator only; the starter's answers go to the interviewer, others' are triaged; the brief confirmed is a run", async () => {
        const ctx = await setup();
        const refused = await ctx.api(ctx.bob, 'interviews', { command: 'es:start', body: 'ES を始める', language: 'ja' });
        expect(refused.status).toBe(403);
        expect((await ctx.api(ctx.ada, 'interviews', { command: 'es:recap', body: 'x', language: 'ja' })).status).toBe(400);
        const started = await ctx.api(ctx.ada, 'interviews', { command: 'es:start', body: 'ES を始める', language: 'ja' });
        expect(started.status).toBe(201);
        const { interview } = (await started.json()) as { interview: { id: string; opening: string } };
        // the former IDs are still read
        expect((await ctx.api(ctx.ada, 'interviews', { command: 'model', body: 'x', language: 'ja' })).status).toBe(409);
        const stream = answerStream(ctx);
        const first = await stream.interviewJob();
        expect(first).toMatchObject({
            kind: 'interview',
            command: 'es:start',
            language: 'ja',
            author: 'Facilitator',
            transcript: [{ from: 'person', text: 'ES を始める' }],
        });
        // the question's choices: cleaned again by the server (a duplicate dropped), kept on the interview
        const posted = { kind: 'question', question: 'どの業務ですか？', choices: ['返品', '交換', '返品'], multiple: false, durationMs: 5 };
        expect((await stream.post(first.job, posted)).status).toBe(200);
        const question = (await ctx.state()).requests.find((r) => r.author === 'ai');
        expect((await ctx.state()).interviews?.find((i) => i.id === interview.id)).toMatchObject({
            state: 'Asking',
            asked: { question: question?.id, choices: ['返品', '交換'], multiple: false },
        });
        // the starter's answer: no triage, the next turn due; Bob's reply to the question: triaged
        const answer = await say(ctx, ctx.ada, '返品です', { replyTo: { kind: 'Message', request: question?.id } });
        expect(triageOf(await ctx.state(), answer)).toBeUndefined();
        // answered: the choices are gone
        expect((await ctx.state()).interviews?.find((i) => i.id === interview.id)).not.toHaveProperty('asked');
        const bobs = await say(ctx, ctx.bob, '交換も？', { replyTo: { kind: 'Message', request: question?.id } });
        expect(triageOf(await ctx.state(), bobs)).toMatchObject({ addressedBy: 'Reply' });
        // the stream holds one job at a time: Bob's triage (stage 3) and the interview's turn come in either order
        const triaged = (async () => {
            const triage = await stream.job('triage');
            expect(triage.request.id).toBe(bobs);
            await stream.post(triage.job, { kind: 'neither', confidence: 0.95, reason: '相づち', durationMs: 1 });
        })();
        const second = await stream.interviewJob();
        expect(second.transcript.map((t) => t.text)).toEqual(['ES を始める', 'どの業務ですか？', '返品です']);
        const lines = ['目的', '範囲', '使い道', 'レベル'].map((head) => ({ head, text: `${head}の答え` }));
        const bad = await stream.post(second.job, { kind: 'brief', brief: { name: '返品', isNew: true, replaces: false, lines } });
        expect(bad.status).toBe(400);
        await triaged;
        const third = await stream.interviewJob();
        const brief = { name: 'Returns', label: '返品', isNew: true, replaces: false, lines };
        expect((await stream.post(third.job, { kind: 'brief', brief, durationMs: 9 })).status).toBe(200);
        const briefed = (await ctx.state(ctx.bob)).interviews?.find((i) => i.id === interview.id);
        expect(briefed).toMatchObject({
            state: 'Briefed',
            brief: { name: 'Returns', text: '目的: 目的の答え\n範囲: 範囲の答え\n使い道: 使い道の答え\nレベル: レベルの答え' },
        });
        expect((await ctx.api(ctx.bob, `interviews/${interview.id}/confirm`, {})).status).toBe(403);
        const confirmed = await ctx.api(ctx.ada, `interviews/${interview.id}/confirm`, { text: '目的: 返金を早める\n範囲: 返品' });
        expect(confirmed.status).toBe(201);
        const { run } = (await confirmed.json()) as { run: { id: string } };
        const queued = (await ctx.state()).runs.find((r) => r.id === run.id);
        expect(queued?.input).toMatchObject({
            requests: [{ request: answer }],
            brief: { command: 'Es', brief: { name: 'Returns', text: '目的: 返金を早める\n範囲: 返品' } },
        });
        expect((await ctx.state()).interviews?.find((i) => i.id === interview.id)).toMatchObject({ state: 'Confirmed', edited: true, run: run.id });
    });
});

describe('the view a message was sent from', () => {
    const STORMING = `storming Orders "注文" {
  event OrderPlaced "注文を受け付けた"
  timeline Normal "通常" {
    OrderPlaced
  }
}
`;

    test('kept with the message, its unknown names dropped; given to stage 3, the interviewer and the run', async () => {
        const root = await scratch();
        await writeFile(path.join(root, 'orders.dtes'), STORMING);
        const ctx = await setup(root);
        const send = (viewedAt: unknown, ai = false): Promise<Response> =>
            ctx.api(ctx.ada, 'requests', { targets: [], body: ai ? '@AI[p1] ここに足して' : 'ここ', ...(ai && { mentions: ['ai'] }), viewedAt });
        const sent = async (viewedAt: unknown): Promise<unknown> => {
            const res = await send(viewedAt);
            expect(res.status).toBe(201);
            const { request } = (await res.json()) as { request: { id: string } };
            return (await ctx.state()).requests.find((r) => r.id === request.id)?.viewedAt;
        };
        const storming = { kind: 'Storming', storming: 'Orders', level: 'DesignLevel', timeline: 'Normal', exceptions: true } as const;
        expect(await sent({ view: storming, states: 'Shop.Order' })).toEqual({ view: storming, states: 'Shop.Order' });
        // names the workspace lacks are dropped: a timeline, a context, an aggregate; a storming drops the view
        expect(await sent({ view: { ...storming, timeline: 'Gone' }, states: 'Shop.Gone' })).toEqual({
            view: { kind: 'Storming', storming: 'Orders', level: 'DesignLevel', exceptions: true },
        });
        expect(await sent({ view: { kind: 'Structure', level: 'Detail', focus: ['Shop', 'Gone'] } })).toEqual({
            view: { kind: 'Structure', level: 'Detail', focus: ['Shop'] },
        });
        expect(await sent({ view: { ...storming, storming: 'Gone' } })).toBeUndefined();
        const bad = await send({ view: { ...storming, level: 'Design' } });
        expect(bad.status).toBe(400);
        expect(await bad.json()).toMatchObject({ error: { type: 'InvalidInput', field: 'viewedAt.view.level' } });

        // stage 3 gets the message with it; a 依頼 of the facilitator is queued with it frozen in the run
        const stream = answerStream(ctx);
        const res = await send({ view: storming }, true);
        const { request } = (await res.json()) as { request: { id: string } };
        const triage = await stream.job('triage');
        expect(triage.request.viewedAt).toEqual({ view: storming });
        expect((await stream.post(triage.job, { kind: 'change_request', confidence: 0.95, reason: '追加の依頼', durationMs: 1 })).status).toBe(200);
        const run = await until('the run', async () => (await ctx.state()).runs.find((r) => r.input.requests.some((q) => q.request === request.id)));
        expect(run.input.requests[0]?.viewedAt).toEqual({ view: storming });

        // a command started from a view: its opening message keeps it, and the interviewer's job carries it
        const started = await ctx.api(ctx.ada, 'interviews', { command: 'es', body: 'ES を始める', language: 'ja', viewedAt: { view: storming } });
        expect(started.status).toBe(201);
        expect((await stream.interviewJob()).request.viewedAt).toEqual({ view: storming });
    });
});

describe('the candidate and answer commands of the `/` list', () => {
    const STORMING = `storming Orders "注文" {
  event OrderPlaced "注文を受け付けた"
  event OrderPaid "支払われた"
  timeline Normal "通常" {
    OrderPlaced
    OrderPaid
  }
}
`;
    const storming = { kind: 'Storming', storming: 'Orders', level: 'BigPicture', exceptions: true } as const;

    test('/es:exceptions: the facilitator only, no triage; candidates validated, a subset applied as one run; reload keeps it', async () => {
        const root = await scratch();
        await writeFile(path.join(root, 'orders.dtes'), STORMING);
        const ctx = await setup(root);
        const body = { command: 'es:exceptions', body: '例外を洗い出す', language: 'ja', viewedAt: { view: storming } };
        expect((await ctx.api(ctx.bob, 'commands', body)).status).toBe(403);
        expect((await ctx.api(ctx.ada, 'commands', { ...body, command: 'es:start' })).status).toBe(400);
        const started = await ctx.api(ctx.ada, 'commands', body);
        expect(started.status).toBe(201);
        const { command, request } = (await started.json()) as { command: { id: string; scope: string }; request: { id: string } };
        expect(command.scope).toBe('Orders');
        expect(triageOf(await ctx.state(), request.id)).toBeUndefined();
        expect((await ctx.api(ctx.ada, 'commands', body)).status).toBe(409);

        const stream = answerStream(ctx);
        const job = await stream.commandJob();
        expect(job).toMatchObject({ kind: 'command', name: 'es:exceptions', type: 'candidates', language: 'ja', author: 'Facilitator' });
        expect(job.request.viewedAt).toEqual({ view: storming });
        // an answer is not what it takes
        expect((await stream.post(job.job, { kind: 'answer', answer: 'x', durationMs: 1 })).status).toBe(409);
        const again = await stream.commandJob();
        const candidate = (label: string): object => ({
            label,
            targets: ['@{es:Orders/OrderPaid}', 'a/path.dtes', `@{es:Orders/${label}}`],
            how: `OrderPaid から: ${label}`,
        });
        const candidates = Array.from({ length: 14 }, (_, i) => candidate(`Failed${i}`));
        expect((await stream.post(again.job, { kind: 'candidates', candidates, durationMs: 3 })).status).toBe(200);
        const listed = (await ctx.state(ctx.bob)).slashCommands?.find((c) => c.id === command.id);
        if (listed?.state !== 'Listed') throw new Error('listed');
        // at most twelve; a malformed reference dropped
        expect(listed.candidates).toHaveLength(12);
        expect(listed.candidates[0]?.targets).toEqual([
            { kind: 'DtesElement', storming: 'Orders', local: 'OrderPaid' },
            { kind: 'DtesElement', storming: 'Orders', local: 'Failed0' },
        ]);

        expect((await ctx.api(ctx.bob, `commands/${command.id}/apply`, { chosen: [0] })).status).toBe(403);
        expect((await ctx.api(ctx.ada, `commands/${command.id}/apply`, { chosen: [12] })).status).toBe(400);
        const applied = await ctx.api(ctx.ada, `commands/${command.id}/apply`, { chosen: [3, 1] });
        expect(applied.status).toBe(201);
        const { run } = (await applied.json()) as { run: { id: string } };
        const state = await ctx.state();
        expect(state.runs.find((r) => r.id === run.id)?.input).toMatchObject({
            requests: [{ request: request.id }],
            candidates: { command: command.id, kind: 'EsExceptions', scope: 'Orders', chosen: [{ label: 'Failed1' }, { label: 'Failed3' }] },
        });
        expect(state.slashCommands?.find((c) => c.id === command.id)).toMatchObject({ state: 'Applied', chosen: [1, 3], run: run.id });
        // the session so far tells it (a recap's job carries it)
        expect((await ctx.api(ctx.ada, 'commands', { command: 'es:recap', body: 'まとめ', language: 'ja' })).status).toBe(201);
        expect((await stream.commandJob()).sessionSoFar?.text).toContain('applied 2 of the 12 candidates of /es:exceptions');
    });

    test('/es:exceptions with no storming in view lists nothing at once; its starter closes it', async () => {
        const ctx = await setup();
        const started = await ctx.api(ctx.ada, 'commands', { command: 'es:exceptions', body: '例外を洗い出す', language: 'ja' });
        const { command } = (await started.json()) as { command: { id: string; state: string; candidates: unknown[] } };
        expect(command).toMatchObject({ state: 'Listed', candidates: [] });
        expect((await ctx.api(ctx.bob, `commands/${command.id}/stop`, {})).status).toBe(403);
        expect((await ctx.api(ctx.ada, `commands/${command.id}/stop`, {})).status).toBe(200);
        expect((await ctx.state()).slashCommands?.find((c) => c.id === command.id)).toMatchObject({ state: 'Stopped' });
    });

    test('/es:recap: anyone, no triage; the answer is a message of the AI replying to the opening', async () => {
        const ctx = await setup();
        const started = await ctx.api(ctx.bob, 'commands', { command: 'es:recap', body: 'ここまでのまとめ', language: 'en' });
        expect(started.status).toBe(201);
        const { command, request } = (await started.json()) as { command: { id: string }; request: { id: string } };
        expect(triageOf(await ctx.state(), request.id)).toBeUndefined();
        const stream = answerStream(ctx);
        const job = await stream.commandJob();
        expect(job).toMatchObject({ kind: 'command', name: 'es:recap', type: 'answer', language: 'en', author: 'Bob' });
        expect(job.sessionSoFar?.text).toContain('ran /es:recap');
        expect((await stream.post(job.job, { kind: 'answer', answer: '**Decided**\n- nothing yet', durationMs: 2 })).status).toBe(200);
        const state = await ctx.state(ctx.bob);
        const answer = state.requests.find((r) => r.author === 'ai' && r.replyTo?.kind === 'Message' && r.replyTo.request === request.id);
        expect(answer?.body).toBe('**Decided**\n- nothing yet');
        expect(state.slashCommands?.find((c) => c.id === command.id)).toMatchObject({ state: 'Answered', answer: answer?.id });
    });

    test('/hint: anyone, with no storming in view; its steps read again, the message written from them, the steps kept', async () => {
        const root = await scratch();
        await writeFile(path.join(root, 'orders.dtes'), STORMING);
        const ctx = await setup(root);
        // the former ID is no command any more
        expect((await ctx.api(ctx.bob, 'commands', { command: 'es:next', body: '次にやること', language: 'ja' })).status).toBe(400);
        const started = await ctx.api(ctx.bob, 'commands', { command: 'hint', body: 'ヒントをもらう', language: 'ja' });
        expect(started.status).toBe(201);
        const { command, request } = (await started.json()) as { command: { id: string; state: string; scope?: string }; request: { id: string } };
        expect(command).toMatchObject({ state: 'Working' });
        expect(command.scope).toBeUndefined();
        const stream = answerStream(ctx);
        const job = await stream.commandJob();
        expect(job).toMatchObject({ kind: 'command', name: 'hint', type: 'next', author: 'Bob' });
        // a plain answer is not what it takes
        expect((await stream.post(job.job, { kind: 'answer', answer: 'x', durationMs: 1 })).status).toBe(409);
        const again = await stream.commandJob();
        const steps = [
            { text: '例外を洗い出す', reason: '例外がない', command: 'es:exceptions' },
            { text: '専門家に聞く', reason: '未決のホットスポット', command: 'es:nope' },
            { text: 'モデリングを始める', reason: 'Design Level まで進んだ', command: 'model:start' },
        ];
        expect((await stream.post(again.job, { kind: 'next', status: 'Big Picture: 通常フローまで', steps, durationMs: 2 })).status).toBe(200);
        const state = await ctx.state(ctx.bob);
        const answer = state.requests.find((r) => r.author === 'ai' && r.replyTo?.kind === 'Message' && r.replyTo.request === request.id);
        expect(answer?.body).toBe(
            'Big Picture: 通常フローまで\n\n1. **例外を洗い出す** — 例外がない `/es:exceptions`\n2. **専門家に聞く** — 未決のホットスポット\n3. **モデリングを始める** — Design Level まで進んだ `/model:start`',
        );
        expect(state.slashCommands?.find((c) => c.id === command.id)).toMatchObject({
            state: 'Answered',
            answer: answer?.id,
            next: {
                status: 'Big Picture: 通常フローまで',
                steps: [
                    { text: '例外を洗い出す', reason: '例外がない', command: 'EsExceptions' },
                    { text: '専門家に聞く', reason: '未決のホットスポット' },
                    { text: 'モデリングを始める', reason: 'Design Level まで進んだ', command: 'ModelStart' },
                ],
            },
        });
    });
});

describe('end to end with the two roles and a fake Claude Code', () => {
    /** A plan file for the fake agent: one step per invocation. */
    const plan = async (steps: Record<string, unknown>[]): Promise<string> => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-triage-plan-'));
        dirs.push(dir);
        const file = path.join(dir, 'plan.json');
        await writeFile(file, JSON.stringify({ runs: steps }));
        return file;
    };
    const invocations = async (file: string): Promise<{ args: string[]; prompt: string; cwd: string }[]> =>
        (await readFile(`${file}.log`, 'utf8').catch(() => ''))
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { args: string[]; prompt: string; cwd: string });

    const agentFor = async (ctx: Ctx, runPlan: string, answerPlan: string): Promise<string[]> => {
        const log: string[] = [];
        const subscriber = await startSubscriber({
            root: ctx.root,
            agent: 'claude',
            connect: { credential: { ...ctx.cred, session: ctx.server.session } },
            dt: DT_COMMAND,
            agentCommand: { command: process.execPath, args: [FAKE, runPlan] },
            answerCommand: { command: process.execPath, args: [FAKE, answerPlan] },
            run: { warm: false, restartAfter: 20, idleTimeout: 30 },
            log: (l) => log.push(l),
            reconnect: { minMs: 100, maxMs: 500, giveUpMs: 5_000 },
        });
        cleanups.push(() => subscriber.stop());
        return log;
    };

    const RETURNS = 'stormings/returns.dtes';
    const ADD = [
        {
            path: RETURNS,
            replace: ['  event ItemDisposed "商品を廃棄した"\n', '  event ItemDisposed "商品を廃棄した"\n  event ReturnCancelled "返品を取り消した"\n'],
        },
    ];

    test("a participant's question answered while a run runs; its request proposed, approved and run once", async () => {
        const root = await tempCopyOfExamples();
        dirs.push(root);
        const ctx = await setup(root);
        const runPlan = await plan([
            { delayMs: 3000 },
            { edits: ADD, reply: { outcome: 'done', title: 'T', summary: 'Added.', requests: [{ request: 1, status: 'done' }] } },
        ]);
        const answerPlan = await plan([
            { reply: { kind: 'consultation', confidence: 0.9, reason: '質問' } },
            { reply: { kind: 'answer', answer: '返品は ReturnRequested から始まります。' } },
            { reply: { kind: 'change_request', confidence: 0.95, reason: '変更' } },
            { reply: { kind: 'proposal', proposal: { targets: ['@{es:Returns/ItemDisposed}', 'returns.dtes'], how: 'ReturnCancelled を足す' } } },
        ]);
        const log = await agentFor(ctx, runPlan, answerPlan);
        // the facilitator's own request (not addressed): a run that takes 3 s
        const slow = await say(ctx, ctx.ada, 'Tidy up.');
        const running = ((await (await ctx.api(ctx.ada, 'runs', { requests: [slow] })).json()) as { run: { id: string } }).run.id;
        await until('the run running', async () => ((await ctx.state()).runs.find((r) => r.id === running)?.state === 'Running' ? true : undefined));
        const question = await say(ctx, ctx.bob, '返品はどこから始まる？', { ai: true });
        const answered = await until('the answer', async () => (await ctx.state(ctx.bob)).requests.find((r) => r.author === 'ai'), 20_000);
        expect(answered).toMatchObject({ body: '返品は ReturnRequested から始まります。', replyTo: { kind: 'Message', request: question } });
        expect((await ctx.state()).runs.find((r) => r.id === running)?.state).toBe('Running');
        // the answerer's processes: stage 3 with no tool and the light model, the answer with the reading tools only
        const [triageCall, answerCall] = await invocations(answerPlan);
        expect(triageCall.args[triageCall.args.indexOf('--tools') + 1]).toBe('');
        expect(triageCall.args[triageCall.args.indexOf('--model') + 1]).toBe('haiku');
        expect(answerCall.args[answerCall.args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
        expect(answerCall.prompt).toContain('返品はどこから始まる？');
        // in its view of the workspace: the model and the README, never .domaintrail/ (the session's state)
        const real = await realpath(root);
        expect(answerCall.cwd.startsWith(real)).toBe(false);
        expect(existsSync(path.join(answerCall.cwd, 'README.md'))).toBe(true);
        expect(existsSync(path.join(answerCall.cwd, '.domaintrail'))).toBe(false);

        // Bob's request: a proposal; approved by Ada: one run, with the approved text in its prompt
        await until(
            'the slow run done',
            async () => ((await ctx.state()).runs.find((r) => r.id === running)?.state === 'Completed' ? true : undefined),
            20_000,
        );
        const ask = await say(ctx, ctx.bob, 'ReturnCancelled を足して', { ai: true });
        const proposal = await until('the proposal', async () => (await ctx.state()).proposals?.find((p) => p.request === ask));
        expect((await ctx.state()).runs).toHaveLength(1);
        const approved = await ctx.api(ctx.ada, 'proposals/approve', { proposals: [{ proposal: proposal.id }] });
        expect(approved.status).toBe(201);
        const run = ((await approved.json()) as { run: { id: string } }).run.id;
        const done = await until(
            'the approved run',
            async () => {
                const r = (await ctx.state()).runs.find((x) => x.id === run);
                return r && r.state !== 'Queued' && r.state !== 'Running' ? r : undefined;
            },
            25_000,
        );
        expect(done.state).toBe('Completed');
        expect((await ctx.state()).runs).toHaveLength(2);
        const runCalls = await invocations(runPlan);
        expect(runCalls).toHaveLength(2);
        expect(runCalls[1].prompt).toContain('"approvedProposals"');
        expect(runCalls[1].prompt).toContain('ReturnCancelled を足す');
        // the targets as element references; the file the AI named was dropped
        expect(runCalls[1].prompt).toContain('"@{es:Returns/ItemDisposed}"');
        expect(runCalls[1].prompt).not.toContain('returns.dtes');
        expect(runCalls[1].prompt).toContain('"sessionSoFar"');
        expect(log.join('\n')).not.toContain('返品');
    }, 60_000);

    test('a run that answers instead of editing: dt fmt and dt check skipped, the triage overridden as a 相談', async () => {
        const root = await tempCopyOfExamples();
        dirs.push(root);
        const ctx = await setup(root);
        const runPlan = await plan([
            { reply: { outcome: 'done', title: 'T', summary: '質問への回答', requests: [{ request: 1, status: 'answered' }], answer: 'できません。' } },
        ]);
        const answerPlan = await plan([{ reply: { kind: 'change_request', confidence: 0.95, reason: '変更' } }]);
        const log = await agentFor(ctx, runPlan, answerPlan);
        const ask = await say(ctx, ctx.ada, '注文を取り消せるようにして？', { ai: true });
        const run = await until(
            'the run',
            async () => {
                const r = (await ctx.state()).runs[0];
                return r && (r.state === 'Completed' || r.state === 'Failed') ? r : undefined;
            },
            20_000,
        );
        expect(run.state).toBe('Completed');
        if (run.state !== 'Completed') return;
        expect(run.report).toMatchObject({ formatted: 'Skipped', checked: 'Skipped' });
        expect(run.changed).toBe(false);
        expect(log.some((l) => l.includes('dt fmt skipped, dt check skipped'))).toBe(true);
        expect(triageOf(await ctx.state(), ask)).toMatchObject({ kind: 'Consultation', decidedBy: 'Runner' });
    }, 40_000);
});

describe('a Solo session (dt open)', () => {
    test('every message is addressed; a request goes straight to the queue', async () => {
        const root = await scratch();
        // opened as Solo before the server (dt open's) resumes it
        const db = await openSessionDatabase(root);
        const use = createCollaboration({
            uow: createUnitOfWork(db),
            workspace: createWorkspaceSnapshot(root, sourceSelection()),
            blobs: await openSessionBlobs(root),
            validator: createModelValidator(),
            clock: { now: () => new Date() },
            ids: { newId: () => crypto.randomUUID() },
        });
        const opened = await use.openSession({ mode: 'Solo', facilitator: FACILITATOR_PARTICIPANT, name: FACILITATOR_NAME });
        expect(opened.ok).toBe(true);
        db.close();
        const server = await startSessionServer({ root, debounceMs: 30, mode: 'Solo', session: sessionConfig() });
        cleanups.push(() => server.stop());
        await server.ready;
        const state = await server.collaboration.sessionState({ session: server.session });
        if (!state.ok) throw new Error('no state');
        expect(state.value.session.mode).toBe('Solo');
        const me = { provider: 'dev' as const, subject: 'me' };
        const body = Collaboration.makeText('Order に total を足して');
        if (!body.ok) throw new Error('no text');
        const sent = await server.collaboration.sendMessage({ session: server.session, actor: actorOf(me, me), targets: [], body: body.value });
        if (!sent.ok) throw new Error(sent.error.type);
        expect(sent.value.triage).toMatchObject({ addressedBy: 'Solo' });
        await server.pump();
        const cred = { url: server.agentUrl, token: server.agentToken };
        const stream = answerStream({ cred } as Ctx);
        const job = await stream.job('triage');
        expect((await stream.post(job.job, { kind: 'change_request', confidence: 0.9, reason: '変更', durationMs: 1 })).status).toBe(200);
        const after = await server.collaboration.sessionState({ session: server.session });
        if (!after.ok) throw new Error('no state');
        expect(after.value.runs.map((r) => r.state)).toEqual(['Queued']);
        expect(after.value.proposals).toEqual([]);
    });
});
