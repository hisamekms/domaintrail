// The answerer role (ADR 0030, decision 6) over fake ports: the jobs of its stream taken one at a time, each one's
// result validated and sent (stage 3's verdict, an answer, an override with a proposal, a proposal), the session so far
// whole for a fresh process and since its last job for a warm one with the files changed since, a withdrawn job
// stopped without a result, a job past its timeout reported as failed, and the session's end.
import { describe, expect, test } from 'bun:test';
import type { AgentAnswerJobBody, AgentCommandJobBody, AgentInterviewJobBody } from '@domaintrail/collaboration/protocol';
import { buildAnswerPrompt, buildCommandPrompt, buildInterviewPrompt, buildProposePrompt, buildTriagePrompt } from './answer-prompt.js';
import { startAnswerer } from './answerer.js';
import type { AgentApi, AnswerAgent, AnswerStreamItem, AnswerTurn, AnswerTurnResult } from './ports.js';
import type { Practice } from './prompt.js';

const SESSION = '00000000-0000-4000-8000-000000000001';
const REQUEST = '00000000-0000-4000-8000-000000000002';
const TRIAGE = '00000000-0000-4000-8000-000000000003';
const REVISION = '00000000-0000-4000-8000-000000000004';

const job = (kind: AgentAnswerJobBody['kind'], n: number, extra: Partial<AgentAnswerJobBody> = {}): AgentAnswerJobBody =>
    ({
        job: `job-${n}`,
        kind,
        triage: {
            id: TRIAGE,
            session: SESSION,
            request: REQUEST,
            addressedBy: 'Mention',
            addressedByParticipant: 'dev:bob',
            steps: [],
            openedAt: '',
            state: 'Pending',
        },
        request: { id: REQUEST, session: SESSION, author: 'dev:bob', targets: [], body: '@AI[p1] Order とは？', mentions: ['ai'], sentAt: '', state: 'Sent' },
        author: 'Bob',
        timeoutMs: 5_000,
        ...extra,
    }) as AgentAnswerJobBody;

/** An agent API whose answer stream yields what the test pushes; the results sent are kept. */
function fakeApi(): { api: AgentApi; push: (item: AnswerStreamItem) => void; results: { job: string; result: Record<string, unknown> }[] } {
    const items: AnswerStreamItem[] = [];
    let wake: () => void = () => {};
    const results: { job: string; result: Record<string, unknown> }[] = [];
    const api = {
        async *answerEvents(signal: AbortSignal): AsyncGenerator<AnswerStreamItem> {
            yield { kind: 'open' };
            for (;;) {
                const item = items.shift();
                if (item) {
                    yield item;
                    continue;
                }
                if (signal.aborted) return;
                await new Promise<void>((resolve) => {
                    wake = resolve;
                    signal.addEventListener('abort', () => resolve(), { once: true });
                });
            }
        },
        answerResult: async (j: string, result: Readonly<Record<string, unknown>>) => {
            results.push({ job: j, result: { ...result } });
            return { ok: true as const, value: {} };
        },
    } as unknown as AgentApi;
    return {
        api,
        push: (item) => {
            items.push(item);
            wake();
        },
        results,
    };
}

/** An agent that answers each turn with the next of `outputs` (a function: it waits for the turn's signal). */
function fakeAgent(
    outputs: (AnswerTurnResult | ((turn: AnswerTurn) => Promise<AnswerTurnResult>))[],
): AnswerAgent & { turns: { kind: string; turn: AnswerTurn }[]; resets: string[] } {
    const turns: { kind: string; turn: AnswerTurn }[] = [];
    const resets: string[] = [];
    const next = async (kind: string, turn: AnswerTurn): Promise<AnswerTurnResult> => {
        turns.push({ kind, turn });
        const o = outputs.shift() ?? { text: '', error: 'no output planned' };
        return typeof o === 'function' ? o(turn) : o;
    };
    return {
        triage: (t) => next('triage', t),
        answer: (t) => next('answer', t),
        interview: (t) => next('interview', t),
        command: (t) => next(`command:${t.type}`, t),
        reset: (r) => void resets.push(r),
        turns,
        resets,
    };
}

async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out');
        await Bun.sleep(5);
    }
}

const sleep = { sleep: (ms: number) => Bun.sleep(Math.min(ms, 10)), every: () => () => {} };

