// What the running runs are doing (ADR 0026, amendment): the latest activity per run, in memory, dropped when the run
// ends. The lease is checked by the caller (`heldRunningRun`, test/collaboration-use-cases.test.ts).
import { describe, expect, test } from 'bun:test';
import { createRunActivities } from './activities.js';

describe("the running runs' activities", () => {
    test('the latest activity per run; the same one again changes nothing', () => {
        const activities = createRunActivities();
        expect(activities.all()).toEqual({});
        expect(activities.set('r1', { phase: 'reading', subject: 'a.dt' })).toBe(true);
        expect(activities.set('r1', { phase: 'reading', subject: 'a.dt' })).toBe(false);
        expect(activities.set('r1', { phase: 'editing', subject: 'a.dt' })).toBe(true);
        expect(activities.set('r2', { phase: 'checking', subject: 'dt check' })).toBe(true);
        expect(activities.all()).toEqual({ r1: { phase: 'editing', subject: 'a.dt' }, r2: { phase: 'checking', subject: 'dt check' } });
    });

    test("a run's activity is dropped when it ends, and is not kept anywhere else", () => {
        const activities = createRunActivities();
        activities.set('r1', { phase: 'finishing' });
        expect(activities.end('r1')).toBe(true);
        expect(activities.end('r1')).toBe(false);
        expect(activities.all()).toEqual({});
        // a store made again (a server started again) knows none
        expect(createRunActivities().all()).toEqual({});
    });
});
