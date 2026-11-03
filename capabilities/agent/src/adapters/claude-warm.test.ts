// The warm runner of the runs (plan modes, the warm agent) and the warm process under it, against a fake `claude`
// speaking stream-json (`test-fixtures/warm-claude.mjs`): one process across runs, the structured reply of each turn,
// the prompt that says what changed since the last run, the interrupt on cancel, the restart triggers, a crash, the
// fall-back to cold runs, the notifications of the user's hooks, and the idle timeout.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { AgentInvocation, AgentOutcome, AgentRunner } from '../core/ports.js';
import { createWarmClaudeRunner, type WarmRunnerOptions } from './claude-warm.js';

const FAKE = path.join(import.meta.dir, '..', '..', 'test-fixtures', 'warm-claude.mjs');
const TOOLS = ['Read', 'Edit'];

interface Logged {
    pid: number;
    args: string[];
    prompt: string;
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

async function waitFor(what: string, check: () => boolean, ms = 5_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(20);
    }
}

/** A runner on a scratch root with the fake following `steps`, its log lines, and what the fake logged. */
async function setup(
    steps: Record<string, unknown>[],
    options: Partial<WarmRunnerOptions> = {},
): Promise<{ runner: AgentRunner; log: string[]; logged: () => Logged[]; root: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-warm-'));
    const plan = path.join(root, '..', `${path.basename(root)}.plan.json`);
    await writeFile(plan, JSON.stringify({ runs: steps }));
    const log: string[] = [];
    const runner = await createWarmClaudeRunner({
        root,
        command: { command: process.execPath, args: [FAKE, plan] },
        log: (l) => log.push(l),
        interruptGraceMs: 300,
        closeGraceMs: 100,
        startTimeoutMs: 2_000,
        ...options,
    });
    cleanups.push(async () => {
        await runner.close?.();
        await rm(root, { recursive: true, force: true });
        await rm(plan, { force: true });
        await rm(`${plan}.log`, { force: true });
    });
    const logged = (): Logged[] =>
        existsSync(`${plan}.log`)
            ? readFileSync(`${plan}.log`, 'utf8')
                  .split('\n')
                  .filter(Boolean)
                  .map((l) => JSON.parse(l) as Logged)
            : [];
    return { runner, log, logged, root };
}

const invocation = (n: number, extra: Partial<AgentInvocation> = {}): AgentInvocation => ({
    prompt: `prompt ${n}`,
    continuedPrompt: `continued ${n}`,
    allowedTools: TOOLS,
    requests: 1,
    signal: new AbortController().signal,
    ...extra,
});

const reply = (summary: string, outcome = 'done'): Record<string, unknown> => ({
    outcome,
    title: 'T',
    summary,
    requests: [{ request: 1, status: outcome === 'declined' ? 'skipped' : 'done', ...(outcome === 'declined' && { note: 'no' }) }],
});

