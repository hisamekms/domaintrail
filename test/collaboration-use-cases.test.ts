// The use cases of a session (ADR 0026) over the real adapters: node:sqlite, the blobs, the workspace snapshot of
// @domaintrail/workspace and the analyzer, on a temporary workspace with .dt and .dtes sources; time and IDs are fakes.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
    type Actor,
    actorOf,
    Collaboration as C,
    type CollaborationDeps,
    type CollaborationUseCases,
    createCollaboration,
    createUnitOfWork,
    FACILITATOR_PARTICIPANT,
    knownAgentRunId,
    knownRequestId,
    knownRevisionId,
    openSessionBlobs,
    openSessionDatabase,
    type ReplyData,
    toAgentReply,
} from '@domaintrail/collaboration';
import { createModelValidator, createSourceFormatter, createStickyEditor } from '@domaintrail/dt';
import { createWorkspaceSnapshot } from '@domaintrail/workspace';
import { sourceSelection } from '@domaintrail/analysis';

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
        // 'memory': a database of its own, apart from the workspace; 'file': the workspace's session database
        uow: createUnitOfWork(await openSessionDatabase(database === 'memory' ? await workspace({}) : dir)),
        workspace: createWorkspaceSnapshot(dir, sourceSelection()),
        blobs: await openSessionBlobs(dir),
        validator: createModelValidator(),
        formatter: createSourceFormatter(),
        stickies: createStickyEditor(),
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
const facts = { exitCode: 0, formatted: 'Ran', checked: 'Ran' } as const;

async function started(s: Session): Promise<{ id: C.SessionId; start: C.RecordedRevision }> {
    const { session: open, revision } = value(await s.use.startSession({ facilitator, name }));
    value(await s.use.joinSession({ session: open.id, participant: guest, name }));
    return { id: open.id, start: revision };
}

/** A request dismissed in an older session: no command dismisses any more, but such rows still load (ADR 0027, T12). */
async function dismissedBefore(s: Session, request: C.SentRequest): Promise<void> {
    await s.deps.uow.transaction((stores) =>
        stores.requests.save({ ...request, state: 'Dismissed', dismissedBy: facilitator, dismissedAt: new Date(s.clock.t) }),
    );
}

async function queuedRun(s: Session, id: C.SessionId, start: C.RecordedRevision): Promise<C.QueuedAgentRun> {
    const target: C.TargetSnapshot = { target: { kind: 'DtElement', element: value(C.makeElementName('Sales.Order')) }, sourceRevision: start.id };
    const request = value(await s.use.sendRequest({ session: id, actor: actor(guest), targets: [target], body: text('Add a cancel command.') }));
    return value(await s.use.queueRun({ session: id, requests: [request.id], actor: actor(facilitator) }));
}

/** The actor of a participant of these tests: `facilitator` holds the facilitator's role. */
const actor = (participant: C.ParticipantId): Actor => ({
    kind: 'participant',
    participant,
    role: participant === 'facilitator' ? 'Facilitator' : 'Participant',
});

