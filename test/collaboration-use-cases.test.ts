// The use cases of a session (ADR 0026) over the real adapters: node:sqlite, the blobs, the workspace snapshot of
// @domaintrail/workspace and the analyzer, on a temporary workspace with .dt and .dtes sources; time and IDs are fakes.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Collaboration as C } from '@domaintrail/collaboration/generated/index';
import type { CollaborationDeps } from '@domaintrail/collaboration/application/ports';
import { createCollaboration, type CollaborationUseCases } from '@domaintrail/collaboration/application/use-cases';
import { encodeOccurrencePath } from '@domaintrail/collaboration/domain/targets';
import { summarize } from '@domaintrail/collaboration/domain/validation';
import { openSessionBlobs } from '@domaintrail/collaboration/infrastructure/blobs';
import { createUnitOfWork, openDatabase, openSessionDatabase } from '@domaintrail/collaboration/infrastructure/sqlite';
import { createModelValidator } from '@domaintrail/collaboration/infrastructure/validator';
import { createWorkspaceSnapshot } from '@domaintrail/workspace/infrastructure/snapshot';

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
    return r.value;
};
const error = <E>(r: { ok: true } | { ok: false; error: E }): E => {
    if (r.ok) throw new Error('expected an error');
    return r.error;
};

const SALES = `context Sales {
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
`;
const RETURNS = `storming Returns {
  event Requested
  event Received
  timeline Normal {
    Requested
    Received
  }
}
`;

interface Session {
    readonly root: string;
    readonly use: CollaborationUseCases;
    readonly clock: { t: number };
    readonly deps: CollaborationDeps;
    write(file: string, text: string): Promise<void>;
    read(file: string): Promise<string>;
}

async function workspace(files: Record<string, string> = { 'sales/sales.dt': SALES, 'stormings/returns.dtes': RETURNS }): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-collab-'));
    dirs.push(root);
    for (const [file, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), text);
    }
    return root;
}

