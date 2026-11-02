// Reporting what a running run is doing (ADR 0026, amendment): a change only, at most once per gap (the latest waiting
// one replacing an older one), never awaited, a failure logged and ignored, nothing once stopped.
import { describe, expect, test } from 'bun:test';
import type { RunActivity } from '@domaintrail/collaboration/protocol';
import { createActivityReporter } from './activity.js';
import type { ApiResult, Clock } from './ports.js';

/** A clock whose sleeps end when the test says (`pass`), or when aborted. */
function manualClock(): Clock & { pass(): Promise<void>; sleeping(): number } {
    let waiting: (() => void)[] = [];
    return {
        sleep: (_ms, signal) =>
            new Promise<void>((resolve) => {
                waiting.push(resolve);
                signal?.addEventListener('abort', () => resolve(), { once: true });
            }),
        every: () => () => {},
        async pass() {
            const now = waiting;
            waiting = [];
            for (const resolve of now) resolve();
            // the reporter's continuations run
            await Bun.sleep(0);
        },
        sleeping: () => waiting.length,
    };
}

const reading = (subject: string): RunActivity => ({ phase: 'reading', subject });

describe('reporting what the agent is doing', () => {
    test('the first at once, a change after the gap (the latest waiting one), the same one never again', async () => {
        const clock = manualClock();
        const sent: RunActivity[] = [];
        const reporter = createActivityReporter({ send: async (a) => (sent.push(a), { ok: true, value: {} }), clock, log: () => {} });
        reporter.report(reading('a.dt'));
        reporter.report(reading('a.dt'));
        expect(sent).toEqual([reading('a.dt')]);
        // within the gap: only the latest is kept
        reporter.report(reading('b.dt'));
        reporter.report({ phase: 'editing', subject: 'b.dt' });
        expect(sent).toHaveLength(1);
        await clock.pass();
        expect(sent).toEqual([reading('a.dt'), { phase: 'editing', subject: 'b.dt' }]);
        // back and forth within a gap, ending where it was sent last: nothing to send
        reporter.report({ phase: 'checking', subject: 'dt check' });
        reporter.report({ phase: 'editing', subject: 'b.dt' });
        await clock.pass();
        expect(sent).toHaveLength(2);
        // the gap has passed: a change goes at once
        await clock.pass();
        reporter.report({ phase: 'finishing' });
        expect(sent.at(-1)).toEqual({ phase: 'finishing' });
    });

    test('never awaited: a report that does not answer holds nothing up; a failure is logged and ignored', async () => {
        const clock = manualClock();
        const logged: string[] = [];
        let calls = 0;
        const send = (): Promise<ApiResult<unknown>> => {
            calls++;
            if (calls === 1) return new Promise(() => {});
            if (calls === 2) return Promise.resolve({ ok: false, status: 409, type: 'LeaseLost' });
            return Promise.reject(new Error('connection refused'));
        };
        const reporter = createActivityReporter({ send, clock, log: (line) => logged.push(line) });
        reporter.report(reading('a.dt'));
        await clock.pass();
        reporter.report(reading('b.dt'));
        await clock.pass();
        reporter.report(reading('c.dt'));
        await Bun.sleep(0);
        expect(calls).toBe(3);
        expect(logged).toEqual(['activity refused (409 LeaseLost)', 'activity failed: connection refused']);
    });

    test('once stopped, nothing more is sent, not even what was waiting', async () => {
        const clock = manualClock();
        const sent: RunActivity[] = [];
        const reporter = createActivityReporter({ send: async (a) => (sent.push(a), { ok: true, value: {} }), clock, log: () => {} });
        reporter.report(reading('a.dt'));
        reporter.report(reading('b.dt'));
        reporter.stop();
        await clock.pass();
        reporter.report({ phase: 'finishing' });
        expect(sent).toEqual([reading('a.dt')]);
        expect(clock.sleeping()).toBe(0);
    });
});