describe('sessions and requests', () => {
    test('a session starts with a revision of every source, .dt and .dtes, and its events in the outbox', async () => {
        const s = await session();
        const { id, start } = await started(s);
        expect(start.origin).toEqual({ kind: 'SessionStart', session: id });
        expect(start.files.map((f): string[] => [f.path, f.language])).toEqual([
            ['sales/sales.dt', 'Dt'],
            ['stormings/returns.dtes', 'Dtes'],
        ]);
        expect(start.validation).toEqual({ dtErrors: 0, dtesErrors: 0, dtesWarnings: 0, linkWarnings: 0, stale: false } as unknown as typeof start.validation);
        const events = await s.deps.uow.transaction((st) => st.outbox.readAfter(0, 100, id));
        expect(events.map((e) => e.event.type)).toEqual(['SessionStarted', 'RevisionRecorded', 'ParticipantJoined']);
        expect(value(await s.use.joinSession({ session: id, participant: guest, name })).joined).toBe(false);
    });

    test('requests need an open session and a participant; a dismissed request of an older session cannot be bundled', async () => {
        const s = await session();
        const { id, start } = await started(s);
        const element = (name: string): C.TargetSnapshot => ({
            target: { kind: 'DtElement', element: value(C.makeElementName(name)) },
            sourceRevision: start.id,
        });
        const stranger = value(C.makeParticipantId('stranger'));
        expect(error(await s.use.sendRequest({ session: id, actor: actor(stranger), targets: [], body: text('x') }))).toEqual({
            type: 'NotAParticipant',
            participant: stranger,
        });
        const backwards: C.TargetSnapshot = {
            ...element('Sales.Order'),
            range: {
                path: value(C.makeWorkspacePath('sales/sales.dt')),
                startLine: value(C.makeLineNumber(2)),
                startColumn: value(C.makeColumnNumber(1)),
                endLine: value(C.makeLineNumber(1)),
                endColumn: value(C.makeColumnNumber(2)),
            },
        };
        expect(error(await s.use.sendRequest({ session: id, actor: actor(guest), targets: [element('Sales.Customer'), backwards], body: text('x') }))).toEqual({
            type: 'InvalidTarget',
            violated: ['ordered'],
        });
        // several targets: at most 20, each once, and never the whole workspace (which is no target at all)
        const many = Array.from({ length: 21 }, (_, i) => element(`Sales.E${i}`));
        expect(error(await s.use.sendRequest({ session: id, actor: actor(guest), targets: many, body: text('x') }))).toEqual({ type: 'TooManyTargets' });
        expect(
            error(await s.use.sendRequest({ session: id, actor: actor(guest), targets: [element('Sales.Order'), element('Sales.Order')], body: text('x') })),
        ).toEqual({ type: 'DuplicateTarget' });
        expect(
            error(
                await s.use.sendRequest({
                    session: id,
                    actor: actor(guest),
                    targets: [{ target: { kind: 'Workspace' }, sourceRevision: start.id }],
                    body: text('x'),
                }),
            ),
        ).toEqual({ type: 'WorkspaceTarget' });
        const two = value(await s.use.sendRequest({ session: id, actor: actor(guest), targets: many.slice(0, 20), body: text('x') }));
        expect(two.targets).toHaveLength(20);
        const target: readonly C.TargetSnapshot[] = [];
        const sent = value(await s.use.sendRequest({ session: id, actor: actor(guest), targets: target, body: text('x') }));
        await dismissedBefore(s, sent);
        expect(error(await s.use.queueRun({ session: id, requests: [sent.id], actor: actor(facilitator) }))).toEqual({
            type: 'RequestAlreadyDismissed',
            request: sent.id,
        });
        expect(error(await s.use.queueRun({ session: id, requests: [], actor: actor(facilitator) }))).toEqual({ type: 'NoRequests' });
        value(await s.use.closeSession({ session: id, actor: actor(facilitator) }));
        expect(error(await s.use.sendRequest({ session: id, actor: actor(guest), targets: target, body: text('x') }))).toEqual({
            type: 'SessionAlreadyClosed',
        });
    });

    test('a run freezes its requests at queueing, and a request bundled twice is refused', async () => {
        const s = await session();
        const { id, start } = await started(s);
        const run = await queuedRun(s, id, start);
        expect(run.input.requests).toHaveLength(1);
        expect(run.input.requests[0]).toMatchObject({ author: guest, body: 'Add a cancel command.' });
        const request = run.input.requests[0].request;
        const stored = await s.deps.uow.transaction((stores) => stores.requests.load(request));
        if (stored?.state !== 'Sent') throw new Error('no sent request');
        await dismissedBefore(s, stored);
        const state = value(await s.use.sessionState({ session: id }));
        expect(state.runs[0]).toEqual(run);
        expect(error(await s.use.queueRun({ session: id, requests: [request], actor: actor(facilitator) }))).toMatchObject({ type: 'RequestAlreadyDismissed' });
        const again = value(await s.use.sendRequest({ session: id, actor: actor(guest), targets: run.input.requests[0].targets, body: text('y') }));
        expect(error(await s.use.queueRun({ session: id, requests: [again.id, again.id], actor: actor(facilitator) }))).toEqual({ type: 'DuplicateRequest' });
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
        expect(value(await s.use.cancelRun({ run: cancelled.id, actor: actor(facilitator) }))).toMatchObject({
            state: 'Cancelled',
            baseRevision: expect.any(String),
        });
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

    test("a run's activity is taken from its lease's holder while it runs, without extending the lease", async () => {
        const s = await session();
        const { id, start } = await started(s);
        const run = await queuedRun(s, id, start);
        const a = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000 }));
        expect(error(await s.use.heldRunningRun({ run: run.id, token: a.lease.token }))).toEqual({ type: 'NotAllowed', command: 'report', state: 'Queued' });
        value(await s.use.startRun({ run: run.id, token: a.lease.token }));
        expect(value(await s.use.heldRunningRun({ run: run.id, token: a.lease.token }))).toMatchObject({ id: run.id, state: 'Running' });
        expect(error(await s.use.heldRunningRun({ run: run.id, token: 'another-token' }))).toEqual({ type: 'LeaseLost', run: run.id });
        value(await s.use.failRun({ run: run.id, token: a.lease.token, reason: 'AgentError' }));
        expect(error(await s.use.heldRunningRun({ run: run.id, token: a.lease.token }))).toEqual({ type: 'LeaseLost', run: run.id });
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

describe('agent replies', () => {
    /** A reply about the run's requests, as the agent API takes it. */
    const reply = (over: Partial<ReplyData<C.RequestId>> & Pick<ReplyData<C.RequestId>, 'requests'>): C.AgentReply =>
        toAgentReply({ outcome: 'done', summary: 'Added cancel.', questions: [], assumptions: [], ...over });

    /** A started run of a fresh session. */
    async function runningRun(): Promise<{ s: Session; id: C.SessionId; run: C.QueuedAgentRun; token: string; request: C.RequestId }> {
        const s = await session();
        const { id, start } = await started(s);
        const run = await queuedRun(s, id, start);
        const { lease } = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000 }));
        value(await s.use.startRun({ run: run.id, token: lease.token }));
        return { s, id, run, token: lease.token, request: run.input.requests[0].request };
    }

    test('a completed run keeps the reply; a reply about another request is refused before anything is recorded', async () => {
        const { s, id, run, token, request } = await runningRun();
        const stranger = knownRequestId('00000000-0000-4000-8000-0000000000ff');
        const before = value(await s.use.sessionState({ session: id })).revisions.length;
        await s.write('sales/sales.dt', SALES.replace('    command confirm()', '    command cancel()\n      Draft -> Draft\n\n    command confirm()'));
        expect(error(await s.use.finishRun({ run: run.id, token, facts, reply: reply({ requests: [{ request: stranger, status: 'done' }] }) }))).toEqual({
            type: 'InvalidReply',
        });
        expect(value(await s.use.sessionState({ session: id })).revisions).toHaveLength(before);
        const kept = reply({
            requests: [{ request, status: 'partial', note: 'Only the command.' }],
            assumptions: [{ text: 'Only drafts.', requests: [request], alternatives: [{ id: 'all', label: 'Any state' }] }],
        });
        const finished = value(await s.use.finishRun({ run: run.id, token, facts, reply: kept }));
        expect(finished.run).toMatchObject({ state: 'Completed', changed: true, reply: kept });
        expect(value(await s.use.sessionState({ session: id })).runs[0]).toMatchObject({ reply: kept });
    });

    test('a failed run keeps no reply: the facts decide', async () => {
        const { s, run, token, request } = await runningRun();
        const failed = value(
            await s.use.finishRun({ run: run.id, token, facts: { ...facts, exitCode: 1 }, reply: reply({ requests: [{ request, status: 'done' }] }) }),
        );
        expect(failed.run.state).toBe('Failed');
        expect('reply' in failed.run).toBe(false);
    });

    test('a clarification keeps its structured questions; a done reply with questions is refused', async () => {
        const { s, run, token, request } = await runningRun();
        const asking = reply({
            outcome: 'clarification',
            requests: [{ request, status: 'question' }],
            questions: [{ id: 'q1', text: 'Which state?', requests: [request], options: [{ id: 'draft', label: 'Draft' }], multiple: false }],
        });
        expect(error(await s.use.finishRun({ run: run.id, token, facts, reply: asking }))).toEqual({ type: 'InvalidReply' });
        expect(error(await s.use.askClarification({ run: run.id, token, question: text('Which?'), reply: reply({ requests: [] }) }))).toEqual({
            type: 'InvalidReply',
        });
        const asked = value(await s.use.askClarification({ run: run.id, token, question: text('Which state?'), reply: asking }));
        expect(asked.run).toMatchObject({ state: 'NeedsClarification', question: 'Which state?', reply: asking });
    });

    test('a declined run ends without checks, keeps the reason, and is replayed like the other endings', async () => {
        const { s, id, run, token, request } = await runningRun();
        const declined = reply({
            outcome: 'declined',
            summary: 'This is not about the model.',
            requests: [{ request, status: 'skipped', note: 'Out of scope.' }],
        });
        const ended = value(await s.use.declineRun({ run: run.id, token, reply: declined }));
        expect(ended.run).toMatchObject({ state: 'Declined', reply: declined, resultRevision: ended.run.baseRevision });
        expect(value(await s.use.declineRun({ run: run.id, token, reply: declined })).replayed).toBe(true);
        expect(error(await s.use.finishRun({ run: run.id, token, facts }))).toEqual({ type: 'NotAllowed', command: 'finish', state: 'Declined' });
        expect(error(await s.use.askClarification({ run: run.id, token, question: text('x') }))).toEqual({
            type: 'NotAllowed',
            command: 'askClarification',
            state: 'Declined',
        });
        const types = (await s.deps.uow.transaction((st) => st.outbox.readAfter(0, 100, id))).map((e) => e.event.type);
        expect(types.at(-1)).toBe('RunDeclined');
    });

    test("the facilitator's answer is checked against the questions and frozen into the next run's input", async () => {
        const { s, id, run, token, request } = await runningRun();
        const asking = reply({
            outcome: 'clarification',
            requests: [{ request, status: 'question' }],
            questions: [
                {
                    id: 'q1',
                    text: 'Which state?',
                    requests: [request],
                    options: [
                        { id: 'draft', label: 'Draft', detail: 'before confirm' },
                        { id: 'open', label: 'Open' },
                    ],
                    multiple: false,
                },
                {
                    id: 'q2',
                    text: 'Which events?',
                    requests: [],
                    options: [
                        { id: 'a', label: 'A' },
                        { id: 'b', label: 'B' },
                    ],
                    multiple: true,
                },
            ],
        });
        value(await s.use.askClarification({ run: run.id, token, question: text('Which state?'), reply: asking }));
        const queue = (answers: { question: string; options: string[]; text?: string }[], answerTo = run.id) =>
            s.use.queueRun({ session: id, requests: [request], actor: actor(facilitator), answer: { answerTo, answer: { answers } } });

        expect(error(await queue([{ question: 'q9', options: ['draft'] }]))).toMatchObject({ type: 'InvalidAnswer', field: 'answer.answers[0].question' });
        expect(error(await queue([{ question: 'q1', options: ['draft', 'open'] }]))).toMatchObject({
            type: 'InvalidAnswer',
            field: 'answer.answers[0].options',
        });
        expect(error(await queue([{ question: 'q1', options: ['closed'] }]))).toMatchObject({ type: 'InvalidAnswer', field: 'answer.answers[0].options[0]' });
        const unknown = knownAgentRunId('00000000-0000-4000-8000-0000000000ee');
        expect(error(await queue([{ question: 'q1', options: ['draft'] }], unknown))).toEqual({ type: 'NotFound', aggregate: 'AgentRun', id: unknown });

        const next = value(
            await queue([
                { question: 'q1', options: ['draft'] },
                { question: 'q2', options: ['a', 'b'], text: 'and C' },
            ]),
        );
        expect(next.input.answer as unknown).toEqual({
            answerTo: run.id,
            answers: [
                { question: 'q1', text: 'Which state?', chosen: [{ id: 'draft', label: 'Draft', detail: 'before confirm' }] },
                {
                    question: 'q2',
                    text: 'Which events?',
                    chosen: [
                        { id: 'a', label: 'A' },
                        { id: 'b', label: 'B' },
                    ],
                    freeText: 'and C',
                },
            ],
        });
        // a run that is not waiting for an answer has nothing to answer
        expect(error(await queue([{ question: 'q1', options: ['draft'] }], next.id))).toEqual({ type: 'NothingToAnswer', run: next.id });
    });

    test("the facilitator's pick of an alternative is checked against the completed run and frozen into the next run's input", async () => {
        const { s, id, run, token, request } = await runningRun();
        const tally = (n: number): C.Tally => value(C.makeTally(n));
        const key = (k: string): C.ReplyKey => value(C.makeReplyKey(k));
        const pickOf = (of: C.AgentRunId, assumption = 1, alternative = 'any', requests: C.RequestId[] = [request]) =>
            s.use.queueRun({
                session: id,
                requests,
                actor: actor(facilitator),
                note: text('redo it'),
                pick: { pickOf: of, assumption: tally(assumption), alternative: key(alternative) },
            });
        // not completed yet: nothing to pick
        expect(error(await pickOf(run.id))).toEqual({ type: 'RunNotPickable', run: run.id });
        const assumptions = [
            { text: 'Only drafts.', requests: [request], alternatives: [] },
            {
                text: 'Cancel keeps the order.',
                requests: [request],
                alternatives: [
                    { id: 'delete', label: 'Delete it' },
                    { id: 'any', label: 'Any state' },
                ],
            },
        ];
        value(await s.use.finishRun({ run: run.id, token, facts, reply: reply({ requests: [{ request, status: 'done' }], assumptions }) }));

        const unknown = knownAgentRunId('00000000-0000-4000-8000-0000000000ee');
        expect(error(await pickOf(unknown))).toEqual({ type: 'RunNotFound', run: unknown });
        // an assumption or an alternative the reply does not have
        expect(error(await pickOf(run.id, 2))).toEqual({ type: 'AlternativeNotFound', run: run.id });
        expect(error(await pickOf(run.id, 0, 'any'))).toEqual({ type: 'AlternativeNotFound', run: run.id });
        expect(error(await pickOf(run.id, 1, 'other'))).toEqual({ type: 'AlternativeNotFound', run: run.id });
        // the requests queued again are the run's, no fewer and no more
        const other = value(await s.use.sendRequest({ session: id, actor: actor(guest), targets: [], body: text('Also rename it.') }));
        expect(error(await pickOf(run.id, 1, 'any', [request, other.id]))).toEqual({ type: 'PickMismatch', run: run.id });
        expect(error(await pickOf(run.id, 1, 'any', [other.id]))).toEqual({ type: 'PickMismatch', run: run.id });
        expect(value(await s.use.sessionState({ session: id })).runs).toHaveLength(1);

        const next = value(await pickOf(run.id));
        expect(next.input.pick as unknown).toEqual({
            pickOf: run.id,
            assumption: 1,
            text: 'Cancel keeps the order.',
            alternative: { id: 'any', label: 'Any state' },
        });
        expect(next.input.note as unknown).toBe('redo it');
        // the agent is given the run it picked from, with what it changed
        const previous = value(await s.use.previousRuns({ run: next.id, maxDiff: 100_000 }));
        expect(previous.map((p) => p.run.id)).toEqual([run.id]);
        expect(previous[0].changes.kind).toBe('diff');
        // a run that did not complete (queued) cannot be picked from
        expect(error(await pickOf(next.id))).toEqual({ type: 'RunNotPickable', run: next.id });
    });

    test("a pick of another session's run is refused", async () => {
        const { s, id, run, token, request } = await runningRun();
        const assumptions = [{ text: 'Only drafts.', requests: [request], alternatives: [{ id: 'all', label: 'Any state' }] }];
        value(await s.use.finishRun({ run: run.id, token, facts, reply: reply({ requests: [{ request, status: 'done' }], assumptions }) }));
        value(await s.use.closeSession({ session: id, actor: actor(facilitator) }));
        const { id: second } = await started(s);
        const mine = value(await s.use.sendRequest({ session: second, actor: actor(guest), targets: [], body: text('Again.') }));
        const pick = { pickOf: run.id, assumption: value(C.makeTally(0)), alternative: value(C.makeReplyKey('all')) };
        expect(error(await s.use.queueRun({ session: second, requests: [mine.id], actor: actor(facilitator), pick }))).toEqual({
            type: 'RunOfAnotherSession',
            run: run.id,
        });
    });

    test("the facilitator's approval of an assumption is recorded once, sends nothing, and excludes a pick of it", async () => {
        const { s, id, run, token, request } = await runningRun();
        const tally = (n: number): C.Tally => value(C.makeTally(n));
        const approve = (of: C.AgentRunId, assumption: number, who = facilitator) =>
            s.use.approveAssumption({ session: id, actor: actor(who), assumption: { run: of, assumption: tally(assumption) } });
        const pickOf = (assumption: number, alternative: string) =>
            s.use.queueRun({
                session: id,
                requests: [request],
                actor: actor(facilitator),
                pick: { pickOf: run.id, assumption: tally(assumption), alternative: value(C.makeReplyKey(alternative)) },
            });
        // not completed yet: nothing to approve
        expect(error(await approve(run.id, 0))).toEqual({ type: 'RunNotApprovable', run: run.id });
        const assumptions = [
            { text: 'Only drafts.', requests: [request], alternatives: [{ id: 'any', label: 'Any state' }] },
            { text: 'Cancel keeps the order.', requests: [request], alternatives: [{ id: 'delete', label: 'Delete it' }] },
        ];
        value(await s.use.finishRun({ run: run.id, token, facts, reply: reply({ requests: [{ request, status: 'done' }], assumptions }) }));

        const unknown = knownAgentRunId('00000000-0000-4000-8000-0000000000ee');
        expect(error(await approve(unknown, 0))).toEqual({ type: 'RunNotFound', run: unknown });
        expect(error(await approve(run.id, 2))).toEqual({ type: 'AssumptionNotFound', run: run.id });
        expect(error(await approve(run.id, 0, guest))).toEqual({ type: 'FacilitatorOnly' });

        const before = value(await s.use.sessionState({ session: id }));
        const approval = value(await approve(run.id, 0));
        expect(approval).toMatchObject({ state: 'Approved', session: id, assumption: { run: run.id, assumption: 0 }, approvedBy: facilitator });
        const after = value(await s.use.sessionState({ session: id }));
        expect(after.approvals).toEqual([approval]);
        // nothing is queued for the agent; the pages get the event
        expect(after.runs).toHaveLength(before.runs.length);
        const events = await s.use.eventsAfter({ session: id, cursor: 0, limit: 1000 });
        expect(events.at(-1)?.event).toMatchObject({ type: 'AssumptionApproved', approvalId: approval.id, assumption: { run: run.id, assumption: 0 } });

        // one decision per assumption: approved once, and not sent again with an alternative
        expect(error(await approve(run.id, 0))).toEqual({ type: 'AssumptionClosed', run: run.id });
        expect(error(await pickOf(0, 'any'))).toEqual({ type: 'AssumptionClosed', run: run.id });
        // the votes of the approved assumption close; those of the other stay open
        const vote = (assumption: number) =>
            s.use.setMark({
                session: id,
                actor: actor(guest),
                target: { kind: 'AssumptionChoice', run: run.id, assumption: tally(assumption) },
                sign: { kind: 'Vote' },
                placed: true,
            });
        expect(error(await vote(0))).toEqual({ type: 'MarkTargetClosed' });
        value(await vote(1));
        // the other assumption picked: a later run took over the run's requests, so nothing of it can be approved now
        value(await pickOf(1, 'delete'));
        expect(error(await approve(run.id, 1))).toEqual({ type: 'AssumptionClosed', run: run.id });
    });

    test("an approval of another session's run is refused", async () => {
        const { s, id, run, token, request } = await runningRun();
        const assumptions = [{ text: 'Only drafts.', requests: [request], alternatives: [] }];
        value(await s.use.finishRun({ run: run.id, token, facts, reply: reply({ requests: [{ request, status: 'done' }], assumptions }) }));
        value(await s.use.closeSession({ session: id, actor: actor(facilitator) }));
        const { id: second } = await started(s);
        const assumption = { run: run.id, assumption: value(C.makeTally(0)) };
        expect(error(await s.use.approveAssumption({ session: second, actor: actor(facilitator), assumption }))).toEqual({
            type: 'RunOfAnotherSession',
            run: run.id,
        });
        // nor in a closed session
        expect(error(await s.use.approveAssumption({ session: id, actor: actor(facilitator), assumption }))).toEqual({ type: 'SessionAlreadyClosed' });
    });
});

