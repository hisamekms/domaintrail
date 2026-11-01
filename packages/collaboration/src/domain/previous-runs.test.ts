// Replies to runs (ADR 0026, amendment "replies to runs"): which previous runs a run is given, within its budget (the use
// cases and the route: test/session-replies.test.ts).
import { describe, expect, test } from 'bun:test';
import { Collaboration as C } from '../generated/index.js';
import { laterRunOf } from './marks.js';
import { boundChanges, fileDiff, previousRunIds } from './previous-runs.js';

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
    return r.value;
};

const facilitator = value(C.makeParticipantId('facilitator'));
const text = (t: string): C.Text => value(C.makeText(t));

describe('the budget of previous runs', () => {
    const diff = (unified: string, added: number) => ({ kind: 'diff' as const, unified, added, removed: 0, truncated: false });
    const file = (p: string, unified: string, added = 1) => ({ path: p, status: 'changed' as const, diff: diff(unified, added) });

    test('in order, a run whose whole diff fits what is left gets it; the others their files; unrecorded stays so', () => {
        const big = [file('a.dt', '@@ -1 +1,2 @@\n+' + 'x'.repeat(100) + '\n', 1)];
        const small = [file('b.dtes', '@@ -1 +1 @@\n+y\n')];
        const sizeOf = (files: typeof big): number => files.map((f) => fileDiff(f)?.length ?? 0).reduce((a, b) => a + b, 0);
        const both = boundChanges([big, small, undefined], sizeOf(big) + sizeOf(small));
        expect(both.map((c) => c.kind)).toEqual(['diff', 'diff', 'unrecorded']);
        // the first is too large for the budget: its files; the second still fits
        const degraded = boundChanges([big, small], sizeOf(small));
        expect(degraded).toEqual([
            { kind: 'files', files: [{ path: 'a.dt', status: 'changed' }], added: 1, removed: 0, diffOmitted: true },
            { kind: 'diff', files: [{ path: 'b.dtes', status: 'changed' }], diff: fileDiff(small[0]) ?? '' },
        ]);
        // a file without a complete diff (too large, cut) gives the run's files only
        expect(boundChanges([[{ path: 'c.dt', status: 'changed', diff: { kind: 'tooLarge' } }]], 1_000_000)[0].kind).toBe('files');
        expect(fileDiff({ path: 'n.dt', status: 'added', diff: diff('@@ -0,0 +1 @@\n+z', 1) })).toBe('--- /dev/null\n+++ b/n.dt\n@@ -0,0 +1 @@\n+z\n');
        expect(fileDiff({ path: 'o.dt', status: 'removed', diff: diff('@@ -1 +0,0 @@\n-z\n', 0) })).toBe('--- a/o.dt\n+++ /dev/null\n@@ -1 +0,0 @@\n-z\n');
    });

    test('a reply run closes the votes of the run it replies to, as the run that continues its card', () => {
        const replied = { id: 'x', state: 'Completed', input: { requests: [{ request: 'm' }] }, baseRevision: 'b' };
        const reply = { id: 'y', state: 'Queued', input: { requests: [{ request: 'r', replyTo: 'x' }] } };
        const unrelated = { id: 'z', state: 'Queued', input: { requests: [{ request: 's' }] } };
        expect(laterRunOf(replied, [replied, unrelated])).toBeUndefined();
        expect(laterRunOf(replied, [replied, unrelated, reply])?.id).toBe('y');
    });

    test('a pick closes the votes of the run it picked from, and that run is a previous run of it', () => {
        const done = { id: 'x', state: 'Completed', input: { requests: [{ request: 'm' }] }, baseRevision: 'b' };
        const pick = { id: 'y', state: 'Queued', input: { requests: [{ request: 'm' }], pick: { pickOf: 'x' } } };
        const other = { id: 'z', state: 'Queued', input: { requests: [{ request: 's' }], pick: { pickOf: 'w' } } };
        expect(laterRunOf(done, [done, other])).toBeUndefined();
        expect(laterRunOf(done, [done, other, pick])?.id).toBe('y');
        const frozen = { request: C.makeRequestId('00000000-0000-4000-8000-000000000001'), author: facilitator, targets: [], body: text('m') };
        const x = C.makeAgentRunId('00000000-0000-4000-8000-00000000000a');
        const y = C.makeAgentRunId('00000000-0000-4000-8000-00000000000b');
        const alternative = { id: value(C.makeReplyKey('net')), label: text('Without tax') };
        const pickOf = (of: C.AgentRunId): C.AlternativePick => ({ pickOf: of, assumption: value(C.makeTally(0)), text: text('With tax'), alternative });
        expect(previousRunIds({ requests: [frozen], pick: pickOf(x) })).toEqual([x]);
        // after the runs replied to, once
        expect(previousRunIds({ requests: [{ ...frozen, replyTo: y }], pick: pickOf(x) })).toEqual([y, x]);
        expect(previousRunIds({ requests: [{ ...frozen, replyTo: x }], pick: pickOf(x) })).toEqual([x]);
    });
});