function start(api: AgentApi, agent: AnswerAgent, scans: ReadonlyMap<string, string>[] = [], timeoutMs?: number, practice?: Practice) {
    const log: string[] = [];
    let scan = 0;
    let nonce = 0;
    const answerer = startAnswerer(
        {
            api,
            agent,
            workspace: { scan: async () => scans[Math.min(scan++, scans.length - 1)] ?? new Map() },
            clock: sleep,
            nonce: () => `n${++nonce}`,
            log: (l) => log.push(l),
        },
        { ...(timeoutMs !== undefined && { timeoutMs }), reconnect: { minMs: 10, maxMs: 10, giveUpMs: 1_000 }, ...(practice && { practice }) },
    );
    return { answerer, log };
}

describe('the answerer role', () => {
    test("stage 3: the light model's verdict from the message, the chat and the open proposals, sent as its wire kind", async () => {
        const { api, push, results } = fakeApi();
        const agent = fakeAgent([{ structured: { kind: 'change_request', confidence: 0.85, reason: '変更を求めている' }, text: '', model: 'claude-haiku' }]);
        const { answerer, log } = start(api, agent);
        push({
            kind: 'job',
            job: job('triage', 1, {
                chat: ['Ada: hi', 'Bob: Order とは？'],
                openProposals: [
                    { content: { targets: [{ kind: 'DtElement', element: 'Sales.Order' }], how: 'H', options: [] } },
                ] as unknown as AgentAnswerJobBody['openProposals'],
            }),
        });
        await waitFor(() => results.length === 1);
        expect(results[0].job).toBe('job-1');
        expect(results[0].result).toMatchObject({ kind: 'change_request', confidence: 0.85, reason: '変更を求めている', model: 'claude-haiku' });
        expect(typeof results[0].result.durationMs).toBe('number');
        const prompt = agent.turns[0].turn.prompt;
        expect(agent.turns[0].kind).toBe('triage');
        expect(prompt).toContain('<message-n1>');
        expect(prompt).toContain('Bob: Order とは？');
        // the open proposals as the answerer wrote them: element references, the how
        expect(prompt).toContain('"@{Sales.Order}"');
        expect(prompt).toContain('"how": "H"');
        // the log has kinds and IDs, never the message
        expect(log.join('\n')).not.toContain('Order');
        await answerer.stop();
    });

    test('an answer, then an override to a proposal; a warm process gets the session so far since its last job and the files changed', async () => {
        const { api, push, results } = fakeApi();
        const agent = fakeAgent([
            { structured: { kind: 'answer', answer: 'Order は注文です。' }, text: '' },
            { structured: { kind: 'proposal', proposal: { targets: ['@{Sales.Order}'], how: 'H' }, reason: '依頼だった' }, text: '' },
        ]);
        const scans = [new Map([['a.dt', '1']]), new Map([['a.dt', '1']]), new Map([['a.dt', '2']]), new Map([['a.dt', '2']])];
        const { answerer } = start(api, agent, scans);
        push({ kind: 'job', job: job('answer', 1, { sessionSoFar: { text: 'FULL-1', last: 3 }, readRevision: REVISION }) });
        await waitFor(() => results.length === 1);
        expect(results[0].result).toMatchObject({ kind: 'answer', answer: 'Order は注文です。', readRevision: REVISION });
        // the answer is Markdown for a narrow column: the conclusion first, short, one heading level, no links or images
        expect(agent.turns[0].turn.prompt).toContain('use at most one heading level (`#`), and no links or');
        expect(agent.turns[0].turn.prompt).toContain('Start with the conclusion, in the first one or two sentences.');
        expect(agent.turns[0].turn.prompt).toContain('Keep it short');
        expect(agent.turns[0].turn.prompt).toContain('when more is needed, keep only the points that matter');
        // a fresh process: the whole session so far, no continued prompt
        expect(agent.turns[0].turn.prompt).toContain('FULL-1');
        expect(agent.turns[0].turn.continuedPrompt).toBeUndefined();
        push({ kind: 'job', job: job('answer', 2, { sessionSoFar: { text: 'FULL-2', last: 5 }, sessionSoFarSince: { text: 'SINCE-3', last: 5, since: 3 } }) });
        await waitFor(() => results.length === 2);
        expect(results[1].result).toMatchObject({ kind: 'proposal', proposal: { targets: ['@{Sales.Order}'], how: 'H' }, reason: '依頼だった' });
        expect(agent.turns[1].turn.prompt).toContain('FULL-2');
        const continued = agent.turns[1].turn.continuedPrompt ?? '';
        expect(continued).toContain('SINCE-3');
        expect(continued).not.toContain('FULL-2');
        expect(continued).toContain('"changedSinceYourLastAnswer": [\n    "a.dt"\n  ]');
        await answerer.stop();
    });

    test('a propose job: the proposal; anything else or an invalid output is a failure, with why', async () => {
        const { api, push, results } = fakeApi();
        const agent = fakeAgent([
            { structured: { kind: 'proposal', proposal: { targets: ['@{Sales.Order}', 'sales/order.dt'], how: 'H' } }, text: '' },
            { structured: { kind: 'answer', answer: 'no' }, text: '' },
            { structured: { kind: 'answer' }, text: '' },
            { text: '', error: 'claude exited with 1' },
        ]);
        const { answerer } = start(api, agent);
        push({ kind: 'job', job: job('propose', 1) });
        push({ kind: 'job', job: job('propose', 2) });
        push({ kind: 'job', job: job('answer', 3) });
        push({ kind: 'job', job: job('triage', 4) });
        await waitFor(() => results.length === 4);
        // sent as read: the path dropped
        expect(results[0].result).toMatchObject({ proposal: { targets: ['@{Sales.Order}'], how: 'H' } });
        expect(results[1].result).toMatchObject({ error: 'no proposal (answer)' });
        expect(results[2].result).toMatchObject({ error: 'invalid output (reply.answer)' });
        expect(results[3].result).toMatchObject({ error: 'claude exited with 1' });
        // the propose prompt asks for a proposal, never to carry it out
        expect(agent.turns[0].turn.prompt).toContain('Do not carry it out.');
        expect(agent.turns[0].turn.prompt).toContain('Read, Grep and Glob are your only tools');
        await answerer.stop();
    });

    test('a proposal with options is clamped to three with one recommended before it is sent', async () => {
        const { api, push, results } = fakeApi();
        const option = (label: string, recommended?: boolean): object => ({
            label,
            targets: ['@{Sales.Order}'],
            ...(recommended !== undefined && { recommended }),
        });
        const agent = fakeAgent([
            {
                structured: { kind: 'proposal', proposal: { targets: [], how: 'H', options: [option('a'), option('b'), option('c'), option('d', true)] } },
                text: '',
            },
        ]);
        const { answerer } = start(api, agent);
        push({ kind: 'job', job: job('propose', 1) });
        await waitFor(() => results.length === 1);
        const sent = results[0].result.proposal as { options: { label: string; recommended: boolean }[] };
        expect(sent.options.map((o) => [o.label, o.recommended])).toEqual([
            ['a', false],
            ['b', false],
            ['d', true],
        ]);
        await answerer.stop();
    });

    test('the propose prompt asks for element references and a short how, options only when unsure, no file paths', () => {
        const prompt = buildProposePrompt(job('propose', 1), 'n');
        expect(prompt).toContain('as element references (`@{Sales.Order}`');
        expect(prompt).toContain('Never a file\n  name or a path');
        expect(prompt).toContain('in one or two short lines');
        expect(prompt).toContain('no alternatives in prose');
        expect(prompt).toContain('only when you are genuinely unsure');
        expect(prompt).toContain('two or three, never more');
        expect(prompt).toContain('Mark exactly one recommended');
        expect(prompt).not.toMatch(/\bwhere\b \(at most/);
    });

    test('the answer and propose prompts give the ways of working of the DSLs the message is about: .dtes, .dt, both or none', async () => {
        const practice = { storming: '### Event Storming with DomainTrail\n\nSTORMING', modeling: '### Modeling with DomainTrail\n\nMODELING' };
        const about = (...targets: AgentAnswerJobBody['request']['targets'][number]['target'][]): Partial<AgentAnswerJobBody> =>
            ({
                request: { ...job('answer', 1).request, targets: targets.map((target) => ({ target, sourceRevision: REVISION })) },
            }) as Partial<AgentAnswerJobBody>;
        const dtes = about({ kind: 'DtesStorming', storming: 'Returns' });
        const dt = about({ kind: 'DtElement', element: 'Sales.Order' });
        const both = about({ kind: 'DtesElement', storming: 'Returns', local: 'ReturnRequested' }, { kind: 'DtElement', element: 'Sales.Order' });
        for (const build of [buildAnswerPrompt, buildProposePrompt]) {
            const prompt = (extra: Partial<AgentAnswerJobBody>): string => build(job('answer', 1, extra), 'n', { practice });
            const has = (p: string): boolean[] => [p.includes('STORMING'), p.includes('MODELING')];
            expect(has(prompt(dtes))).toEqual([true, false]);
            expect(has(prompt(dt))).toEqual([false, true]);
            expect(has(prompt(both))).toEqual([true, true]);
            const none = prompt({});
            expect(none).toContain(`${practice.storming}\n\n${practice.modeling}`);
            // read-only still: the practice's commands and edits are not the answerer's; outside the block of data
            expect(none).toContain('You still change nothing\nand run nothing');
            expect(none.indexOf('MODELING')).toBeLessThan(none.indexOf('<message-n>'));
            expect(build(job('answer', 1), 'n')).not.toContain('How the people work');
        }
        // the answerer passes its practice to both of a warm process's prompts
        const { api, push } = fakeApi();
        const agent = fakeAgent([{ text: '', structured: { kind: 'answer', answer: 'ok' } }]);
        const { answerer } = start(api, agent, [new Map(), new Map()], undefined, practice);
        push({ kind: 'job', job: job('answer', 1, dtes) });
        await waitFor(() => agent.turns.length === 1);
        expect(agent.turns[0].turn.prompt).toContain('STORMING');
        expect(agent.turns[0].turn.prompt).not.toContain('MODELING');
        await answerer.stop();
    });

    test('a withdrawn job is stopped and not answered; one past its timeout is reported as failed; a restore resets the agent', async () => {
        const { api, push, results } = fakeApi();
        const hang = (turn: AnswerTurn): Promise<AnswerTurnResult> =>
            new Promise((resolve) => turn.signal.addEventListener('abort', () => resolve({ text: '', error: 'stopped' }), { once: true }));
        const agent = fakeAgent([hang, hang]);
        const { answerer, log } = start(api, agent, [], 100);
        push({ kind: 'job', job: job('answer', 1) });
        await waitFor(() => agent.turns.length === 1);
        push({ kind: 'withdrawn', job: 'job-1' });
        push({ kind: 'job', job: job('answer', 2) });
        await waitFor(() => results.length === 1);
        expect(results).toEqual([{ job: 'job-2', result: { error: 'timed out', durationMs: 100 } }]);
        expect(log).toContain('answer job job-1: stopped');
        push({ kind: 'restored' });
        await waitFor(() => agent.resets.length === 1);
        push({ kind: 'closed' });
        expect(await answerer.done).toBe('closed');
    });

    test("an interview's turn: the interviewer's prompt (what to find out, the language, the transcript), a question or a brief", async () => {
        const { api, push, results } = fakeApi();
        const lines = ['目的', '範囲', '使い道', 'レベル'].map((head) => ({ head, text: 'x' }));
        const agent = fakeAgent([
            { structured: { kind: 'question', question: 'どの業務ですか？' }, text: '', model: 'opus' },
            { structured: { kind: 'brief', brief: { name: 'Returns', label: '返品', isNew: true, replaces: false, lines } }, text: '' },
            { structured: { kind: 'brief', brief: { name: '返品', isNew: true, replaces: false, lines } }, text: '' },
        ]);
        const { answerer, log } = start(api, agent);
        const interview = (n: number, language: 'ja' | 'en' = 'ja'): AgentInterviewJobBody =>
            ({
                job: `job-${n}`,
                kind: 'interview',
                interview: { id: 'i-1', focus: { kind: 'DtesStorming', storming: 'Returns' } },
                request: { id: REQUEST },
                author: 'Ada',
                timeoutMs: 5_000,
                command: 'es:start',
                language,
                transcript: [{ from: 'person', text: 'ES を始める' }],
                sessionSoFar: { text: 'SO-FAR', last: 1 },
            }) as unknown as AgentInterviewJobBody;
        push({ kind: 'job', job: interview(1) });
        await waitFor(() => results.length === 1);
        expect(results[0].result).toMatchObject({ kind: 'question', question: 'どの業務ですか？', model: 'opus' });
        const prompt = agent.turns[0].turn.prompt;
        expect(agent.turns[0].kind).toBe('interview');
        for (const part of [
            'One question per turn',
            'Write in Japanese',
            'the first and the last events',
            '目的 / 範囲 / 使い道 / レベル',
            '"focus": "@{es:Returns}"',
            'SO-FAR',
            '<interview-n1>',
        ])
            expect(prompt).toContain(part);
        expect(prompt).toContain('their `///` descriptions above `storming`');
        push({ kind: 'job', job: interview(2, 'en') });
        await waitFor(() => results.length === 2);
        expect(agent.turns[1].turn.prompt).toContain('Write in English');
        expect(results[1].result).toMatchObject({ kind: 'brief', brief: { name: 'Returns', label: '返品', isNew: true, lines } });
        // an invalid brief is reported as failed
        push({ kind: 'job', job: interview(3) });
        await waitFor(() => results.length === 3);
        expect(results[2].result).toMatchObject({ error: 'invalid output (reply.brief.name)' });
        expect(log.join('\n')).toContain('interview of interview i-1');
        await answerer.stop();
    });

    test("the interviewer's prompt gives the way of working of its command: /es the storming's, /model the modeling's", () => {
        const practice = { storming: 'STORMING', modeling: 'MODELING' };
        const j = (command: 'es:start' | 'model:start'): AgentInterviewJobBody =>
            ({
                job: 'j',
                kind: 'interview',
                interview: { id: 'i' },
                request: { id: REQUEST },
                author: 'Ada',
                timeoutMs: 1,
                command,
                language: 'ja',
                transcript: [],
            }) as unknown as AgentInterviewJobBody;
        const es = buildInterviewPrompt(j('es:start'), 'n', { practice });
        expect([es.includes('STORMING'), es.includes('MODELING')]).toEqual([true, false]);
        expect(es).toContain('You still change nothing and run');
        expect(es.indexOf('STORMING')).toBeLessThan(es.indexOf('<interview-n>'));
        const model = buildInterviewPrompt(j('model:start'), 'n', { practice });
        expect([model.includes('STORMING'), model.includes('MODELING')]).toEqual([false, true]);
        expect(buildInterviewPrompt(j('es:start'), 'n')).not.toContain('How the people work');
    });
});

describe('the candidate and answer commands of the `/` list', () => {
    const viewedAt = { view: { kind: 'Storming', storming: 'Orders', level: 'BigPicture', stage: 'Payment', exceptions: true } } as const;
    const command = (name: 'es:exceptions' | 'es:recap', n = 1, language: 'ja' | 'en' = 'ja'): AgentCommandJobBody =>
        ({
            job: `job-${n}`,
            kind: 'command',
            command: { id: 'c-1', kind: name === 'es:recap' ? 'EsRecap' : 'EsExceptions', ...(name === 'es:exceptions' && { scope: 'Orders' }) },
            name,
            type: name === 'es:recap' ? 'answer' : 'candidates',
            request: { id: REQUEST, viewedAt },
            author: 'Ada',
            timeoutMs: 5_000,
            language,
            sessionSoFar: { text: 'SO-FAR', last: 3 },
        }) as unknown as AgentCommandJobBody;

    test('/es:exceptions: its prompt, the candidates as read (clamped, references dropped) sent; another kind failed', async () => {
        const { api, push, results } = fakeApi();
        const candidates = Array.from({ length: 13 }, (_, i) => ({ label: `C${i}`, targets: ['@{es:Orders/OrderPaid}', 'x.dtes'], how: 'OrderPaid から' }));
        const agent = fakeAgent([
            { structured: { kind: 'candidates', candidates }, text: '', model: 'opus' },
            { structured: { kind: 'answer', answer: 'x' }, text: '' },
        ]);
        const { answerer, log } = start(api, agent, [], undefined, { storming: 'STORMING', modeling: 'MODELING' });
        push({ kind: 'job', job: command('es:exceptions') });
        await waitFor(() => results.length === 1);
        expect(agent.turns[0].kind).toBe('command:candidates');
        const sent = results[0].result as { candidates: { targets: string[] }[]; model: string };
        expect(sent.candidates).toHaveLength(12);
        expect(sent.candidates[0]?.targets).toEqual(['@{es:Orders/OrderPaid}']);
        expect(sent.model).toBe('opus');
        const prompt = agent.turns[0].turn.prompt;
        for (const part of [
            'ran `/es:exceptions` on the storming @{es:Orders}',
            'a failure, a cancellation, a timeout, missing input,\na rejection',
            'each as one `exception` timeline to add',
            'a stage in view, its steps only',
            'a short past-tense phrase',
            'only an event that is a detail of the mechanism gets `level design`',
            'Write the labels, how and reasons in Japanese',
            'STORMING',
            '"storming": "@{es:Orders}"',
            '"stage": "Payment"',
            'SO-FAR',
            '<command-n1>',
        ])
            expect(prompt).toContain(part);
        expect(prompt).not.toContain('MODELING');
        push({ kind: 'job', job: command('es:exceptions', 2) });
        await waitFor(() => results.length === 2);
        expect(results[1].result).toMatchObject({ error: 'invalid output (reply.kind)' });
        expect(log.join('\n')).toContain('command of command c-1');
        await answerer.stop();
    });

    test('/es:recap: its prompt (the three parts, from the session so far, the language), the answer sent as Markdown', async () => {
        const { api, push, results } = fakeApi();
        const agent = fakeAgent([{ structured: { kind: 'answer', answer: '**Decided**\n- the exceptions of Payment' }, text: '' }]);
        const { answerer } = start(api, agent);
        push({ kind: 'job', job: command('es:recap', 1, 'en') });
        await waitFor(() => results.length === 1);
        expect(agent.turns[0].kind).toBe('command:answer');
        expect(results[0].result).toMatchObject({ kind: 'answer', answer: '**Decided**\n- the exceptions of Payment' });
        const prompt = agent.turns[0].turn.prompt;
        for (const part of ['ran `/es:recap`', 'what was decided', 'what is still open', '"Decided", "Added or changed", "Open"', 'Write in English', 'SO-FAR'])
            expect(prompt).toContain(part);
        expect(prompt).not.toContain('「決まったこと」');
        expect(prompt).not.toContain('"storming": "@{es:Orders}",\n  "viewedAt"');
        await answerer.stop();
    });

    test('a command without a prompt of its own is refused before the agent is asked', () => {
        expect(() => buildCommandPrompt({ ...command('es:recap'), name: 'es:levels' }, 'n')).toThrow('No prompt for the command /es:levels');
    });
});

describe('where the requester was looking', () => {
    const viewedAt = { view: { kind: 'Storming', storming: 'OrderToCash', level: 'DesignLevel', exceptions: false } } as const;
    const shown = { view: 'storming', storming: '@{es:OrderToCash}', level: 'design', exceptions: false };
    /** The JSON of a prompt's block. */
    const data = (prompt: string, tag: string): Record<string, unknown> =>
        JSON.parse(prompt.slice(prompt.indexOf(`<${tag}-n>`) + `<${tag}-n>`.length, prompt.indexOf(`</${tag}-n>`))) as Record<string, unknown>;
    const viewed = job('answer', 1, { request: { ...job('answer', 1).request, viewedAt } } as Partial<AgentAnswerJobBody>);

    test('stage 3, the answer and the proposal get the message with its view, and say what "here" is', () => {
        for (const build of [buildTriagePrompt, buildAnswerPrompt, buildProposePrompt]) {
            const prompt = build(viewed, 'n');
            expect((data(prompt, 'message').message as Record<string, unknown>).viewedAt).toEqual(shown);
            expect(prompt).toContain('`message.viewedAt`');
            expect((data(build(job('answer', 1), 'n'), 'message').message as Record<string, unknown>).viewedAt).toBeUndefined();
        }
        expect(buildTriagePrompt(viewed, 'n')).toContain('(「ここに…を足して」 asks\nfor a change there)');
        const answer = buildAnswerPrompt(viewed, 'n');
        expect(answer).toContain('"here", "this", 「ここ」「この」 without a target mean that view');
        expect(answer).toContain('A proposal for a request sent from a stage adds within that stage');
    });

    test("the interviewer gets the starter's view as a hint", () => {
        const interview = {
            job: 'j',
            kind: 'interview',
            interview: { id: 'i' },
            request: { id: REQUEST, viewedAt },
            author: 'Ada',
            timeoutMs: 1,
            command: 'es:start',
            language: 'ja',
            transcript: [],
        } as unknown as AgentInterviewJobBody;
        const prompt = buildInterviewPrompt(interview, 'n');
        expect(data(prompt, 'interview').viewedAt).toEqual(shown);
        expect(prompt).toContain('`viewedAt`, when present, is where the person is looking');
    });
});
