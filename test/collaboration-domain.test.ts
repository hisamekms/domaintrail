// The pure decisions of packages/collaboration/src/domain (ADR 0026): content hashes, the run success rule and the
// diagnostics diff, target staleness, and the transitions of the commands beyond what the generated contract tests
// check (test/collaboration-contract-run.test.ts).
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Diagnostic } from '@domaintrail/modeling/core/diagnostics';
import { Collaboration as C } from '@domaintrail/collaboration/generated/index';
import { agentRunCommands, requestCommands, revisionCommands, sessionCommands } from '@domaintrail/collaboration/domain/commands';
import { compareFiles, lineDiff, MAX_DIFF_LINES, MAX_EDITS, MAX_OUTPUT_LINES } from '@domaintrail/collaboration/domain/compare';
import { sha256Hex } from '@domaintrail/collaboration/domain/sha256';
import { changedPaths, hashBytes, languageOf, snapshotFile, snapshotHash, workspacePath } from '@domaintrail/collaboration/domain/snapshot';
import { decodeOccurrencePath, encodeOccurrencePath, targetStatus, type TargetScope } from '@domaintrail/collaboration/domain/targets';
import { diagnosticsDiff, runReport, succeeded, summarize, tally, unparsedDtes } from '@domaintrail/collaboration/domain/validation';
import { check } from './helpers.js';

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
    return r.value;
};
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const path = (p: string): C.WorkspacePath => value(C.makeWorkspacePath(p));
const at = new Date('2026-10-31T09:00:00Z');
const later = new Date('2026-10-31T10:00:00Z');