describe('the warm runner', () => {
    test('one process takes the runs, one turn each, with the structured reply of each; the next turns get the continued prompt', async () => {
        const { runner, log, logged } = await setup([{ reply: reply('First.') }, { reply: reply('Second.') }], { model: 'sonnet', effort: 'low' });
        const activities: string[] = [];
        const first = await runner.run(invocation(1, { onActivity: (a) => activities.push(a.phase) }));
        const second = await runner.run(invocation(2));
        expect([first.exitCode, first.summary, first.reply?.summary]).toEqual([0, 'First.', 'First.']);
        expect([second.exitCode, second.summary]).toEqual([0, 'Second.']);
        const [a, b] = logged();
        expect(b.pid).toBe(a.pid);
        // the first turn of a process is fresh; the next continues it
        expect([a.prompt, b.prompt]).toEqual(['prompt 1', 'continued 2']);
        expect(a.args.slice(0, 3)).toEqual(['--print', '--input-format', 'stream-json']);
        expect(a.args.slice(a.args.indexOf('--model'), a.args.indexOf('--model') + 4)).toEqual(['--model', 'sonnet', '--effort', 'low']);
        // the schema of a process takes up to 20 requests; the reply is still checked against the run's count
        const schema = JSON.parse(a.args[a.args.indexOf('--json-schema') + 1]) as { properties: { requests: { maxItems: number } } };
        expect(schema.properties.requests.maxItems).toBe(20);
        expect(activities).toEqual(['reading', 'finishing']);
        // the user's Stop hook notifies on every turn: logged once, nothing else
        expect(log.filter((l) => l.includes('notified "stop-hook-error"'))).toHaveLength(1);
        expect(log.filter((l) => l.includes('started a warm'))).toHaveLength(1);
    });

    test('an error result is a run that exited 1; the process stays', async () => {
        const { runner, logged } = await setup([{ error: true }, {}]);
        expect((await runner.run(invocation(1))).exitCode).toBe(1);
        expect((await runner.run(invocation(2))).exitCode).toBe(0);
        expect(new Set(logged().map((l) => l.pid)).size).toBe(1);
    });

    test('a cancel interrupts the turn: the process stays and takes the next run', async () => {
        const { runner, logged } = await setup([{ hang: true }, {}]);
        const cancel = new AbortController();
        const running = runner.run(invocation(1, { signal: cancel.signal }));
        await waitFor('the turn', () => logged().length === 1);
        await Bun.sleep(50);
        cancel.abort();
        const started = Date.now();
        expect((await running).exitCode).toBe(-1);
        expect(Date.now() - started).toBeLessThan(250);
        expect(alive(logged()[0].pid)).toBe(true);
        expect((await runner.run(invocation(2))).exitCode).toBe(0);
        expect(logged()[1]).toMatchObject({ pid: logged()[0].pid, prompt: 'continued 2' });
    });

    test('a turn that does not stop on the interrupt: the process is killed, the next run starts a fresh one', async () => {
        const { runner, log, logged } = await setup([{ hang: true, deaf: true }, {}]);
        const cancel = new AbortController();
        const running = runner.run(invocation(1, { signal: cancel.signal }));
        await waitFor('the turn', () => logged().length === 1);
        await Bun.sleep(50);
        cancel.abort();
        expect((await running).exitCode).toBe(-1);
        await waitFor('the kill', () => !alive(logged()[0].pid));
        expect(log.some((l) => l.includes('an interrupted turn did not stop'))).toBe(true);
        await runner.run(invocation(2));
        expect(logged()[1].pid).not.toBe(logged()[0].pid);
        expect(logged()[1].prompt).toBe('prompt 2');
    });

    const restarts: [string, Record<string, unknown>[], Partial<WarmRunnerOptions>, (runner: AgentRunner) => Promise<AgentOutcome>, string][] = [
        ['after restartAfter runs', [{}, {}, {}], { restartAfter: 2 }, (r) => r.run(invocation(2)), 'after 2 turns'],
        [
            'when a turn passes the context limit',
            [{ context: 5_000 }, {}],
            { contextLimit: 4_000 },
            (r) => r.run(invocation(2)),
            'its context passed 4000 tokens',
        ],
        ['after a declined run', [{ reply: reply('No.', 'declined') }, {}], {}, (r) => r.run(invocation(2)), 'a run was declined'],
        ['when the allowed tools change', [{}, {}], {}, (r) => r.run(invocation(2, { allowedTools: ['Read'] })), 'its tools or reply schema changed'],
        [
            'when a run has more requests than the schema takes',
            [{}, {}],
            {},
            (r) => r.run(invocation(2, { requests: 25 })),
            'its tools or reply schema changed',
        ],
        [
            'after a reset (a restored revision)',
            [{}, {}],
            {},
            (r) => {
                r.reset?.('a revision was restored');
                return r.run(invocation(2));
            },
            'a revision was restored',
        ],
        ['after an unexpected control request of the CLI', [{ ask: true }, {}], {}, (r) => r.run(invocation(2)), 'it sent an unexpected control request'],
    ];
    test.each(restarts)('a fresh process %s', async (_, steps, options, second, why) => {
        const { runner, log, logged } = await setup(steps, options);
        if (options.restartAfter === 2) await runner.run(invocation(0));
        await runner.run(invocation(1));
        await second(runner);
        const all = logged();
        const [before, after] = all.slice(-2);
        expect(after.pid).not.toBe(before.pid);
        // a fresh process gets the full prompt, without what changed since a run it never saw
        expect(after.prompt).toBe('prompt 2');
        expect(log.some((l) => l.includes(`ends (${why})`))).toBe(true);
        await waitFor('the old process to end', () => !alive(before.pid));
    });

    test('a crash during a turn fails the run with its code; the next run starts a fresh process', async () => {
        const { runner, log, logged } = await setup([{ crash: 3 }, {}]);
        expect(await runner.run(invocation(1))).toEqual({ exitCode: 3, outcome: 'done', summary: '' });
        expect((await runner.run(invocation(2))).exitCode).toBe(0);
        const [a, b] = logged();
        expect(b.pid).not.toBe(a.pid);
        expect(b.prompt).toBe('prompt 2');
        expect(log.some((l) => l.includes('failed (it exited with 3 during a turn)'))).toBe(true);
    });

    test('a process that never takes the turn: that run goes cold', async () => {
        const { runner, logged } = await setup([{ die: 4 }, { reply: reply('Cold.') }, {}]);
        const outcome = await runner.run(invocation(1));
        expect([outcome.exitCode, outcome.summary]).toEqual([0, 'Cold.']);
        const [, cold] = logged();
        expect(cold.args).not.toContain('--input-format');
        expect(cold.prompt).toBe('prompt 1');
    });

    test('a turn that shows no sign of life: the process goes, that run goes cold', async () => {
        const { runner, log, logged } = await setup([{ mute: true }, { reply: reply('Cold.') }], { startTimeoutMs: 300 });
        expect((await runner.run(invocation(1))).summary).toBe('Cold.');
        expect(log.some((l) => l.includes('a turn showed no sign of life'))).toBe(true);
        await waitFor('the silent process to end', () => !alive(logged()[0].pid));
    });

    /** The size of `late.txt` in the runner's root, now and a little later. */
    const growth = async (root: string): Promise<[number, number]> => {
        const size = (): number => (existsSync(path.join(root, 'late.txt')) ? readFileSync(path.join(root, 'late.txt'), 'utf8').length : 0);
        const now = size();
        await Bun.sleep(150);
        return [now, size()];
    };

    test('a silent turn whose process still writes: the run ends only once the process is gone, with everything it wrote', async () => {
        const { runner, logged, root } = await setup([{ scribble: 'late.txt' }, {}], { startTimeoutMs: 300 });
        await runner.run(invocation(1));
        expect(alive(logged()[0].pid)).toBe(false);
        const [now, later] = await growth(root);
        expect(now).toBeGreaterThan(0);
        expect(later).toBe(now);
    });

    test('a cancel before the turn started, while its process writes: the run ends only once the process is gone', async () => {
        const { runner, log, logged, root } = await setup([{ scribble: 'late.txt' }]);
        const cancel = new AbortController();
        const running = runner.run(invocation(1, { signal: cancel.signal }));
        await waitFor('the writes', () => existsSync(path.join(root, 'late.txt')));
        cancel.abort();
        expect((await running).exitCode).toBe(-1);
        expect(alive(logged()[0].pid)).toBe(false);
        const [now, later] = await growth(root);
        expect(later).toBe(now);
        expect(log.some((l) => l.includes('killed (a turn was cancelled before it started)'))).toBe(true);
    });

    test('a turn that ignores the interrupt: the run ends only once the process is gone', async () => {
        const { runner, logged } = await setup([{ hang: true, deaf: true }]);
        const cancel = new AbortController();
        const running = runner.run(invocation(1, { signal: cancel.signal }));
        await waitFor('the turn', () => logged().length === 1);
        await Bun.sleep(50);
        cancel.abort();
        await running;
        expect(alive(logged()[0].pid)).toBe(false);
    });

    test('failures in a row: from then on every run is cold, said once', async () => {
        const { runner, log, logged } = await setup([{ crash: 2 }, { crash: 2 }, { crash: 2 }, {}, {}]);
        for (const n of [1, 2, 3]) expect((await runner.run(invocation(n))).exitCode).toBe(2);
        await runner.run(invocation(4));
        await runner.run(invocation(5));
        const all = logged();
        expect(all.slice(3).map((l) => l.args.includes('--input-format'))).toEqual([false, false]);
        expect(all.slice(3).map((l) => l.prompt)).toEqual(['prompt 4', 'prompt 5']);
        expect(log.filter((l) => l.includes('every turn starts its own process (cold)'))).toHaveLength(1);
    });

    test('a success between failures starts the count again', async () => {
        const { runner, logged } = await setup([{ crash: 2 }, { crash: 2 }, {}, { crash: 2 }, { crash: 2 }, {}]);
        for (const n of [1, 2, 3, 4, 5, 6]) await runner.run(invocation(n));
        expect(logged().at(-1)?.args).toContain('--input-format');
    });

    test('close ends the process; a cancelled invocation never starts one', async () => {
        const { runner, logged } = await setup([{}]);
        const cancel = new AbortController();
        cancel.abort();
        expect((await runner.run(invocation(1, { signal: cancel.signal }))).exitCode).toBe(-1);
        expect(logged()).toHaveLength(0);
        await runner.run(invocation(2));
        await runner.close?.();
        expect(alive(logged()[0].pid)).toBe(false);
    });
});