describe('revisions', () => {
    test('restore writes a past revision back after a pre-restore snapshot, and records it', async () => {
        const s = await session();
        const { id, start } = await started(s);
        await s.write('sales/sales.dt', SALES.replace('state Confirmed', 'state Confirmed\n    state Cancelled'));
        await mkdir(path.join(s.root, 'extra'), { recursive: true });
        await s.write('extra/new.dt', 'context Extra {}\n');
        const manual = value(await s.use.takeRevision({ session: id, actor: actor(facilitator) }));
        expect(manual.origin).toEqual({ kind: 'Manual', takenBy: facilitator });

        const { restored, preRestore } = value(await s.use.restoreRevision({ session: id, revision: start.id, actor: actor(facilitator) }));
        expect(await s.read('sales/sales.dt')).toBe(SALES);
        expect(await readFile(path.join(s.root, 'extra/new.dt')).catch(() => 'gone')).toBe('gone');
        expect(preRestore).toMatchObject({ origin: { kind: 'PreRestore', restoring: start.id }, contentHash: manual.contentHash });
        expect(restored).toMatchObject({ origin: { kind: 'Restored', restoredFrom: start.id, preRestore: preRestore.id }, contentHash: start.contentHash });
        const types = (await s.deps.uow.transaction((st) => st.outbox.readAfter(0, 100, id))).map((e) => e.event.type);
        expect(types.at(-1)).toBe('RevisionRestored');
    });

    test('a .dtes with a syntax error is kept in the revision as written, counted as a .dtes error; restoring an earlier one recovers', async () => {
        const s = await session();
        const { id, start } = await started(s);
        const broken = RETURNS.replace('  timeline Normal {', '  timeline Normal {{');
        await s.write('stormings/returns.dtes', broken);
        const manual = value(await s.use.takeRevision({ session: id, actor: actor(facilitator) }));
        expect(Number(manual.validation.dtesErrors)).toBeGreaterThan(0);
        expect(Number(manual.validation.dtErrors)).toBe(0);
        expect(manual.files.map((f): string => f.path)).toEqual(['sales/sales.dt', 'stormings/returns.dtes']);
        // the snapshot holds the broken text itself
        const c = value(await s.use.compareRevisions({ session: id, before: start.id, after: manual.id }));
        const dtes = c.files.find((f) => f.path === 'stormings/returns.dtes');
        expect(dtes?.status).toBe('changed');
        expect(dtes?.diff?.kind === 'diff' && dtes.diff.unified).toContain('+  timeline Normal {{');

        value(await s.use.restoreRevision({ session: id, revision: start.id, actor: actor(facilitator) }));
        expect(await s.read('stormings/returns.dtes')).toBe(RETURNS);
        // and back again: the broken revision can be restored as it was
        value(await s.use.restoreRevision({ session: id, revision: manual.id, actor: actor(facilitator) }));
        expect(await s.read('stormings/returns.dtes')).toBe(broken);
    });

    test('restore refuses external changes since the last revision, symbolic links, and a running run', async () => {
        const s = await session();
        const { id, start } = await started(s);
        await s.write('sales/sales.dt', `${SALES}\n`);
        expect(error(await s.use.restoreRevision({ session: id, revision: start.id, actor: actor(facilitator) }))).toEqual({
            type: 'ExternalChangesSinceSnapshot',
            paths: [value(C.makeWorkspacePath('sales/sales.dt'))],
        });
        value(await s.use.takeRevision({ session: id, actor: actor(facilitator) }));

        await symlink(path.join(s.root, 'sales'), path.join(s.root, 'linked'));
        expect(error(await s.use.restoreRevision({ session: id, revision: start.id, actor: actor(facilitator) }))).toEqual({
            type: 'SymlinkInWorkspace',
            path: value(C.makeWorkspacePath('linked')),
        });
        await rm(path.join(s.root, 'linked'));

        const run = await queuedRun(s, id, start);
        const { lease } = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000 }));
        expect(error(await s.use.restoreRevision({ session: id, revision: start.id, actor: actor(facilitator) }))).toEqual({
            type: 'RunInProgress',
            run: run.id,
        });
        value(await s.use.releaseRun({ run: run.id, token: lease.token }));
        expect(
            error(await s.use.restoreRevision({ session: id, revision: knownRevisionId('00000000-0000-4000-8000-999999999999'), actor: actor(facilitator) })),
        ).toMatchObject({
            type: 'RevisionNotFound',
        });
        value(await s.use.restoreRevision({ session: id, revision: start.id, actor: actor(facilitator) }));
        expect(await s.read('sales/sales.dt')).toBe(SALES);
    });

    test('restore writes .dt and .dtes together from one snapshot; the older revisions stay; the operation is logged', async () => {
        const s = await session();
        const { id, start } = await started(s);
        await s.write('sales/sales.dt', SALES.replace('state Confirmed', 'state Confirmed\n    state Cancelled'));
        await s.write('stormings/returns.dtes', RETURNS.replace('  event Received', '  event Received\n  event Refunded'));
        await s.write('stormings/more.dtes', 'storming More {\n  event Happened\n}\n');
        const manual = value(await s.use.takeRevision({ session: id, actor: actor(facilitator) }));
        const identity = { provider: 'dev' as const, subject: 'ada' };
        const { restored, preRestore } = value(await s.use.restoreRevision({ session: id, revision: start.id, actor: { ...actor(facilitator), identity } }));
        expect([await s.read('sales/sales.dt'), await s.read('stormings/returns.dtes')]).toEqual([SALES, RETURNS]);
        expect(await readFile(path.join(s.root, 'stormings/more.dtes')).catch(() => 'gone')).toBe('gone');
        expect(restored.files.map((f): string[] => [f.path, f.language])).toEqual([
            ['sales/sales.dt', 'Dt'],
            ['stormings/returns.dtes', 'Dtes'],
        ]);
        const history = value(await s.use.sessionState({ session: id })).revisions;
        expect(history.map((r) => [r.id, r.origin.kind])).toEqual([
            [start.id, 'SessionStart'],
            [manual.id, 'Manual'],
            [preRestore.id, 'PreRestore'],
            [restored.id, 'Restored'],
        ]);
        expect(history[1].contentHash).toBe(manual.contentHash);
        expect(await s.use.restoreOperations({ session: id })).toEqual([
            {
                id: expect.any(String),
                session: id,
                at: expect.any(Date),
                by: facilitator,
                identity,
                revision: start.id,
                preRestore: preRestore.id,
                restored: restored.id,
                result: 'Restored',
            },
        ]);
    });

    test('an external edit during or after a run is never overwritten without the two-step; the two-step keeps it as a revision', async () => {
        const s = await session();
        const { id, start } = await started(s);
        const run = await queuedRun(s, id, start);
        const { lease } = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000 }));
        value(await s.use.startRun({ run: run.id, token: lease.token }));
        const edited = SALES.replace('state Confirmed', 'state Confirmed\n    state Cancelled');
        await s.write('sales/sales.dt', edited);
        // during the run: refused, nothing written
        expect(error(await s.use.restoreRevision({ session: id, revision: start.id, actor: actor(facilitator), recordExternalChanges: true }))).toEqual({
            type: 'RunInProgress',
            run: run.id,
        });
        expect(await s.read('sales/sales.dt')).toBe(edited);
        value(await s.use.finishRun({ run: run.id, token: lease.token, facts }));

        // after the run: an edit by hand is an external change
        const byHand = `${edited}\n// by hand\n`;
        await s.write('sales/sales.dt', byHand);
        expect(error(await s.use.restoreRevision({ session: id, revision: start.id, actor: actor(facilitator) }))).toEqual({
            type: 'ExternalChangesSinceSnapshot',
            paths: [value(C.makeWorkspacePath('sales/sales.dt'))],
        });
        expect(await s.read('sales/sales.dt')).toBe(byHand);
        const before = value(await s.use.sessionState({ session: id })).revisions.length;
        expect(before).toBe(3); // SessionStart, RunBase, RunResult: a refusal records nothing

        const { manual, preRestore, restored } = value(
            await s.use.restoreRevision({ session: id, revision: start.id, actor: actor(facilitator), recordExternalChanges: true }),
        );
        expect(await s.read('sales/sales.dt')).toBe(SALES);
        expect(manual).toMatchObject({ origin: { kind: 'Manual', takenBy: facilitator } });
        const kept = value(await s.use.compareRevisions({ session: id, before: start.id, after: manual?.id ?? start.id }));
        const diff = kept.files.find((f) => f.path === 'sales/sales.dt')?.diff;
        expect(diff?.kind === 'diff' && diff.unified).toContain('+// by hand');
        const ops = await s.use.restoreOperations({ session: id });
        expect(ops.map((o) => [o.result, o.reason, o.manual, o.preRestore, o.restored])).toEqual([
            ['Refused', 'RunInProgress', undefined, undefined, undefined],
            ['Refused', 'ExternalChangesSinceSnapshot', undefined, undefined, undefined],
            ['Restored', undefined, manual?.id, preRestore.id, restored.id],
        ]);
    });

    test('restore refuses a path no longer under the sources, and a symbolic link made before the write; nothing is written', async () => {
        const root = await workspace();
        const s = await session(root, 'file');
        const { id, start } = await started(s);
        // the same workspace with narrower sources: the revision's .dtes is not a source there
        const narrow: CollaborationDeps = { ...s.deps, workspace: createWorkspaceSnapshot(root, sourceSelection(['sales/**/*.dt'])) };
        const use = createCollaboration(narrow);
        value(await use.takeRevision({ session: id, actor: actor(facilitator) }));
        const refused = error(await use.restoreRevision({ session: id, revision: start.id, actor: actor(facilitator) }));
        expect(refused).toEqual({ type: 'PathOutsideRoot', path: 'stormings/returns.dtes' });
        expect(await s.read('stormings/returns.dtes')).toBe(RETURNS);

        // a link appears between the checks and the write: the writer refuses before writing anything
        value(await s.use.takeRevision({ session: id, actor: actor(facilitator) }));
        await s.write('sales/sales.dt', `${SALES}\n`);
        value(await s.use.takeRevision({ session: id, actor: actor(facilitator) }));
        const racing: CollaborationDeps = {
            ...s.deps,
            workspace: {
                read: () => s.deps.workspace.read(),
                async write(files, expected) {
                    await symlink(path.join(root, 'sales'), path.join(root, 'linked'));
                    return s.deps.workspace.write(files, expected);
                },
            },
        };
        expect(error(await createCollaboration(racing).restoreRevision({ session: id, revision: start.id, actor: actor(facilitator) }))).toEqual({
            type: 'SymlinkInWorkspace',
            path: value(C.makeWorkspacePath('linked')),
        });
        expect(await s.read('sales/sales.dt')).toBe(`${SALES}\n`);
        const ops = await s.use.restoreOperations({ session: id });
        expect(ops.map((o) => [o.result, o.reason, o.preRestore !== undefined])).toEqual([
            ['Refused', 'PathOutsideRoot', true],
            ['Refused', 'SymlinkInWorkspace', true],
        ]);
    });

    test('a write that fails midway keeps the pre-restore revision and reports a manual recovery; the two-step recovers', async () => {
        const s = await session();
        const { id, start } = await started(s);
        const edited = SALES.replace('state Confirmed', 'state Confirmed\n    state Cancelled');
        await s.write('sales/sales.dt', edited);
        await s.write('stormings/returns.dtes', RETURNS.replace('  event Received', '  event Received\n  event Refunded'));
        value(await s.use.takeRevision({ session: id, actor: actor(facilitator) }));
        const failing: CollaborationDeps = {
            ...s.deps,
            workspace: {
                read: () => s.deps.workspace.read(),
                async write(files) {
                    // the first file is written, then the disk fails
                    const [first] = files;
                    await writeFile(path.join(s.root, first.path), first.bytes);
                    throw new Error('EIO: i/o error, write');
                },
            },
        };
        const failed = error(await createCollaboration(failing).restoreRevision({ session: id, revision: start.id, actor: actor(facilitator) }));
        const history = value(await s.use.sessionState({ session: id })).revisions;
        const preRestore = history.at(-1);
        expect(preRestore?.origin).toEqual({ kind: 'PreRestore', restoring: start.id });
        expect(failed).toMatchObject({
            type: 'ManualRecoveryNeeded',
            preRestore: preRestore?.id ?? '',
            cause: 'WriteFailed',
            message: 'EIO: i/o error, write',
        });
        expect(history.some((r) => r.origin.kind === 'Restored')).toBe(false);
        // half written: the .dt is the old one, the .dtes still the new one
        expect(await s.read('sales/sales.dt')).toBe(SALES);
        expect(await s.read('stormings/returns.dtes')).not.toBe(RETURNS);
        expect((await s.use.restoreOperations({ session: id })).map((o) => [o.result, o.reason, o.preRestore, o.detail])).toEqual([
            ['Failed', 'WriteFailed', preRestore?.id, 'EIO: i/o error, write'],
        ]);

        // the workspace differs from the last revision now: the two-step records it and restores the pre-restore one
        const pre = preRestore?.id ?? start.id;
        expect(error(await s.use.restoreRevision({ session: id, revision: pre, actor: actor(facilitator) }))).toMatchObject({
            type: 'ExternalChangesSinceSnapshot',
        });
        value(await s.use.restoreRevision({ session: id, revision: pre, actor: actor(facilitator), recordExternalChanges: true }));
        expect(await s.read('sales/sales.dt')).toBe(edited);
    });

    test('restore refuses while a run is claimed or running', async () => {
        const s = await session();
        const { id, start } = await started(s);
        const run = await queuedRun(s, id, start);
        const { lease } = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000 }));
        expect(error(await s.use.restoreRevision({ session: id, revision: start.id, actor: actor(facilitator) }))).toEqual({
            type: 'RunInProgress',
            run: run.id,
        });
        value(await s.use.startRun({ run: run.id, token: lease.token }));
        expect(error(await s.use.restoreRevision({ session: id, revision: start.id, actor: actor(facilitator) }))).toEqual({
            type: 'RunInProgress',
            run: run.id,
        });
        // cancelled: the lease ends, the restore goes on (the workspace is still the run's base)
        value(await s.use.cancelRun({ run: run.id, actor: actor(facilitator) }));
        value(await s.use.restoreRevision({ session: id, revision: start.id, actor: actor(facilitator) }));
    });

    test('compare: each file by DSL, added, removed, changed or unchanged, with a line diff, and both validations', async () => {
        const s = await session();
        const { id, start } = await started(s);
        await s.write(
            'sales/sales.dt',
            SALES.replace('state Confirmed', 'state Confirmed\n    state Cancelled').replace('Draft -> Confirmed', 'Draft -> Nowhere'),
        );
        await rm(path.join(s.root, 'stormings/returns.dtes'));
        await s.write('stormings/more.dtes', 'storming More {\n  event Happened\n}\n');
        await s.write('sales/other.dt', 'context Other {}\n');
        const manual = value(await s.use.takeRevision({ session: id, actor: actor(facilitator) }));
        const c = value(await s.use.compareRevisions({ session: id, before: start.id, after: manual.id }));
        expect(c.files.map((f): string[] => [f.path, f.language, f.status])).toEqual([
            ['sales/other.dt', 'Dt', 'added'],
            ['sales/sales.dt', 'Dt', 'changed'],
            ['stormings/more.dtes', 'Dtes', 'added'],
            ['stormings/returns.dtes', 'Dtes', 'removed'],
        ]);
        expect(c.counts).toEqual({ Dt: { added: 1, removed: 0, changed: 1, unchanged: 0 }, Dtes: { added: 1, removed: 1, changed: 0, unchanged: 0 } });
        const sales = c.files[1].diff;
        expect(sales).toEqual({
            kind: 'diff',
            unified: [
                '@@ -6,11 +6,12 @@',
                ' ',
                '     state Draft',
                '     state Confirmed',
                '+    state Cancelled',
                ' ',
                '     create command place(id: OrderId)',
                '       -> Draft',
                ' ',
                '     command confirm()',
                '-      Draft -> Confirmed',
                '+      Draft -> Nowhere',
                '   }',
                ' }',
            ].join('\n'),
            added: 2,
            removed: 1,
            truncated: false,
        });
        expect(c.files[3].diff).toMatchObject({ kind: 'diff', added: 0, removed: RETURNS.split('\n').length - 1 });
        expect([Number(c.before.validation.dtErrors), c.after.validation.dtErrors > 0]).toEqual([0, true]);
        expect(value(await s.use.compareRevisions({ session: id, before: start.id, after: start.id })).files.every((f) => f.status === 'unchanged')).toBe(true);

        const other = value(await s.use.startSession({ facilitator, name })).revision;
        expect(error(await s.use.compareRevisions({ session: id, before: start.id, after: other.id }))).toEqual({
            type: 'RevisionOfAnotherSession',
            revision: other.id,
        });
    });

    test('model changes: the elements two revisions differ by, kept per pair of revisions', async () => {
        const s = await session();
        const { id, start } = await started(s);
        await s.write('sales/sales.dt', SALES.replace('state Confirmed', 'state Confirmed\n    state Cancelled'));
        await s.write('stormings/more.dtes', 'storming More {\n  event Happened\n}\n');
        const manual = value(await s.use.takeRevision({ session: id, actor: actor(facilitator) }));
        let validated = 0;
        const counting = createCollaboration({ ...s.deps, validator: { validate: (sources) => (validated++, s.deps.validator.validate(sources)) } });
        const m = value(await counting.modelChanges({ session: id, before: start.id, after: manual.id }));
        expect(m.complete).toBe(true);
        expect(m.changes.map((c) => [c.change, c.language, c.kind, c.name, c.owner?.name])).toEqual([
            ['added', 'Dt', 'state', 'Cancelled', 'Order'],
            ['added', 'Dtes', 'event', 'Happened', 'More'],
        ]);
        expect(validated).toBe(2);
        expect(value(await counting.modelChanges({ session: id, before: start.id, after: manual.id }))).toEqual(m);
        // the pair is kept, and the revisions' analyses for the next pair
        expect(validated).toBe(2);
        expect(value(await counting.modelChanges({ session: id, before: manual.id, after: start.id })).changes.map((c) => c.change)).toEqual([
            'removed',
            'removed',
        ]);
        expect(validated).toBe(2);
        const other = value(await s.use.startSession({ facilitator, name })).revision;
        expect(error(await counting.modelChanges({ session: id, before: start.id, after: other.id }))).toEqual({
            type: 'RevisionOfAnotherSession',
            revision: other.id,
        });
    });

    test('compare bounds its work: a blob over the limit is never read, and the diffs stop at the budget', async () => {
        const s = await session();
        const { id, start } = await started(s);
        // over the 1 MiB a blob is read up to for a diff (domain/compare.ts)
        await s.write('sales/0-huge.dt', `// ${'x'.repeat(1024 * 1024)}\n`);
        const row = (i: number): string => `// ${String(i).padStart(6, '0')} ${'y'.repeat(490)}`;
        for (const f of ['a', 'b', 'c']) await s.write(`sales/${f}.dt`, `${Array.from({ length: 900 }, (_, i) => row(i)).join('\n')}\n`);
        const manual = value(await s.use.takeRevision({ session: id, actor: actor(facilitator) }));
        const read: string[] = [];
        const counting: CollaborationDeps = {
            ...s.deps,
            blobs: { put: (files) => s.deps.blobs.put(files), get: (hash) => (read.push(hash), s.deps.blobs.get(hash)) },
        };
        const c = value(await createCollaboration(counting).compareRevisions({ session: id, before: start.id, after: manual.id }));
        const by = new Map(c.files.map((f) => [String(f.path), f]));
        const huge = by.get('sales/0-huge.dt');
        expect(huge?.diff).toEqual({ kind: 'tooLarge' });
        expect(read).not.toContain(huge?.after);
        const [a, b, last] = ['a', 'b', 'c'].map((f) => by.get(`sales/${f}.dt`)?.diff);
        expect([a?.kind === 'diff' && a.truncated, b?.kind === 'diff' && b.truncated, last, c.diffsOmitted]).toEqual([false, true, undefined, true]);
        const shown = [a, b].reduce((n, d) => n + (d?.kind === 'diff' ? d.unified.length : 0), 0);
        // within the 512 KiB of diffs a comparison shows (application/use-cases.ts)
        expect(shown).toBeLessThanOrEqual(512 * 1024);
    });

    test("targets of requests are current, stale or unknown in the workspace now; they're never re-bound", async () => {
        const s = await session();
        const { id, start } = await started(s);
        const send = async (...targets: C.ModelTarget[]): Promise<C.RequestId> =>
            value(
                await s.use.sendRequest({
                    session: id,
                    actor: actor(guest),
                    targets: targets.map((target) => ({ target, sourceRevision: start.id })),
                    body: text('x'),
                }),
            ).id;
        const confirmed: C.ModelTarget = { kind: 'DtElement', element: value(C.makeElementName('Sales.Order#Confirmed')) };
        const order = await send(confirmed);
        const received: C.ModelTarget = {
            kind: 'DtesOccurrence',
            storming: value(C.makeStormingName('Returns')),
            timeline: value(C.makeTimelineName('Normal')),
            eventName: value(C.makeStormingEventName('Received')),
            occurrence: value(C.makeOccurrencePath('1')),
        };
        const occurrence = await send(received);
        // one status per target, in the request's order; none for the whole workspace
        const both = await send({ kind: 'DtElement', element: value(C.makeElementName('Sales.Order')) }, confirmed);
        const workspace = await send();
        expect([...value(await s.use.targetStatuses({ session: id })).statuses.values()]).toEqual([['current'], ['current'], ['current', 'current'], []]);
        await s.write('sales/sales.dt', SALES.replace('    state Confirmed\n', '').replace('Draft -> Confirmed', 'Draft -> Draft'));
        await s.write('stormings/returns.dtes', RETURNS.replace('    Requested\n', '    Requested\n    Requested\n'));
        const statuses = value(await s.use.targetStatuses({ session: id })).statuses;
        expect([statuses.get(order), statuses.get(occurrence), statuses.get(both), statuses.get(workspace)]).toEqual([
            ['stale'],
            ['stale'],
            ['current', 'stale'],
            [],
        ]);
    });
});