describe('content hashes', () => {
    test('sha256Hex agrees with node:crypto, across block boundaries and for multi-byte text', () => {
        for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'context 販売 { }\n']) {
            expect(sha256Hex(bytes(text))).toBe(createHash('sha256').update(text).digest('hex'));
        }
        expect(sha256Hex(bytes('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    test('the snapshot hash depends on paths and file hashes only, not on their order', () => {
        const a = snapshotFile(path('a.dt'), bytes('context A {}'));
        const b = snapshotFile(path('s/b.dtes'), bytes('storming B {}'));
        expect(snapshotHash([a, b])).toBe(snapshotHash([b, a]));
        expect(snapshotHash([a, b])).not.toBe(snapshotHash([a]));
        expect(snapshotHash([a])).not.toBe(snapshotHash([{ ...a, path: path('b.dt') }]));
        expect<string>(snapshotHash([])).toBe(createHash('sha256').update('').digest('hex'));
        expect<string>(snapshotHash([a])).toBe(createHash('sha256').update(`a.dt\u0000${a.hash}\n`).digest('hex'));
    });

    test('a snapshot file carries its language and size', () => {
        expect(snapshotFile(path('x/y.dtes'), bytes('storming Y {}'))).toEqual({
            path: path('x/y.dtes'),
            language: 'Dtes',
            hash: hashBytes(bytes('storming Y {}')),
            bytes: 13,
        });
        expect(languageOf('x.dt')).toBe('Dt');
    });

    test('workspace paths are relative, without dot segments or backslashes', () => {
        expect(value(workspacePath('sales/order.dt'))).toBe(path('sales/order.dt'));
        for (const raw of ['/etc/passwd', '../x.dt', 'a/../b.dt', './a.dt', 'a//b.dt', 'a\\b.dt', '']) {
            expect(workspacePath(raw)).toEqual({ ok: false, error: { type: 'PathOutsideRoot', path: raw } });
        }
    });

    test('changed paths are the added, removed and changed files, sorted', () => {
        const f = (p: string, text: string) => ({ path: path(p), hash: hashBytes(bytes(text)) });
        expect(changedPaths([f('a.dt', '1'), f('b.dt', '1'), f('c.dt', '1')], [f('c.dt', '2'), f('a.dt', '1'), f('d.dt', '1')])).toEqual([
            path('b.dt'),
            path('c.dt'),
            path('d.dt'),
        ]);
        expect(changedPaths([f('a.dt', '1')], [f('a.dt', '1')])).toEqual([]);
    });
});

const diagnostic = (file: string, code: Diagnostic['code'], severity: Diagnostic['severity'], message: string, line = 1): Diagnostic => ({
    file,
    code,
    severity,
    message,
    start: { line, column: 1 },
    end: { line, column: 2 },
});

describe('validation per DSL and the run success rule', () => {
    const base = [
        diagnostic('a.dt', 'M001', 'error', 'Cannot resolve X.'),
        diagnostic('a.dt', 'L001', 'warning', 'No label.'),
        diagnostic('s.dtes', 'S003', 'warning', 'Unused event.'),
        diagnostic('s.dtes', 'S010', 'error', 'The ref names nothing.'),
    ];

    test('the summary splits by DSL, with the link rules apart', () => {
        expect(summarize(base, false)).toEqual({ dtErrors: tally(1), dtesErrors: tally(0), dtesWarnings: tally(1), linkWarnings: tally(1), stale: false });
        expect(summarize([diagnostic('b.dtes', 'SYNTAX', 'error', 'Unexpected }.')], true)).toEqual({
            dtErrors: tally(0),
            dtesErrors: tally(1),
            dtesWarnings: tally(0),
            linkWarnings: tally(0),
            stale: true,
        });
    });

    test('the diff counts new .dt errors as a multiset, ignoring positions, and lists the .dtes files that do not parse', () => {
        const result = [
            diagnostic('a.dt', 'M001', 'error', 'Cannot resolve X.', 7), // moved, the same
            diagnostic('a.dt', 'M001', 'error', 'Cannot resolve X.', 9), // a second one: new
            diagnostic('b.dt', 'M008', 'error', 'Not a Bool.'),
            diagnostic('s.dtes', 'S003', 'warning', 'Unused event.'),
            diagnostic('t.dtes', 'SYNTAX', 'error', 'Unexpected }.'),
        ];
        const diff = diagnosticsDiff(base, result);
        expect(diff.newDtErrors.map((d) => [d.file, d.code, d.start.line])).toEqual([
            ['a.dt', 'M001', 9],
            ['b.dt', 'M008', 1],
        ]);
        expect(diff.resolvedDtErrors).toEqual([]);
        expect(diff.newDtes.map((d) => d.code)).toEqual(['SYNTAX']);
        expect(diff.resolvedDtes.map((d) => d.code)).toEqual(['S010']);
        expect(diff.unparsedDtes).toEqual(['t.dtes']);
        expect(unparsedDtes(base)).toEqual([]);
        expect(runReport({ exitCode: 0, formatted: true, checked: true }, diff)).toEqual({
            exitCode: 0,
            formatted: true,
            checked: true,
            newDtErrors: tally(2),
            unparsedDtes: tally(1),
        });
    });

    test('pre-existing errors and new .dtes warnings do not fail a run', () => {
        const diff = diagnosticsDiff(base, [...base, diagnostic('s.dtes', 'S003', 'warning', 'Another unused event.')]);
        expect(succeeded(runReport({ exitCode: 0, formatted: true, checked: true }, diff))).toBe(true);
    });

    test('a run succeeds only with exit 0, fmt and check run, no new .dt error and every .dtes parsing', () => {
        const ok: C.RunReport = { exitCode: 0, formatted: true, checked: true, newDtErrors: tally(0), unparsedDtes: tally(0) };
        expect(succeeded(ok)).toBe(true);
        for (const broken of [{ exitCode: 1 }, { formatted: false }, { checked: false }, { newDtErrors: tally(1) }, { unparsedDtes: tally(1) }]) {
            expect(succeeded({ ...ok, ...broken })).toBe(false);
        }
    });
});

describe('target staleness', () => {
    const sources = {
        'sales.dt': `context Sales {
  id OrderId: UUID
  aggregate Order {
    id: OrderId
    state Draft
    state Confirmed
    create command place(id: OrderId)
      -> Draft
    command confirm()
      Draft -> Confirmed
  }
}
`,
        'returns.dtes': `storming Returns {
  event Requested
  event Received
  event Rejected
  event Disposed
  hotspot Who "誰が受け取る？"
  timeline Rejecting {
    Requested
    Received
    group Closing {
      Rejected
      Disposed
    }
  }
}
`,
    };
    const scopeOf = async (files: Record<string, string>): Promise<TargetScope> => {
        const a = await check(files);
        return { model: a.model, stormings: a.stormings.stormings, stormingsComplete: a.stormings.syntaxOk };
    };
    const dt = (element: string): C.ModelTarget => ({ kind: 'DtElement', element: value(C.makeElementName(element)) });
    const es = (storming: string, local: string): C.ModelTarget => ({
        kind: 'DtesElement',
        storming: value(C.makeStormingName(storming)),
        local: value(C.makeStormingLocalName(local)),
    });
    const occurrence = (timeline: string, eventName: string, stepPath: number[]): C.ModelTarget => ({
        kind: 'DtesOccurrence',
        storming: value(C.makeStormingName('Returns')),
        timeline: value(C.makeTimelineName(timeline)),
        eventName: value(C.makeStormingEventName(eventName)),
        occurrence: value(C.makeOccurrencePath(encodeOccurrencePath(stepPath))),
    });

    test('targets resolve by model ID, storming and local ID, and timeline, event and step path', async () => {
        const scope = await scopeOf(sources);
        expect(targetStatus({ kind: 'Workspace' }, scope)).toBe('current');
        for (const id of ['Sales.Order', 'Sales.OrderId', 'Sales.Order#Confirmed', 'Sales.Order:confirm']) expect(targetStatus(dt(id), scope)).toBe('current');
        for (const id of ['Sales.Invoice', 'Sales.Order#Shipped', 'Sales.Order:cancel']) expect(targetStatus(dt(id), scope)).toBe('stale');
        expect(targetStatus(es('Returns', 'Who'), scope)).toBe('current');
        expect(targetStatus(es('Returns', 'Closing'), scope)).toBe('current');
        expect(targetStatus(es('Returns', 'Lost'), scope)).toBe('stale');
        expect(targetStatus(es('Refunds', 'Who'), scope)).toBe('stale');
        expect(targetStatus(occurrence('Rejecting', 'Received', [1]), scope)).toBe('current');
        expect(targetStatus(occurrence('Rejecting', 'Disposed', [2, 1]), scope)).toBe('current');
        expect(targetStatus(occurrence('Rejecting', 'Disposed', [2]), scope)).toBe('stale');
        expect(targetStatus(occurrence('Rejecting', 'Requested', [1]), scope)).toBe('stale');
        expect(targetStatus(occurrence('Accepting', 'Requested', [0]), scope)).toBe('stale');
    });

    test('an inserted step makes an occurrence stale: it is never re-bound', async () => {
        const scope = await scopeOf({ ...sources, 'returns.dtes': sources['returns.dtes'].replace('    Requested\n', '    Requested\n    Requested\n') });
        expect(targetStatus(occurrence('Rejecting', 'Received', [1]), scope)).toBe('stale');
        expect(targetStatus(occurrence('Rejecting', 'Received', [2]), scope)).toBe('current');
    });

    test('a target is unknown, not stale, when the sources it would be in do not parse', async () => {
        const scope = await scopeOf({ 'sales.dt': 'context Sales {', 'returns.dtes': 'storming Returns {' });
        expect(targetStatus(dt('Sales.Order'), scope)).toBe('unknown');
        expect(targetStatus(es('Returns', 'Who'), scope)).toBe('unknown');
    });

    test('occurrence paths are one or two indexes', () => {
        expect(encodeOccurrencePath([2, 1])).toBe('2.1');
        expect(decodeOccurrencePath('2.1')).toEqual([2, 1]);
        expect(decodeOccurrencePath('0')).toEqual([0]);
        for (const bad of ['', '01', '1.2.3', '-1', 'a', '1.']) expect(decodeOccurrencePath(bad)).toBeUndefined();
    });
});

describe('transitions', () => {
    const facilitator = value(C.makeParticipantId('facilitator'));
    const guest = value(C.makeParticipantId('guest'));
    const name = value(C.makeDisplayName('Ada'));
    const sessionId = C.makeSessionId('00000000-0000-4000-8000-000000000001');
    const base = C.makeRevisionId('00000000-0000-4000-8000-000000000002');
    const result = C.makeRevisionId('00000000-0000-4000-8000-000000000003');

    test('a session starts with its facilitator, admits a newcomer once, and closes', () => {
        const open = value(sessionCommands.start(sessionId, facilitator, name, at)).Open.aggregate;
        expect(open.participants).toEqual([{ id: facilitator, name, role: 'Facilitator', joinedAt: at }]);
        const joined = value(sessionCommands.join(open, guest, name, later)).Open.aggregate;
        expect(joined.participants.map((p) => [p.id, p.role])).toEqual([
            [facilitator, 'Facilitator'],
            [guest, 'Participant'],
        ]);
        expect(sessionCommands.join(joined, guest, name, later)).toEqual({ ok: false, error: { type: 'AlreadyJoined', participant: guest } });
        expect(value(sessionCommands.close(joined, later)).Closed.aggregate).toMatchObject({ state: 'Closed', closedAt: later });
    });

    test('a request is dismissed as a mark: it keeps its content', () => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stands in for MakeActiveSession's check
        const active = sessionId as C.ActiveSession;
        const target: C.TargetSnapshot = { target: { kind: 'Workspace', scope: 'Dtes' }, sourceRevision: base };
        const body = value(C.makeText('Split the timeline.'));
        const sent = value(requestCommands.send(C.makeRequestId('00000000-0000-4000-8000-000000000004'), active, guest, target, body, at)).Sent.aggregate;
        const dismissed = value(requestCommands.dismiss(sent, facilitator, later));
        expect(dismissed.Dismissed.aggregate).toEqual({ ...sent, state: 'Dismissed', dismissedBy: facilitator, dismissedAt: later });
    });

    const running: C.RunningAgentRun = {
        state: 'Running',
        id: C.makeAgentRunId('00000000-0000-4000-8000-000000000005'),
        session: sessionId,
        input: {
            requests: [
                {
                    request: C.makeRequestId('00000000-0000-4000-8000-000000000004'),
                    author: guest,
                    target: { target: { kind: 'Workspace' }, sourceRevision: base },
                    body: value(C.makeText('x')),
                },
            ],
        },
        queuedBy: facilitator,
        queuedAt: at,
        baseRevision: base,
        startedAt: at,
    };
    const report = (newDtErrors: number): C.RunReport => ({
        exitCode: 0,
        formatted: true,
        checked: true,
        newDtErrors: tally(newDtErrors),
        unparsedDtes: tally(0),
    });

    test('finish completes a run that meets the success rule and fails one that does not, with its report', () => {
        const done = value(agentRunCommands.finish(running, report(0), result, true, later));
        expect(done.Completed?.aggregate).toMatchObject({ state: 'Completed', resultRevision: result, changed: true, baseRevision: base });
        expect(done.Completed?.events.RunCompleted).toEqual({
            type: 'RunCompleted',
            runId: running.id,
            resultRevision: result,
            changed: true,
            finishedAt: later,
        });
        const failed = value(agentRunCommands.finish(running, report(2), base, false, later));
        expect(failed.Failed?.aggregate).toMatchObject({ state: 'Failed', reason: 'RuleNotMet', report: report(2), resultRevision: base });
        expect(agentRunCommands.finish(running, report(0), base, true, later)).toEqual({ ok: false, error: { type: 'ChangedMismatch' } });
        expect(agentRunCommands.finish(running, report(0), result, false, later)).toEqual({ ok: false, error: { type: 'ChangedMismatch' } });
    });

    test('fail needs a reason other than the rule; cancel keeps the base revision of a running run', () => {
        expect(agentRunCommands.fail(running, 'RuleNotMet', later)).toEqual({ ok: false, error: { type: 'ReportRequired' } });
        const failed = value(agentRunCommands.fail(running, 'LeaseExpired', later)).Failed.aggregate;
        expect(failed).toMatchObject({ state: 'Failed', reason: 'LeaseExpired', finishedAt: later });
        expect('report' in failed).toBe(false);
        expect(value(agentRunCommands.cancel(running, facilitator, later)).Cancelled.aggregate).toMatchObject({ baseRevision: base, cancelledBy: facilitator });
        const { baseRevision: _b, startedAt: _s, ...rest } = running;
        const queued: C.QueuedAgentRun = { ...rest, state: 'Queued' };
        expect('baseRevision' in value(agentRunCommands.cancel(queued, facilitator, later)).Cancelled.aggregate).toBe(false);
    });

    test('take and restore require the content hash of the files', () => {
        const files = [snapshotFile(path('a.dt'), bytes('context A {}'))];
        const validation = summarize([], false);
        const id = C.makeRevisionId('00000000-0000-4000-8000-000000000006');
        expect(revisionCommands.take(id, sessionId, { kind: 'Manual', takenBy: facilitator }, snapshotHash([]), files, validation, at)).toEqual({
            ok: false,
            error: { type: 'ContentHashMismatch' },
        });
        expect(
            revisionCommands.take(id, sessionId, { kind: 'Restored', restoredFrom: base, preRestore: result }, snapshotHash(files), files, validation, at),
        ).toEqual({ ok: false, error: { type: 'RestoreNeedsCheck' } });
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stands in for MakeRestorableRevision's check
        const restorable = base as C.RestorableRevision;
        const restored = value(revisionCommands.restore(id, sessionId, restorable, result, snapshotHash(files), files, validation, at)).Recorded;
        expect(restored.aggregate.origin).toEqual({ kind: 'Restored', restoredFrom: base, preRestore: result });
        expect(restored.events.RevisionRestored).toMatchObject({ restoredFrom: base, preRestore: result });
    });
});