async function session(root?: string, database: 'memory' | 'file' = 'memory', clock = { t: Date.parse('2026-10-31T09:00:00Z') }): Promise<Session> {
    const dir = root ?? (await workspace());
    let n = 0;
    const deps: CollaborationDeps = {
        uow: createUnitOfWork(database === 'memory' ? openDatabase(':memory:') : await openSessionDatabase(dir)),
        workspace: createWorkspaceSnapshot(dir),
        blobs: await openSessionBlobs(dir),
        validator: createModelValidator(),
        clock: { now: () => new Date(clock.t) },
        ids: { newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` },
    };
    return {
        root: dir,
        use: createCollaboration(deps),
        clock,
        deps,
        write: (file, text) => writeFile(path.join(dir, file), text),
        read: (file) => readFile(path.join(dir, file), 'utf8'),
    };
}

const facilitator = value(C.makeParticipantId('facilitator'));
const guest = value(C.makeParticipantId('guest'));
const name = value(C.makeDisplayName('Ada'));
const text = (t: string): C.Text => value(C.makeText(t));
const facts = { exitCode: 0, formatted: true, checked: true };

async function started(s: Session): Promise<{ id: C.SessionId; start: C.RecordedRevision }> {
    const { session: open, revision } = value(await s.use.startSession({ facilitator, name }));
    value(await s.use.joinSession({ session: open.id, participant: guest, name }));
    return { id: open.id, start: revision };
}

async function queuedRun(s: Session, id: C.SessionId, start: C.RecordedRevision): Promise<C.QueuedAgentRun> {
    const target: C.TargetSnapshot = { target: { kind: 'DtElement', element: value(C.makeElementName('Sales.Order')) }, sourceRevision: start.id };
    const request = value(await s.use.sendRequest({ session: id, author: guest, target, body: text('Add a cancel command.') }));
    return value(await s.use.queueRun({ session: id, requests: [request.id], queuedBy: facilitator }));
}

describe('sessions and requests', () => {
    test('a session starts with a revision of every source, .dt and .dtes, and its events in the outbox', async () => {
        const s = await session();
        const { id, start } = await started(s);
        expect(start.origin).toEqual({ kind: 'SessionStart', session: id });
        expect(start.files.map((f): string[] => [f.path, f.language])).toEqual([
            ['sales/sales.dt', 'Dt'],
            ['stormings/returns.dtes', 'Dtes'],
        ]);
        expect(start.validation).toEqual(summarize([], false));
        const events = await s.deps.uow.transaction((st) => st.outbox.readAfter(0, 100, id));
        expect(events.map((e) => e.event.type)).toEqual(['SessionStarted', 'RevisionRecorded', 'ParticipantJoined']);
        expect(value(await s.use.joinSession({ session: id, participant: guest, name })).joined).toBe(false);
    });

    test('requests need an open session and a participant; a dismissed request cannot be bundled', async () => {
        const s = await session();
        const { id, start } = await started(s);
        const target: C.TargetSnapshot = { target: { kind: 'Workspace' }, sourceRevision: start.id };
        const stranger = value(C.makeParticipantId('stranger'));
        expect(error(await s.use.sendRequest({ session: id, author: stranger, target, body: text('x') }))).toEqual({
            type: 'NotAParticipant',
            participant: stranger,
        });
        const ranged: C.TargetSnapshot = {
            ...target,
            range: {
                path: value(C.makeWorkspacePath('sales/sales.dt')),
                startLine: value(C.makeLineNumber(1)),
                startColumn: value(C.makeColumnNumber(1)),
                endLine: value(C.makeLineNumber(1)),
                endColumn: value(C.makeColumnNumber(2)),
            },
        };
        expect(error(await s.use.sendRequest({ session: id, author: guest, target: ranged, body: text('x') }))).toEqual({
            type: 'InvalidTarget',
            violated: ['workspaceHasNoRange'],
        });
        const sent = value(await s.use.sendRequest({ session: id, author: guest, target, body: text('x') }));
        value(await s.use.dismissRequest({ request: sent.id, by: facilitator }));
        expect(error(await s.use.dismissRequest({ request: sent.id, by: facilitator }))).toEqual({
            type: 'NotAllowed',
            command: 'dismiss',
            state: 'Dismissed',
        });
        expect(error(await s.use.queueRun({ session: id, requests: [sent.id], queuedBy: facilitator }))).toEqual({
            type: 'RequestAlreadyDismissed',
            request: sent.id,
        });
        expect(error(await s.use.queueRun({ session: id, requests: [], queuedBy: facilitator }))).toEqual({ type: 'NoRequests' });
        value(await s.use.closeSession({ session: id }));
        expect(error(await s.use.sendRequest({ session: id, author: guest, target, body: text('x') }))).toEqual({ type: 'SessionAlreadyClosed' });
    });

    test('a run freezes its requests at queueing, and a request bundled twice is refused', async () => {
        const s = await session();
        const { id, start } = await started(s);
        const run = await queuedRun(s, id, start);
        expect(run.input.requests).toHaveLength(1);
        expect(run.input.requests[0]).toMatchObject({ author: guest, body: 'Add a cancel command.' });
        const request = run.input.requests[0].request;
        value(await s.use.dismissRequest({ request, by: facilitator }));
        const state = value(await s.use.sessionState({ session: id }));
        expect(state.runs[0]).toEqual(run);
        expect(error(await s.use.queueRun({ session: id, requests: [request], queuedBy: facilitator }))).toMatchObject({ type: 'RequestAlreadyDismissed' });
        const again = value(await s.use.sendRequest({ session: id, author: guest, target: run.input.requests[0].target, body: text('y') }));
        expect(error(await s.use.queueRun({ session: id, requests: [again.id, again.id], queuedBy: facilitator }))).toEqual({ type: 'DuplicateRequest' });
    });
});

describe('agent runs', () => {
    test('a run is claimed, started on a base revision and finished: completed when the rule holds', async () => {
        const s = await session();
        const { id, start } = await started(s);
        const run = await queuedRun(s, id, start);
        const { lease } = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000 }));
        expect(error(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000 }))).toEqual({ type: 'RunInProgress', run: run.id });
        const { base } = value(await s.use.startRun({ run: run.id, token: lease.token }));
        expect(base.origin).toEqual({ kind: 'RunBase', run: run.id });
        expect(base.contentHash).toBe(start.contentHash);

        await s.write('sales/sales.dt', SALES.replace('    command confirm()', '    command cancel()\n      Draft -> Draft\n\n    command confirm()'));
        const finished = value(await s.use.finishRun({ run: run.id, token: lease.token, facts }));
        expect(finished.run).toMatchObject({ state: 'Completed', changed: true, baseRevision: base.id });
        expect(finished.run.resultRevision).not.toBe(base.id);
        expect(finished.diff?.newDtErrors).toEqual([]);
        const state = value(await s.use.sessionState({ session: id }));
        expect(state.revisions.map((r) => r.origin.kind)).toEqual(['SessionStart', 'RunBase', 'RunResult']);
        // the same call again with the same lease: the same run, nothing recorded twice
        expect(value(await s.use.finishRun({ run: run.id, token: lease.token, facts }))).toEqual({ run: finished.run, replayed: true, diff: undefined });
        expect(value(await s.use.sessionState({ session: id })).revisions).toHaveLength(3);
        expect(error(await s.use.finishRun({ run: run.id, token: 'another', facts }))).toEqual({ type: 'LeaseLost', run: run.id });
        const types = (await s.deps.uow.transaction((st) => st.outbox.readAfter(0, 100, id))).map((e) => e.event.type);
        expect(types.slice(-4)).toEqual(['RevisionRecorded', 'RunStarted', 'RevisionRecorded', 'RunCompleted']);
    });

    test('a run that adds a .dt error or breaks a .dtes fails by the rule, with the diff; one that changes nothing keeps its base', async () => {
        const s = await session();
        const { id, start } = await started(s);
        const first = await queuedRun(s, id, start);
        const second = await queuedRun(s, id, start);

        const a = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000 }));
        expect(a.run.id).toBe(first.id);
        value(await s.use.startRun({ run: first.id, token: a.lease.token }));
        await s.write('sales/sales.dt', SALES.replace('id: OrderId\n\n    state', 'id: OrderId\n    total: Money\n\n    state'));
        await s.write('stormings/returns.dtes', 'storming Returns {');
        const failed = value(await s.use.finishRun({ run: first.id, token: a.lease.token, facts }));
        expect(failed.run).toMatchObject({ state: 'Failed', reason: 'RuleNotMet', report: { newDtErrors: 1, unparsedDtes: 1 } });
        expect(failed.diff?.newDtErrors.map((d) => d.file)).toEqual(['sales/sales.dt']);
        expect(failed.diff?.unparsedDtes).toEqual(['stormings/returns.dtes']);

        const b = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000 }));
        expect(b.run.id).toBe(second.id);
        const { base } = value(await s.use.startRun({ run: second.id, token: b.lease.token }));
        const unchanged = value(await s.use.finishRun({ run: second.id, token: b.lease.token, facts: { ...facts, exitCode: 2 } }));
        expect(unchanged.run).toMatchObject({ state: 'Failed', reason: 'RuleNotMet', resultRevision: base.id });
        expect(error(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000 }))).toEqual({ type: 'NothingQueued' });
    });

    test('clarification and abnormal failures end a run under its lease; a cancelled run loses it', async () => {
        const s = await session();
        const { id, start } = await started(s);
        const asked = await queuedRun(s, id, start);
        const failing = await queuedRun(s, id, start);
        const cancelled = await queuedRun(s, id, start);

        const a = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000 }));
        const { base } = value(await s.use.startRun({ run: asked.id, token: a.lease.token }));
        const question = value(await s.use.askClarification({ run: asked.id, token: a.lease.token, question: text('Which state?') }));
        expect(question.run).toMatchObject({ state: 'NeedsClarification', resultRevision: base.id });
        expect(value(await s.use.askClarification({ run: asked.id, token: a.lease.token, question: text('Which state?') })).replayed).toBe(true);

        const b = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000 }));
        value(await s.use.startRun({ run: failing.id, token: b.lease.token }));
        expect(value(await s.use.failRun({ run: failing.id, token: b.lease.token, reason: 'AgentError' })).run).toMatchObject({
            state: 'Failed',
            reason: 'AgentError',
        });
        expect(value(await s.use.failRun({ run: failing.id, token: b.lease.token, reason: 'AgentError' })).replayed).toBe(true);

        const c = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000 }));
        value(await s.use.startRun({ run: cancelled.id, token: c.lease.token }));
        expect(value(await s.use.cancelRun({ run: cancelled.id, by: facilitator }))).toMatchObject({ state: 'Cancelled', baseRevision: expect.any(String) });
        expect(error(await s.use.heartbeat({ run: cancelled.id, token: c.lease.token, leaseMs: 1000 }))).toEqual({ type: 'LeaseLost', run: cancelled.id });
        expect(error(await s.use.finishRun({ run: cancelled.id, token: c.lease.token, facts }))).toEqual({ type: 'LeaseLost', run: cancelled.id });
    });

    test('a claim released before the start goes back to the queue', async () => {
        const s = await session();
        const { id, start } = await started(s);
        const run = await queuedRun(s, id, start);
        const a = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000 }));
        expect(value(await s.use.releaseRun({ run: run.id, token: a.lease.token })).id).toBe(run.id);
        const b = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000 }));
        expect(b.lease.token).not.toBe(a.lease.token);
        expect(error(await s.use.startRun({ run: run.id, token: a.lease.token }))).toEqual({ type: 'LeaseLost', run: run.id });
    });

    test('recovery: an expired lease fails a running run (LeaseExpired) and frees a claimed one, across a restart', async () => {
        const root = await workspace();
        const clock = { t: Date.parse('2026-10-31T09:00:00Z') };
        const s = await session(root, 'file', clock);
        const { id, start } = await started(s);
        const running = await queuedRun(s, id, start);
        const claimed = await queuedRun(s, id, start);
        const a = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 10_000 }));
        value(await s.use.startRun({ run: running.id, token: a.lease.token }));
        clock.t += 5_000;
        value(await s.use.heartbeat({ run: running.id, token: a.lease.token, leaseMs: 10_000 }));

        // the server restarts later: a new connection to the same file
        clock.t += 60_000;
        const after = await session(root, 'file', clock);
        expect(await after.use.expireLeases()).toEqual({ failed: [expect.objectContaining({ id: running.id, reason: 'LeaseExpired' })], released: [] });
        expect(error(await after.use.finishRun({ run: running.id, token: a.lease.token, facts }))).toEqual({ type: 'LeaseLost', run: running.id });

        const b = value(await after.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 1_000 }));
        expect(b.run.id).toBe(claimed.id);
        clock.t += 2_000;
        expect(await after.use.expireLeases()).toEqual({ failed: [], released: [claimed.id] });
        expect(value(await after.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 1_000 })).run.id).toBe(claimed.id);
    });
});

describe('revisions', () => {
    test('restore writes a past revision back after a pre-restore snapshot, and records it', async () => {
        const s = await session();
        const { id, start } = await started(s);
        const confirmed = value(await s.use.confirmRevision({ revision: start.id, by: facilitator }));
        expect(confirmed.state).toBe('Confirmed');
        expect(error(await s.use.confirmRevision({ revision: start.id, by: facilitator }))).toEqual({
            type: 'NotAllowed',
            command: 'confirm',
            state: 'Confirmed',
        });

        await s.write('sales/sales.dt', SALES.replace('state Confirmed', 'state Confirmed\n    state Cancelled'));
        await mkdir(path.join(s.root, 'extra'), { recursive: true });
        await s.write('extra/new.dt', 'context Extra {}\n');
        const manual = value(await s.use.takeRevision({ session: id, by: facilitator }));
        expect(manual.origin).toEqual({ kind: 'Manual', takenBy: facilitator });

        const { restored, preRestore } = value(await s.use.restoreRevision({ session: id, revision: start.id }));
        expect(await s.read('sales/sales.dt')).toBe(SALES);
        expect(await readFile(path.join(s.root, 'extra/new.dt')).catch(() => 'gone')).toBe('gone');
        expect(preRestore).toMatchObject({ origin: { kind: 'PreRestore', restoring: start.id }, contentHash: manual.contentHash });
        expect(restored).toMatchObject({ origin: { kind: 'Restored', restoredFrom: start.id, preRestore: preRestore.id }, contentHash: start.contentHash });
        const types = (await s.deps.uow.transaction((st) => st.outbox.readAfter(0, 100, id))).map((e) => e.event.type);
        expect(types.at(-1)).toBe('RevisionRestored');
    });

    test('restore refuses external changes since the last revision, symbolic links, and a running run', async () => {
        const s = await session();
        const { id, start } = await started(s);
        await s.write('sales/sales.dt', `${SALES}\n`);
        expect(error(await s.use.restoreRevision({ session: id, revision: start.id }))).toEqual({
            type: 'ExternalChangesSinceSnapshot',
            paths: [value(C.makeWorkspacePath('sales/sales.dt'))],
        });
        value(await s.use.takeRevision({ session: id, by: facilitator }));

        await symlink(path.join(s.root, 'sales'), path.join(s.root, 'linked'));
        expect(error(await s.use.restoreRevision({ session: id, revision: start.id }))).toEqual({
            type: 'SymlinkInWorkspace',
            path: value(C.makeWorkspacePath('linked')),
        });
        await rm(path.join(s.root, 'linked'));

        const run = await queuedRun(s, id, start);
        const { lease } = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000 }));
        expect(error(await s.use.restoreRevision({ session: id, revision: start.id }))).toEqual({ type: 'RunInProgress', run: run.id });
        value(await s.use.releaseRun({ run: run.id, token: lease.token }));
        expect(error(await s.use.restoreRevision({ session: id, revision: C.makeRevisionId('00000000-0000-4000-8000-999999999999') }))).toMatchObject({
            type: 'RevisionNotFound',
        });
        value(await s.use.restoreRevision({ session: id, revision: start.id }));
        expect(await s.read('sales/sales.dt')).toBe(SALES);
    });

    test("targets of requests are current, stale or unknown in the workspace now; they're never re-bound", async () => {
        const s = await session();
        const { id, start } = await started(s);
        const send = async (target: C.ModelTarget): Promise<C.RequestId> =>
            value(await s.use.sendRequest({ session: id, author: guest, target: { target, sourceRevision: start.id }, body: text('x') })).id;
        const order = await send({ kind: 'DtElement', element: value(C.makeElementName('Sales.Order#Confirmed')) });
        const received = await send({
            kind: 'DtesOccurrence',
            storming: value(C.makeStormingName('Returns')),
            timeline: value(C.makeTimelineName('Normal')),
            eventName: value(C.makeStormingEventName('Received')),
            occurrence: value(C.makeOccurrencePath(encodeOccurrencePath([1]))),
        });
        expect([...value(await s.use.targetStatuses({ session: id })).statuses.values()]).toEqual(['current', 'current']);
        await s.write('sales/sales.dt', SALES.replace('    state Confirmed\n', '').replace('Draft -> Confirmed', 'Draft -> Draft'));
        await s.write('stormings/returns.dtes', RETURNS.replace('    Requested\n', '    Requested\n    Requested\n'));
        const statuses = value(await s.use.targetStatuses({ session: id })).statuses;
        expect([statuses.get(order), statuses.get(received)]).toEqual(['stale', 'stale']);
    });
});
