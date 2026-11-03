import { describe, expect, test } from 'bun:test';
import { Collaboration as C } from '../generated/index.js';
import { AI_PARTICIPANT_ID } from './ai.js';
import { knownAgentRunId, knownChangeProposalId, knownRequestId, knownRevisionId, knownSessionId, knownTriageId } from './ids.js';
import { snapshotFile, snapshotHash } from './snapshot.js';
import { chatWindow, sessionSoFar, timelineEntries, type TimelineRecords } from './timeline.js';
import { tally } from './validation.js';

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
    return r.value;
};
const text = (t: string): C.Text => value(C.makeText(t));
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const minute = (m: number): Date => new Date(Date.UTC(2026, 10, 3, 9, m));

const session = knownSessionId(id(1));
const ada = value(C.makeParticipantId('local:facilitator'));
const bob = value(C.makeParticipantId('dev:bob'));
const open: C.OpenSession = {
    state: 'Open',
    id: session,
    facilitator: ada,
    mode: 'Collab',
    participants: [
        { id: ada, name: value(C.makeDisplayName('Ada')), role: 'Facilitator', joinedAt: minute(0) },
        { id: bob, name: value(C.makeDisplayName('Bob')), role: 'Participant', joinedAt: minute(0) },
    ],
    startedAt: minute(0),
};

const message = (n: number, author: C.ParticipantId, body: string, at: Date, extra: Partial<C.SentRequest> = {}): C.SentRequest => ({
    state: 'Sent',
    id: knownRequestId(id(n)),
    session,
    author,
    targets: [],
    body: text(body),
    sentAt: at,
    mentions: [],
    ...extra,
});

const file = (path: string, content: string): C.SnapshotFile => snapshotFile(value(C.makeWorkspacePath(path)), new TextEncoder().encode(content));
const validation: C.ValidationSummary = { dtErrors: tally(0), dtesErrors: tally(0), dtesWarnings: tally(0), linkWarnings: tally(0), stale: false };
const revision = (n: number, origin: C.RevisionOrigin, files: C.SnapshotFile[], at: Date): C.RecordedRevision => ({
    state: 'Recorded',
    id: knownRevisionId(id(n)),
    session,
    origin,
    contentHash: snapshotHash(files),
    files,
    validation,
    takenAt: at,
});

const before = [file('sales/order.dt', 'context Sales {}\n')];
const after = [file('sales/order.dt', 'context Sales { id OrderId: UUID }\n')];
const edited = [file('sales/order.dt', 'context Sales { id OrderId: UUID }\n'), file('sales/note.dt', 'context Note {}\n')];

const asked = message(10, bob, '@AI[p1] 注文を取り消せる？', minute(1), { mentions: [AI_PARTICIPANT_ID] });
const answer = message(11, AI_PARTICIPANT_ID, '確定前だけです。', minute(2), { replyTo: { kind: 'Message', request: asked.id } });
const wish = message(12, bob, '@AI[p1] 取り消しを足して', minute(3), { mentions: [AI_PARTICIPANT_ID] });
const own = message(13, ada, '#注文[1] に ID を足して', minute(5), {
    targets: [{ target: { kind: 'DtElement', element: value(C.makeElementName('Sales.Order')) }, sourceRevision: knownRevisionId(id(20)), label: '注文' }],
});
const thanks = message(14, bob, 'ありがとう', minute(9), { replyTo: { kind: 'Run', run: knownAgentRunId(id(30)) } });

const done: C.CompletedAgentRun = {
    state: 'Completed',
    id: knownAgentRunId(id(30)),
    session,
    input: { requests: [{ request: own.id, author: ada, targets: own.targets, body: own.body }] },
    queuedBy: ada,
    queuedAt: minute(5),
    baseRevision: knownRevisionId(id(21)),
    startedAt: minute(6),
    report: { exitCode: 0, formatted: 'Ran', checked: 'Ran', newDtErrors: tally(0), unparsedDtes: tally(0) },
    resultRevision: knownRevisionId(id(22)),
    changed: true,
    reply: {
        title: text('ID を追加'),
        summary: text('Order に ID を足しました。'),
        requests: [{ request: own.id, status: 'Done' }],
        questions: [],
        assumptions: [
            { text: text('ID は UUID'), requests: [own.id], alternatives: [] },
            { text: text('名前は OrderId'), requests: [own.id], alternatives: [] },
        ],
    },
    finishedAt: minute(7),
};
const queued: C.QueuedAgentRun = {
    state: 'Queued',
    id: knownAgentRunId(id(31)),
    session,
    input: { requests: [{ request: wish.id, author: bob, targets: [], body: wish.body }] },
    queuedBy: ada,
    queuedAt: minute(10),
};
const proposal: C.ApprovedChangeProposal = {
    state: 'Approved',
    id: knownChangeProposalId(id(40)),
    session,
    triage: knownTriageId(id(50)),
    request: wish.id,
    requestedBy: bob,
    content: { what: value(C.makeProposalText('取り消し')), where: value(C.makeProposalText('#Order')), how: value(C.makeProposalText('cancel を足す')) },
    proposedAt: minute(4),
    approvedBy: ada,
    approvedAt: minute(10),
    run: queued.id,
};
const records: TimelineRecords = {
    session: open,
    requests: [asked, answer, wish, own, thanks],
    runs: [done, queued],
    revisions: [
        revision(20, { kind: 'SessionStart', session }, before, minute(0)),
        revision(21, { kind: 'RunBase', run: done.id }, before, minute(6)),
        revision(22, { kind: 'RunResult', run: done.id }, after, minute(7)),
        revision(23, { kind: 'Manual', takenBy: ada }, edited, minute(8)),
    ],
    approvals: [
        {
            state: 'Approved',
            id: value(C.makeAssumptionApprovalId(id(60))),
            session,
            assumption: { run: done.id, assumption: tally(0) },
            approvedBy: ada,
            approvedAt: minute(8),
        },
    ],
    proposals: [proposal],
    triages: [
        {
            state: 'Decided',
            id: knownTriageId(id(51)),
            session,
            request: thanks.id,
            addressedBy: 'Reply',
            addressedByParticipant: bob,
            steps: [],
            openedAt: minute(9),
            kind: 'Consultation',
            decidedBy: 'Model',
            decidedAt: minute(9),
        },
    ],
};