describe('comparing revisions', () => {
    const lines = (n: number, f: (i: number) => string): string => `${Array.from({ length: n }, (_, i) => f(i)).join('\n')}\n`;

    test('a unified line diff with three lines of context; hunks apart stay apart, close ones merge', () => {
        const a = lines(20, (i) => `line ${i}`);
        const b = a.replace('line 3\n', 'line 3x\n').replace('line 15\n', '').replace('line 18\n', 'line 18\nnew\n');
        expect(lineDiff(a, b)).toEqual({
            kind: 'diff',
            unified: [
                '@@ -1,7 +1,7 @@',
                ' line 0',
                ' line 1',
                ' line 2',
                '-line 3',
                '+line 3x',
                ' line 4',
                ' line 5',
                ' line 6',
                '@@ -13,8 +13,8 @@',
                ' line 12',
                ' line 13',
                ' line 14',
                '-line 15',
                ' line 16',
                ' line 17',
                ' line 18',
                '+new',
                ' line 19',
            ].join('\n'),
            added: 2,
            removed: 2,
            truncated: false,
        });
        expect(lineDiff(a, a)).toEqual({ kind: 'diff', unified: '', added: 0, removed: 0, truncated: false });
    });

    test('an added or removed file, and a line end missing at the end', () => {
        expect(lineDiff('', 'x\ny\n')).toMatchObject({ unified: '@@ -0,0 +1,2 @@\n+x\n+y', added: 2, removed: 0 });
        expect(lineDiff('x\n', '')).toMatchObject({ unified: '@@ -1,1 +0,0 @@\n-x', added: 0, removed: 1 });
        expect(lineDiff('a\nb', 'a\nb\n')).toMatchObject({ unified: '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b', added: 1, removed: 1 });
    });

    test('bounded: too many lines or edits are not diffed; a long diff is cut', () => {
        expect(
            lineDiff(
                lines(MAX_DIFF_LINES + 1, (i) => `${i}`),
                '',
            ),
        ).toEqual({ kind: 'tooLarge' });
        const n = MAX_EDITS / 2 + 1;
        expect(
            lineDiff(
                lines(n, (i) => `a${i}`),
                lines(n, (i) => `b${i}`),
            ),
        ).toEqual({ kind: 'tooLarge' });
        const long = lineDiff(
            '',
            lines(MAX_OUTPUT_LINES + 10, (i) => `${i}`),
        );
        expect(long.kind === 'diff' && [long.truncated, long.unified.split('\n').length, long.added]).toEqual([true, MAX_OUTPUT_LINES, MAX_OUTPUT_LINES + 10]);
    });

    test('the files of two revisions by path, with their status and DSL', () => {
        const f = (path: string, hash: string): Pick<C.SnapshotFile, 'path' | 'language' | 'hash'> => ({
            path: value(C.makeWorkspacePath(path)),
            language: languageOf(path),
            hash: value(C.makeContentHash(hash.repeat(64))),
        });
        expect(
            compareFiles([f('a.dt', 'a'), f('b.dtes', 'b'), f('c.dt', 'c')], [f('a.dt', 'a'), f('b.dtes', 'd'), f('d.dtes', 'e')]).map((x): string[] => [
                x.path,
                x.language,
                x.status,
            ]),
        ).toEqual([
            ['a.dt', 'Dt', 'unchanged'],
            ['b.dtes', 'Dtes', 'changed'],
            ['c.dt', 'Dt', 'removed'],
            ['d.dtes', 'Dtes', 'added'],
        ]);
    });
});