describe('reverting a run', () => {
    const CANCEL = '    command cancel() Draft -> Draft\n\n';
    const withCancel = (t: string): string => t.replace('    command confirm()', `${CANCEL}    command confirm()`);
    const withShipped = (t: string): string => t.replace('    state Confirmed\n', '    state Confirmed\n    state Shipped\n');
    const revertBody = text('「取り消しの付け足し」の変更を取り消す');
    /** The model as `dt fmt` formats it: what a mechanical revert writes is formatted, as a run's edits are. */
    const SALES_F = createSourceFormatter().format('sales/sales.dt', SALES);
    /** A session on the formatted model. */
    const formattedSession = async (): Promise<Session> => session(await workspace({ 'sales/sales.dt': SALES_F, 'stormings/returns.dtes': RETURNS }));

    /** A run of the session that edits the workspace with `edit` and completes, with the assumptions given. */
    async function completed(
        s: Session,
        id: C.SessionId,
        edit: () => Promise<void>,
        assumptions: { text: string; alternatives: { id: string; label: string }[] }[] = [],
    ): Promise<C.CompletedAgentRun> {
        const latest = value(await s.use.sessionState({ session: id })).revisions.at(-1);
        if (!latest) throw new Error('no revision');
        const run = await queuedRun(s, id, latest);
        const { lease } = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000, capabilities: ['revert'] }));
        value(await s.use.startRun({ run: run.id, token: lease.token }));
        await edit();
        const request = run.input.requests[0].request;
        const reply = toAgentReply({
            outcome: 'done',
            summary: 'Done.',
            requests: [{ request, status: 'done' }],
            questions: [],
            assumptions: assumptions.map((a) => ({ ...a, requests: [request] })),
        });
        const finished = value(await s.use.finishRun({ run: run.id, token: lease.token, facts, reply }));
        if (finished.run.state !== 'Completed') throw new Error(`run ${finished.run.state}`);
        return finished.run;
    }

    /** The facilitator asks for the revert of `run`: queued. */
    const request = async (s: Session, id: C.SessionId, run: C.AgentRunId, body = revertBody) =>
        value(await s.use.requestRevert({ session: id, actor: actor(facilitator), run, body }));
    /** The server's turn at the head of the queue. */
    const serverTurn = (s: Session, id: C.SessionId) => s.use.revertNext({ session: id, leaseMs: 30_000 });
    /** Asks for the revert of `run` with nothing ahead of it, then lets the server take it. */
    const revertNow = async (s: Session, id: C.SessionId, run: C.AgentRunId, body = revertBody) => {
        const requested = await request(s, id, run, body);
        return { requested, outcome: value(await serverTurn(s, id)) };
    };

    test("mechanically: the run's changes are reversed onto the workspace, a later run's kept, and recorded as a run of their own", async () => {
        const s = await formattedSession();
        const { id } = await started(s);
        const first = await completed(s, id, () => s.write('sales/sales.dt', withCancel(SALES_F)), [
            { text: 'Cancel keeps the order.', alternatives: [{ id: 'delete', label: 'Delete it' }] },
        ]);
        await completed(s, id, async () => s.write('sales/sales.dt', withShipped(await s.read('sales/sales.dt'))));
        const before = value(await s.use.sessionState({ session: id }));

        // the facilitator's only: nothing is sent, queued or recorded for anyone else
        expect(error(await s.use.requestRevert({ session: id, actor: actor(guest), run: first.id, body: revertBody }))).toEqual({ type: 'FacilitatorOnly' });
        expect(value(await s.use.sessionState({ session: id }))).toEqual(before);

        // asked: a request and a run queued like any other, nothing written yet
        const requested = await request(s, id, first.id);
        expect(requested.request).toMatchObject({ state: 'Sent', author: facilitator, body: revertBody, reverts: first.id, targets: [], mentions: [] });
        expect(requested.run).toMatchObject({
            state: 'Queued',
            queuedBy: facilitator,
            input: { requests: [{ request: requested.request.id, reverts: first.id, body: revertBody }] },
        });
        expect(await s.read('sales/sales.dt')).toBe(withShipped(withCancel(SALES_F)));

        // its turn: the server reverts it mechanically
        const outcome = value(await serverTurn(s, id));
        if (outcome.kind !== 'reverted') throw new Error(`not reverted mechanically: ${outcome.kind}`);
        const run = outcome.run;
        expect(run).toMatchObject({ id: requested.run.id, state: 'Reverted', changed: true });
        // the later run's state stays, the first run's command is gone
        expect(await s.read('sales/sales.dt')).toBe(withShipped(SALES_F));
        const after = value(await s.use.sessionState({ session: id }));
        const revision = (rid: C.RevisionId) => after.revisions.find((r) => r.id === rid);
        expect(revision(run.baseRevision)?.origin).toEqual({ kind: 'RunBase', run: run.id });
        expect(revision(run.resultRevision)?.origin).toEqual({ kind: 'RunResult', run: run.id });
        expect(after.runs.at(-1)).toEqual(run);
        const events = (await s.use.eventsAfter({ session: id, cursor: 0, limit: 1000 })).map((e) => e.event.type);
        expect(events.slice(-5)).toEqual(['RequestSent', 'RunQueued', 'RevisionRecorded', 'RevisionRecorded', 'RunReverted']);
        // what it changed is the first run's change backwards
        const compared = value(await s.use.compareRevisions({ session: id, before: run.baseRevision, after: run.resultRevision }));
        expect(compared.files.find((f) => f.path === 'sales/sales.dt')?.diff).toMatchObject({ kind: 'diff', added: 0, removed: 2 });
        // the lease is the server's no more: the queue is free
        expect(error(await serverTurn(s, id))).toEqual({ type: 'NothingQueued' });

        // reverted once: the assumptions of the run are closed, its votes too, and it is not reverted again
        const tally = (n: number): C.Tally => value(C.makeTally(n));
        expect(error(await s.use.approveAssumption({ session: id, actor: actor(facilitator), assumption: { run: first.id, assumption: tally(0) } }))).toEqual({
            type: 'AssumptionClosed',
            run: first.id,
        });
        expect(
            error(
                await s.use.setMark({
                    session: id,
                    actor: actor(guest),
                    target: { kind: 'AssumptionChoice', run: first.id, assumption: tally(0) },
                    sign: { kind: 'Vote' },
                    placed: true,
                }),
            ),
        ).toEqual({ type: 'MarkTargetClosed' });
        expect(error(await s.use.requestRevert({ session: id, actor: actor(facilitator), run: first.id, body: revertBody }))).toEqual({
            type: 'RunNotRevertable',
            run: first.id,
        });
        // the revert is a unit of work of its own: reverted in turn, the run's changes are back
        await revertNow(s, id, run.id, text('打ち消しを打ち消す'));
        expect(await s.read('sales/sales.dt')).toBe(withShipped(withCancel(SALES_F)));
    });

    test('a file the run added is removed, one it removed comes back', async () => {
        const s = await formattedSession();
        const { id } = await started(s);
        const run = await completed(s, id, async () => {
            await s.write('sales/billing.dt', 'context Billing {\n  id InvoiceId: UUID\n}\n');
            await rm(path.join(s.root, 'stormings/returns.dtes'));
        });
        expect((await revertNow(s, id, run.id)).outcome.kind).toBe('reverted');
        expect(await s.read('stormings/returns.dtes')).toBe(RETURNS);
        expect(await s.read('sales/billing.dt').catch(() => 'gone')).toBe('gone');
    });

    test('a later change of the same lines: left queued for the AI with the conflict; the workspace is left as it is', async () => {
        const s = await formattedSession();
        const { id } = await started(s);
        const first = await completed(s, id, () => s.write('sales/sales.dt', withCancel(SALES_F)));
        const renamed = withCancel(SALES_F).replace('command cancel()', 'command cancelOrder()');
        await completed(s, id, () => s.write('sales/sales.dt', renamed));

        const requested = await request(s, id, first.id);
        // not tried yet: no agent gets it, whatever it can run (the server's turn first)
        expect(error(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000, capabilities: ['revert'] }))).toEqual({
            type: 'RunInProgress',
            run: requested.run.id,
        });
        const outcome = value(await serverTurn(s, id));
        expect(outcome).toMatchObject({ kind: 'leftToAgent', obstacle: { kind: 'Conflict', paths: ['sales/sales.dt'] } });
        expect(await s.read('sales/sales.dt')).toBe(renamed);
        expect(outcome.run).toMatchObject({
            id: requested.run.id,
            state: 'Queued',
            revertObstacle: { kind: 'Conflict', paths: ['sales/sales.dt'] },
            input: { requests: [{ request: requested.request.id, reverts: first.id }] },
        });
        expect((await s.use.eventsAfter({ session: id, cursor: 0, limit: 1000 })).at(-1)?.event).toMatchObject({
            type: 'RevertLeftToAgent',
            runId: requested.run.id,
        });
        // tried once: the server leaves it to the agent from now on
        expect(error(await serverTurn(s, id))).toEqual({ type: 'NothingQueued' });
        // under way: not asked twice
        expect(error(await s.use.requestRevert({ session: id, actor: actor(facilitator), run: first.id, body: revertBody }))).toEqual({
            type: 'RunNotRevertable',
            run: first.id,
        });

        // a subscriber that cannot run a revert is not given it: the run stays queued
        expect(error(await s.use.claimNextRun({ session: id, owner: 'old', leaseMs: 30_000 }))).toMatchObject({
            type: 'SubscriberOutdated',
            run: requested.run.id,
            needs: 'revert',
        });
        const { lease } = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000, capabilities: ['revert'] }));
        value(await s.use.startRun({ run: requested.run.id, token: lease.token }));
        // the agent is told the run it reverts, with its diff file by file
        const told = value(await s.use.revertedRuns({ run: requested.run.id }));
        expect(told).toHaveLength(1);
        expect(told[0].run.id).toBe(first.id);
        expect(told[0].changes.diffsOmitted).toBe(false);
        expect(told[0].changes.files[0]).toMatchObject({ path: 'sales/sales.dt', status: 'changed' });
        expect(told[0].changes.files[0].diff).toContain('+    command cancel()');

        // the AI reverted it: the run counts as reverted once its revert completed
        await s.write('sales/sales.dt', SALES_F);
        const req = requested.request.id;
        const reply = toAgentReply({ outcome: 'done', summary: 'Reverted.', requests: [{ request: req, status: 'done' }], questions: [], assumptions: [] });
        expect(value(await s.use.finishRun({ run: requested.run.id, token: lease.token, facts, reply })).run.state).toBe('Completed');
        expect(error(await s.use.requestRevert({ session: id, actor: actor(facilitator), run: first.id, body: revertBody }))).toEqual({
            type: 'RunNotRevertable',
            run: first.id,
        });
    });

    test('a revert that would not check (a later change needs what the run added) goes to the AI; nothing is written', async () => {
        const s = await formattedSession();
        const { id } = await started(s);
        const first = await completed(s, id, () =>
            s.write('sales/sales.dt', SALES_F.replace('    state Confirmed\n', '    state Confirmed\n    state Cancelled\n')),
        );
        const later = (await s.read('sales/sales.dt')).replace('    command confirm()', '    command cancel() Draft -> Cancelled\n\n    command confirm()');
        await completed(s, id, () => s.write('sales/sales.dt', later));
        const { outcome } = await revertNow(s, id, first.id);
        expect(outcome).toMatchObject({ kind: 'leftToAgent', obstacle: { kind: 'Check', unparsedDtes: [] } });
        if (outcome.kind === 'leftToAgent' && outcome.obstacle.kind === 'Check') expect(outcome.obstacle.newDtErrors).toBeGreaterThan(0);
        expect(await s.read('sales/sales.dt')).toBe(later);
    });

    test('asked while a run is running: queued behind it, then reverted mechanically when its turn comes', async () => {
        const s = await formattedSession();
        const { id } = await started(s);
        const first = await completed(s, id, () => s.write('sales/sales.dt', withCancel(SALES_F)));
        const latest = value(await s.use.sessionState({ session: id })).revisions.at(-1);
        if (!latest) throw new Error('no revision');
        const busy = await queuedRun(s, id, latest);
        const { lease } = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000, capabilities: ['revert'] }));
        value(await s.use.startRun({ run: busy.id, token: lease.token }));

        // not refused: queued behind the running run, and the server leaves it while that runs
        const requested = await request(s, id, first.id);
        expect(requested.run.state).toBe('Queued');
        expect(error(await serverTurn(s, id))).toEqual({ type: 'RunInProgress', run: busy.id });
        expect(await s.read('sales/sales.dt')).toBe(withCancel(SALES_F));

        // the running run changes the model elsewhere, and ends
        await s.write('sales/sales.dt', withShipped(withCancel(SALES_F)));
        const reply = toAgentReply({
            outcome: 'done',
            summary: 'Done.',
            requests: [{ request: busy.input.requests[0].request, status: 'done' }],
            questions: [],
            assumptions: [],
        });
        value(await s.use.finishRun({ run: busy.id, token: lease.token, facts, reply }));

        // its turn: reverted against the workspace as it is then, the later change kept
        const outcome = value(await serverTurn(s, id));
        expect(outcome).toMatchObject({ kind: 'reverted', run: { id: requested.run.id, state: 'Reverted', changed: true } });
        expect(await s.read('sales/sales.dt')).toBe(withShipped(SALES_F));
    });

    test('nothing of the run left when its turn comes: completed as nothing to revert, nothing written', async () => {
        const s = await formattedSession();
        const { id } = await started(s);
        const first = await completed(s, id, () => s.write('sales/sales.dt', withCancel(SALES_F)));
        await s.write('sales/sales.dt', SALES_F);
        const { requested, outcome } = await revertNow(s, id, first.id);
        if (outcome.kind !== 'reverted') throw new Error(`not reverted: ${outcome.kind}`);
        expect(outcome.run).toMatchObject({ id: requested.run.id, state: 'Reverted', changed: false });
        expect(outcome.run.resultRevision).toBe(outcome.run.baseRevision);
        expect(await s.read('sales/sales.dt')).toBe(SALES_F);
        // the run counts as reverted (its changes are gone): its assumptions are closed, it is not asked again
        expect(error(await s.use.requestRevert({ session: id, actor: actor(facilitator), run: first.id, body: revertBody }))).toEqual({
            type: 'RunNotRevertable',
            run: first.id,
        });
        // a run without changes is not reverted
        const unchanged = await completed(s, id, async () => {});
        expect(error(await s.use.requestRevert({ session: id, actor: actor(facilitator), run: unchanged.id, body: revertBody }))).toEqual({
            type: 'RunNotRevertable',
            run: unchanged.id,
        });
    });

    test('a queued revert can be stopped; stopped, it is never tried, and can be asked again', async () => {
        const s = await formattedSession();
        const { id } = await started(s);
        const first = await completed(s, id, () => s.write('sales/sales.dt', withCancel(SALES_F)));
        const latest = value(await s.use.sessionState({ session: id })).revisions.at(-1);
        if (!latest) throw new Error('no revision');
        const busy = await queuedRun(s, id, latest);
        const { lease } = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000, capabilities: ['revert'] }));
        const requested = await request(s, id, first.id);
        expect(value(await s.use.cancelRun({ run: requested.run.id, actor: actor(facilitator) })).state).toBe('Cancelled');
        value(await s.use.releaseRun({ run: busy.id, token: lease.token }));
        value(await s.use.cancelRun({ run: busy.id, actor: actor(facilitator) }));
        expect(error(await serverTurn(s, id))).toEqual({ type: 'NothingQueued' });
        expect(await s.read('sales/sales.dt')).toBe(withCancel(SALES_F));
        // stopped is not reverted: it may be asked again
        expect((await revertNow(s, id, first.id)).outcome.kind).toBe('reverted');
    });

    test('never processed twice: the server holds its own lease while it tries; a revert stopped meanwhile writes nothing', async () => {
        const s = await formattedSession();
        const { id } = await started(s);
        const first = await completed(s, id, () => s.write('sales/sales.dt', withCancel(SALES_F)));
        const requested = await request(s, id, first.id);

        // while the server tries it (its workspace read held up), an agent cannot claim anything, and the server
        // itself does not take it twice; the facilitator stops it meanwhile
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => (release = resolve));
        const read = s.deps.workspace.read.bind(s.deps.workspace);
        let reads = 0;
        s.deps.workspace.read = async () => {
            if (reads++ === 0) await held;
            return read();
        };
        const trying = serverTurn(s, id);
        await Bun.sleep(20);
        expect(error(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000, capabilities: ['revert'] }))).toEqual({
            type: 'RunInProgress',
            run: requested.run.id,
        });
        expect(error(await serverTurn(s, id))).toEqual({ type: 'RunInProgress', run: requested.run.id });
        expect(value(await s.use.cancelRun({ run: requested.run.id, actor: actor(facilitator) })).state).toBe('Cancelled');
        release();
        expect(error(await trying)).toEqual({ type: 'LeaseLost', run: requested.run.id });
        expect(await s.read('sales/sales.dt')).toBe(withCancel(SALES_F));
        expect(value(await s.use.sessionState({ session: id })).runs.at(-1)?.state).toBe('Cancelled');
    });
});