describe('the session so far', () => {
    test('people, the AI’s answers and turns, proposals and outside edits, numbered in time order', () => {
        const entries = timelineEntries(records);
        expect(entries.map((e) => [e.index, e.kind])).toEqual([
            [1, 'message'],
            [2, 'answer'],
            [3, 'message'],
            [4, 'proposal'],
            [5, 'message'],
            [6, 'turn'],
            [7, 'external'],
            [8, 'message'],
            [9, 'proposal'],
        ]);
        const full = entries.map((e) => e.full);
        expect(full[0]).toBe('[#1 2026-11-03 09:01] Bob:\n    @AI 注文を取り消せる？');
        expect(full[1]).toBe('[#2 2026-11-03 09:02] AI answered (replying to #1):\n    確定前だけです。');
        expect(full[3]).toContain('AI proposed a change for #3 (by Bob):\n    what: 取り消し\n    where: #Order\n    how: cancel を足す');
        expect(full[4]).toBe('[#5 2026-11-03 09:05] Ada about 注文:\n    #注文 に ID を足して');
        expect(full[5]).toBe(
            [
                '[#6 2026-11-03 09:07] AI turn on #5: completed, files changed',
                '    title: ID を追加',
                '    summary: Order に ID を足しました。',
                '    changed: sales/order.dt (changed)',
                '    assumption: ID は UUID — approved by the facilitator',
                '    assumption: 名前は OrderId — not decided yet',
            ].join('\n'),
        );
        expect(full[6]).toBe('[#7 2026-11-03 09:08] Files changed outside the session: sales/note.dt (added)');
        expect(full[7]).toContain('Bob (replying to #6):');
        expect(full[8]).toBe('[#9 2026-11-03 09:10] The proposal #4 was approved by Ada (its run is in the queue)');
    });

    test('the elements a turn changed, when measured, rather than its files', () => {
        const entries = timelineEntries({ ...records, elementChanges: new Map([[done.id, ['Sales.Order (changed)']]]) });
        expect(entries[5]?.full).toContain('changed: Sales.Order (changed)');
    });

    test('what is open now: messages waiting for the AI, the queue', () => {
        const soFar = sessionSoFar(records);
        expect(soFar.open).toEqual(["#8 waits for the AI's answer", 'Queued: the AI turn on #3']);
        expect(soFar.last).toBe(9);
        expect(soFar.omitted).toBe(0);
        expect(soFar.text.endsWith("Open now:\n- #8 waits for the AI's answer\n- Queued: the AI turn on #3")).toBe(true);
    });

    test('since an entry: only what came after it, for a warm agent', () => {
        const soFar = sessionSoFar(records, { since: 7 });
        expect(soFar.entries.map((e) => e.index)).toEqual([8, 9]);
        expect(soFar.text.startsWith('Since entry #7:')).toBe(true);
        expect(sessionSoFar(records, { since: 9 }).text).toContain('(nothing new)');
    });

    test('the newest in full, the next ones a line each, the rest counted', () => {
        const many = Array.from({ length: 140 }, (_, i) => message(1000 + i, bob, `message ${i}\nsecond line`, new Date(minute(0).getTime() + i * 1000)));
        const soFar = sessionSoFar({ ...records, requests: many, runs: [], proposals: [], triages: [], revisions: [] });
        expect(soFar.omitted).toBe(10);
        expect(soFar.entries).toHaveLength(130);
        expect(soFar.text.startsWith('(10 earlier entries not shown)')).toBe(true);
        expect(soFar.text).toContain('[#11 2026-11-03 09:00] Bob: message 10 second line');
        expect(soFar.text).toContain('[#111 2026-11-03 09:01] Bob:\n    message 110\n    second line');
        expect(soFar.text).not.toContain('message 9\n');
        const small = sessionSoFar({ ...records, requests: many.slice(0, 5), runs: [], proposals: [], triages: [], revisions: [] }, { full: 2, lines: 1 });
        expect([small.omitted, small.entries.length]).toEqual([2, 3]);
    });

    test('the chat around a message for stage 3: up to it, newest last, within its limits', () => {
        expect(chatWindow(records, wish.id)).toEqual(['Bob: @AI 注文を取り消せる？', 'AI: 確定前だけです。', 'Bob: @AI 取り消しを足して']);
        expect(chatWindow(records, wish.id, { max: 2, chars: 4000 })).toEqual(['AI: 確定前だけです。', 'Bob: @AI 取り消しを足して']);
        expect(chatWindow(records, wish.id, { max: 20, chars: 20 })).toEqual(['Bob: @AI 取り消しを足して']);
        expect(chatWindow(records, knownRequestId(id(999)))).toEqual([]);
    });
});