describe('the idle timeout of the warm process', () => {
    test('a process with no turn for the timeout ends, said once; the next run starts a fresh one, no failure', async () => {
        // one failure would turn every run cold: the idle stop must not count as one
        const { runner, log, logged } = await setup([{}, {}], { idleTimeoutMs: 300, maxFailures: 1 });
        await runner.run(invocation(1));
        await waitFor('the idle process to end', () => !alive(logged()[0].pid));
        expect(log.filter((l) => l.includes('ends (no turn for 0.3 s)'))).toHaveLength(1);
        expect((await runner.run(invocation(2))).exitCode).toBe(0);
        const [a, b] = logged();
        expect(b.pid).not.toBe(a.pid);
        // a fresh process: warm, with the plain prompt
        expect(b.args).toContain('--input-format');
        expect(b.prompt).toBe('prompt 2');
        expect(log.some((l) => l.includes('failed'))).toBe(false);
    });

    test('no stop while a turn runs, however long', async () => {
        const { runner, log, logged } = await setup([{ delay: 700 }, {}], { idleTimeoutMs: 200 });
        expect((await runner.run(invocation(1))).exitCode).toBe(0);
        expect((await runner.run(invocation(2))).exitCode).toBe(0);
        const [a, b] = logged();
        expect(b).toMatchObject({ pid: a.pid, prompt: 'continued 2' });
        expect(log.some((l) => l.includes('no turn for'))).toBe(false);
    });

    test('each turn starts the timer again', async () => {
        const { runner, log, logged } = await setup([{}], { idleTimeoutMs: 600 });
        await runner.run(invocation(1));
        await Bun.sleep(350);
        await runner.run(invocation(2));
        await Bun.sleep(350);
        await runner.run(invocation(3));
        // 700 ms since the first turn, 350 since each other
        expect(new Set(logged().map((l) => l.pid)).size).toBe(1);
        expect(log.some((l) => l.includes('no turn for'))).toBe(false);
    });

    test('0: the process is never ended for being idle', async () => {
        const { runner, logged } = await setup([{}], { idleTimeoutMs: 0 });
        await runner.run(invocation(1));
        await Bun.sleep(300);
        expect(alive(logged()[0].pid)).toBe(true);
        await runner.run(invocation(2));
        expect(logged()[1].pid).toBe(logged()[0].pid);
    });
});