describe('who may do what (ADR 0027): the actor of every use case, the rules in the commands', () => {
    const FACILITATOR_ONLY: C.FacilitatorOnly = { type: 'FacilitatorOnly' };

    test('only the facilitator queues, cancels, takes, restores and closes; nothing changes on a refusal', async () => {
        const s = await session();
        const { id, start } = await started(s);
        const run = await queuedRun(s, id, start);
        const request = run.input.requests[0].request;
        const before = await s.use.eventsAfter({ session: id, cursor: 0, limit: 1000 });

        expect(error(await s.use.queueRun({ session: id, requests: [request], actor: actor(guest) }))).toEqual(FACILITATOR_ONLY);
        expect(error(await s.use.cancelRun({ run: run.id, actor: actor(guest) }))).toEqual(FACILITATOR_ONLY);
        expect(error(await s.use.takeRevision({ session: id, actor: actor(guest) }))).toEqual(FACILITATOR_ONLY);
        await s.write('sales/sales.dt', SALES.replace('state Confirmed', 'state Confirmed\n    state Cancelled'));
        expect(error(await s.use.restoreRevision({ session: id, revision: start.id, actor: actor(guest), recordExternalChanges: true }))).toEqual(
            FACILITATOR_ONLY,
        );
        expect(error(await s.use.closeSession({ session: id, actor: actor(guest) }))).toEqual(FACILITATOR_ONLY);

        // the restore was refused before the workspace was read: no revision recorded on the way, nothing written
        expect(await s.read('sales/sales.dt')).toContain('state Cancelled');
        expect(await s.use.eventsAfter({ session: id, cursor: 0, limit: 1000 })).toEqual(before);
        expect((await s.use.restoreOperations({ session: id })).map((o) => [o.by, o.result, o.reason])).toEqual([[guest, 'Refused', 'FacilitatorOnly']]);
        const state = value(await s.use.sessionState({ session: id }));
        expect([state.session.state, state.runs.map((r) => r.state), state.revisions.map((r) => [r.origin.kind, r.state])]).toEqual([
            'Open',
            ['Queued'],
            [['SessionStart', 'Recorded']],
        ]);

        expect(value(await s.use.cancelRun({ run: run.id, actor: actor(facilitator) })).state).toBe('Cancelled');
        expect(value(await s.use.closeSession({ session: id, actor: actor(facilitator) })).state).toBe('Closed');
    });

    test('the actor of an identity: the facilitator when it holds the role, a participant otherwise', () => {
        const ada = { provider: 'dev' as const, subject: 'ada' };
        const bob = { provider: 'access' as const, subject: 'bob' };
        expect(actorOf(ada, ada)).toEqual({ kind: 'participant', participant: FACILITATOR_PARTICIPANT, role: 'Facilitator', identity: ada });
        expect(actorOf(bob, ada)).toEqual({ kind: 'participant', participant: value(C.makeParticipantId('access:bob')), role: 'Participant', identity: bob });
        expect(actorOf(ada, undefined)).toEqual({
            kind: 'participant',
            participant: value(C.makeParticipantId('dev:ada')),
            role: 'Participant',
            identity: ada,
        });
    });
});

describe("people's edits of the stickies (ADR 0033)", () => {
    const LABELLED = `storming Returns "返品" {
  event Requested "返品を受け付けた"
  event Received "返品が届いた"
  policy Refund "返金する" {
    on Received
  }
  timeline Normal "通常" {
    Requested
    Received
  }
}
`;
    const labelledSession = async (): Promise<Session> => session(await workspace({ 'sales/sales.dt': SALES, 'stormings/returns.dtes': LABELLED }));
    const body = text('「返品が届いた」を直す');
    const relabel = (label: string, expected = '返品が届いた') =>
        ({ kind: 'wording', storming: 'Returns', element: 'Received', expected: { name: 'Received', label: expected }, label }) as const;

    test('anyone edits a label: only that string changes, recorded as an edit with its revisions, out of the queue', async () => {
        const s = await labelledSession();
        const { id } = await started(s);
        const edited = value(await s.use.editSticky({ session: id, actor: actor(guest), edit: relabel('荷物が戻った'), body }));
        expect(await s.read('stormings/returns.dtes')).toBe(LABELLED.replace('"返品が届いた"', '"荷物が戻った"'));
        expect(edited.request).toMatchObject({
            author: guest,
            body,
            edit: {
                kind: 'Wording',
                storming: 'Returns',
                nameBefore: 'Received',
                nameAfter: 'Received',
                labelBefore: '返品が届いた',
                labelAfter: '荷物が戻った',
            },
        });
        expect(edited.run).toMatchObject({ state: 'Edited', queuedBy: guest, input: { requests: [{ request: edited.request.id, author: guest }] } });
        const state = value(await s.use.sessionState({ session: id }));
        const origin = (rid: C.RevisionId) => state.revisions.find((r) => r.id === rid)?.origin;
        expect(origin(edited.run.baseRevision)).toEqual({ kind: 'RunBase', run: edited.run.id });
        expect(origin(edited.run.resultRevision)).toEqual({ kind: 'RunResult', run: edited.run.id });
        // never claimed by an agent
        expect(error(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000 }))).toEqual({ type: 'NothingQueued' });
    });

    test('refused, with nothing written: what the page saw is gone, a taken or bad name, nothing to change', async () => {
        const s = await labelledSession();
        const { id } = await started(s);
        await s.write('stormings/returns.dtes', LABELLED.replace('"返品が届いた"', '"届いた"'));
        expect(error(await s.use.editSticky({ session: id, actor: actor(guest), edit: relabel('荷物が戻った'), body }))).toEqual({
            type: 'StickyStale',
            current: { name: 'Received', label: '届いた' },
        });
        const rename = (name: string) =>
            ({ kind: 'wording', storming: 'Returns', element: 'Received', expected: { name: 'Received', label: '届いた' }, name }) as const;
        expect(error(await s.use.editSticky({ session: id, actor: actor(guest), edit: rename('Requested'), body }))).toEqual({
            type: 'InvalidStickyName',
            problem: 'duplicate',
        });
        expect(error(await s.use.editSticky({ session: id, actor: actor(guest), edit: rename('9x'), body }))).toEqual({
            type: 'InvalidStickyName',
            problem: 'format',
        });
        expect(error(await s.use.editSticky({ session: id, actor: actor(guest), edit: relabel('届いた', '届いた'), body }))).toEqual({
            type: 'NothingToChange',
        });
        expect(await s.read('stormings/returns.dtes')).toBe(LABELLED.replace('"返品が届いた"', '"届いた"'));
        expect(value(await s.use.sessionState({ session: id })).runs).toEqual([]);
    });

    test('a rename rewrites the references; a hotspot is put on an event and resolved; an edit is reverted as a run is', async () => {
        const s = await labelledSession();
        const { id } = await started(s);
        const renamed = value(
            await s.use.editSticky({
                session: id,
                actor: actor(guest),
                edit: { kind: 'wording', storming: 'Returns', element: 'Received', expected: { name: 'Received', label: '返品が届いた' }, name: 'Arrived' },
                body,
            }),
        );
        expect(renamed.references).toBe(2);
        const renamedText = LABELLED.replace('event Received', 'event Arrived').replace('on Received', 'on Arrived').replace('    Received\n', '    Arrived\n');
        expect(await s.read('stormings/returns.dtes')).toBe(renamedText);

        value(
            await s.use.editSticky({
                session: id,
                actor: actor(guest),
                edit: { kind: 'addHotspot', storming: 'Returns', on: 'Arrived', name: 'Broken', label: '壊れていたら？' },
                body,
            }),
        );
        value(
            await s.use.editSticky({
                session: id,
                actor: actor(guest),
                edit: { kind: 'resolveHotspot', storming: 'Returns', element: 'Broken', resolution: '返金しない' },
                body,
            }),
        );
        expect(await s.read('stormings/returns.dtes')).toContain(
            '  hotspot Broken "壊れていたら？" {\n    on Arrived\n    status resolved\n    resolution "返金しない"\n  }\n}\n',
        );

        // the facilitator reverts the rename like any run: the old name comes back everywhere, the later edits stay
        value(await s.use.requestRevert({ session: id, actor: actor(facilitator), run: renamed.run.id, body: text('「名前」の変更を打ち消す') }));
        const outcome = value(await s.use.revertNext({ session: id, leaseMs: 30_000 }));
        expect(outcome.kind).toBe('reverted');
        const reverted = await s.read('stormings/returns.dtes');
        expect(reverted).toContain('event Received "返品が届いた"');
        expect(reverted).toContain('on Received');
        // the hotspot written after the rename keeps the name it was written with (a line-based revert)
        expect(reverted).toContain('  hotspot Broken "壊れていたら？" {\n    on Arrived\n');
    });

    test("a hotspot's question and resolution: one edit records both; emptying the resolution reopens it; its name stays", async () => {
        const s = await labelledSession();
        const { id } = await started(s);
        value(
            await s.use.editSticky({
                session: id,
                actor: actor(guest),
                edit: { kind: 'addHotspot', storming: 'Returns', on: 'Received', name: 'ReceivedQuestion', label: '壊れていたら？' },
                body,
            }),
        );
        const both = value(
            await s.use.editSticky({
                session: id,
                actor: actor(guest),
                edit: {
                    kind: 'hotspot',
                    storming: 'Returns',
                    element: 'ReceivedQuestion',
                    expected: { question: '壊れていたら？' },
                    question: '壊れて届いたら？',
                    resolution: '返金する',
                },
                body,
            }),
        );
        expect(both.request.edit).toMatchObject({
            kind: 'HotspotEdited',
            hotspot: 'ReceivedQuestion',
            questionBefore: '壊れていたら？',
            questionAfter: '壊れて届いたら？',
            resolutionAfter: '返金する',
        });
        expect(await s.read('stormings/returns.dtes')).toContain(
            '  hotspot ReceivedQuestion "壊れて届いたら？" {\n    on Received\n    status resolved\n    resolution "返金する"\n  }\n',
        );
        const reopened = value(
            await s.use.editSticky({
                session: id,
                actor: actor(guest),
                edit: {
                    kind: 'hotspot',
                    storming: 'Returns',
                    element: 'ReceivedQuestion',
                    expected: { question: '壊れて届いたら？', resolution: '返金する' },
                    resolution: null,
                },
                body,
            }),
        );
        expect(reopened.request.edit).toMatchObject({ kind: 'HotspotEdited', resolutionBefore: '返金する' });
        expect(reopened.request.edit).not.toHaveProperty('resolutionAfter');
        expect(await s.read('stormings/returns.dtes')).toContain('  hotspot ReceivedQuestion "壊れて届いたら？" {\n    on Received\n  }\n');
    });

    describe('while a run runs (the maintainer chose to re-apply)', () => {
        /** A run claimed and started now: its base is the workspace as it is. */
        async function running(s: Session, id: C.SessionId): Promise<{ run: C.QueuedAgentRun; token: string }> {
            const latest = value(await s.use.sessionState({ session: id })).revisions.at(-1);
            if (!latest) throw new Error('no revision');
            const run = await queuedRun(s, id, latest);
            const { lease } = value(await s.use.claimNextRun({ session: id, owner: 'agent', leaseMs: 30_000 }));
            value(await s.use.startRun({ run: run.id, token: lease.token }));
            return { run, token: lease.token };
        }

        test("an edit the run dropped (it wrote the file as it read it) is written again after it, as the same person's", async () => {
            const s = await labelledSession();
            const { id } = await started(s);
            const { run, token } = await running(s, id);
            const read = await s.read('stormings/returns.dtes');
            s.clock.t += 1000;
            const edited = value(await s.use.editSticky({ session: id, actor: actor(guest), edit: relabel('荷物が戻った'), body }));
            // the agent writes its version of what it read before the edit: a new event, and the old label
            await s.write('stormings/returns.dtes', read.replace('  policy Refund', '  event Inspected "検品した"\n  policy Refund'));
            s.clock.t += 1000;
            value(await s.use.finishRun({ run: run.id, token, facts }));
            const after = await s.use.reapplyEdits({ session: id, run: run.id });
            expect(after.conflicts).toEqual([]);
            expect(after.reapplied).toMatchObject({
                state: 'Edited',
                reapplies: run.id,
                queuedBy: guest,
                input: { requests: [{ request: edited.request.id }] },
            });
            const text_ = await s.read('stormings/returns.dtes');
            expect(text_).toContain('event Received "荷物が戻った"');
            expect(text_).toContain('event Inspected "検品した"');
            // the agent's next run is told of the edit, old → new
            const next = await running(s, id);
            const told = await s.use.peopleEditsSince({ run: next.run.id });
            expect(told.map((e): unknown[] => [e.by, e.edit.kind === 'Wording' && [String(e.edit.labelBefore), String(e.edit.labelAfter)]])).toEqual([
                [guest, ['返品が届いた', '荷物が戻った']],
                [guest, ['返品が届いた', '荷物が戻った']],
            ]);
        });

        test('a rename the run dropped gets the new name back, in the references the run wrote too', async () => {
            const s = await labelledSession();
            const { id } = await started(s);
            const { run, token } = await running(s, id);
            const read = await s.read('stormings/returns.dtes');
            s.clock.t += 1000;
            value(
                await s.use.editSticky({
                    session: id,
                    actor: actor(guest),
                    edit: { kind: 'wording', storming: 'Returns', element: 'Received', expected: { name: 'Received', label: '返品が届いた' }, name: 'Arrived' },
                    body,
                }),
            );
            // the agent adds a step naming the old ID
            await s.write('stormings/returns.dtes', read.replace('    Received\n  }', '    Received\n    Received\n  }'));
            s.clock.t += 1000;
            value(await s.use.finishRun({ run: run.id, token, facts }));
            expect((await s.use.reapplyEdits({ session: id, run: run.id })).reapplied?.state).toBe('Edited');
            const text_ = await s.read('stormings/returns.dtes');
            expect(text_).not.toMatch(/\bReceived\b/);
            expect(text_.match(/\bArrived\b/g)).toHaveLength(4);
        });

        test("a label the run changed otherwise is kept as the run's, and the edit notes the conflict for people to choose", async () => {
            const s = await labelledSession();
            const { id } = await started(s);
            const { run, token } = await running(s, id);
            const read = await s.read('stormings/returns.dtes');
            s.clock.t += 1000;
            const edited = value(await s.use.editSticky({ session: id, actor: actor(guest), edit: relabel('荷物が戻った'), body }));
            await s.write('stormings/returns.dtes', read.replace('"返品が届いた"', '"返品を受け取った"'));
            s.clock.t += 1000;
            value(await s.use.finishRun({ run: run.id, token, facts }));
            const after = await s.use.reapplyEdits({ session: id, run: run.id });
            expect(after.reapplied).toBeUndefined();
            expect(after.conflicts.map((c): unknown[] => [c.id, c.conflict])).toEqual([
                [edited.run.id, { run: run.id, runLabel: '返品を受け取った', settled: false }],
            ]);
            expect(await s.read('stormings/returns.dtes')).toContain('"返品を受け取った"');
            // people chose: settled
            expect(value(await s.use.settleConflict({ session: id, run: edited.run.id })).conflict?.settled).toBe(true);
            expect(error(await s.use.settleConflict({ session: id, run: edited.run.id }))).toEqual({ type: 'NothingToSettle' });
        });

        test('an edit the run kept is left alone', async () => {
            const s = await labelledSession();
            const { id } = await started(s);
            const { run, token } = await running(s, id);
            s.clock.t += 1000;
            value(await s.use.editSticky({ session: id, actor: actor(guest), edit: relabel('荷物が戻った'), body }));
            s.clock.t += 1000;
            value(await s.use.finishRun({ run: run.id, token, facts }));
            expect(await s.use.reapplyEdits({ session: id, run: run.id })).toEqual({ conflicts: [] });
        });
    });
});
