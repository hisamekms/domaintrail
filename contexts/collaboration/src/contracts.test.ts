// Runs the contract tests generated from the collaboration model (contexts/collaboration/src/generated/tests) against
// the hand-written commands of contexts/collaboration/src/domain, registered with bun:test like examples/shop's
// contract.test.ts. The generated arbitraries cannot make every state on their own: a completed run must meet the run
// success rule and a revision's content hash must be the one its files give, so those are given here, with examples
// that reach the successful outcomes the random inputs rarely meet (a frozen input that covers its requests, a content
// hash that matches its files, a changed flag that agrees with the result revision).
import * as fc from 'fast-check';
import { Collaboration as C } from './generated/index.js';
import { Collaboration as Contract, register } from './generated/tests/index.js';
import { agentRunCommands, declaredChecks, requestCommands, revisionCommands, sessionCommands } from './domain/commands.js';
import { hashBytes, snapshotFile, snapshotHash } from './domain/snapshot.js';
import { tally } from './domain/validation.js';
import { makeEmoji, markCommands } from './domain/marks.js';
import { approvalCommands } from './domain/approvals.js';
import { isNormalEmoji } from './domain/emoji.js';
import { knownAgentRunId, knownRequestId, knownRevisionId, knownSessionId } from './domain/ids.js';

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(`invalid example: ${JSON.stringify(r.error)}`);
    return r.value;
};

/** The defaults, without the given arbitraries and declared checks: the building blocks of those given below. */
const base = Contract.arbitraries();

const success: C.RunReport = { exitCode: 0, formatted: true, checked: true, newDtErrors: tally(0), unparsedDtes: tally(0) };
const at = new Date('2026-10-31T09:00:00Z');

/** A completed run meets the run success rule, and its result is its base exactly when nothing changed. */
const CompletedAgentRun: fc.Arbitrary<C.CompletedAgentRun> = fc
    .record({ run: base.RunningAgentRun, result: base.RevisionId, changed: fc.boolean(), finishedAt: fc.date({ noInvalidDate: true }) })
    .filter(({ run, result, changed }) => !changed || result !== run.baseRevision)
    .map(({ run, result, changed, finishedAt }) => ({
        ...run,
        state: 'Completed',
        report: success,
        resultRevision: changed ? result : run.baseRevision,
        changed,
        finishedAt,
    }));

/** An open session lists its facilitator once, as the only one with that role, and every participant once. */
const OpenSession: fc.Arbitrary<C.OpenSession> = fc
    .record({
        id: base.SessionId,
        startedAt: fc.date({ noInvalidDate: true }),
        facilitator: base.Participant,
        others: fc.uniqueArray(base.Participant, { selector: (p) => p.id, maxLength: 4 }),
    })
    .map(({ id, startedAt, facilitator, others }) => ({
        state: 'Open' as const,
        id,
        startedAt,
        facilitator: facilitator.id,
        participants: [
            { ...facilitator, role: 'Facilitator' as const },
            ...others.filter((p) => p.id !== facilitator.id).map((p) => ({ ...p, role: 'Participant' as const })),
        ],
    }));

/** A revision's content hash is the one its files give. */
const hashed = <R extends C.Revision>(arb: fc.Arbitrary<R>): fc.Arbitrary<R> => arb.map((r) => ({ ...r, contentHash: snapshotHash(r.files) }));

const session = knownSessionId('6f0b0b1e-1f0a-4c3e-9a4e-000000000001');
const facilitator = value(C.makeParticipantId('facilitator'));
const request = knownRequestId('6f0b0b1e-1f0a-4c3e-9a4e-000000000002');
const revision = knownRevisionId('6f0b0b1e-1f0a-4c3e-9a4e-000000000003');
const files = [
    snapshotFile(value(C.makeWorkspacePath('sales/order.dt')), new TextEncoder().encode('context Sales {}\n')),
    snapshotFile(value(C.makeWorkspacePath('stormings/order.dtes')), new TextEncoder().encode('storming Order {}\n')),
];
const validation: C.ValidationSummary = { dtErrors: tally(0), dtesErrors: tally(0), dtesWarnings: tally(0), linkWarnings: tally(0), stale: false };
const frozen: C.FrozenRequest = {
    request,
    author: facilitator,
    targets: [],
    body: value(C.makeText('Add a cancel command to the order.')),
};
const running: C.RunningAgentRun = {
    state: 'Running',
    id: knownAgentRunId('6f0b0b1e-1f0a-4c3e-9a4e-000000000004'),
    session,
    input: { requests: [frozen] },
    queuedBy: facilitator,
    queuedAt: at,
    baseRevision: revision,
    startedAt: at,
};
/** A reply about the run's request: done, and the same asking a question (a clarification's). */
const reply: C.AgentReply = {
    summary: value(C.makeText('Added cancel.')),
    requests: [{ request, status: 'Done' }],
    questions: [],
    assumptions: [{ text: value(C.makeText('Only an open order can be cancelled.')), requests: [request], alternatives: [] }],
};
const asking: C.AgentReply = {
    ...reply,
    requests: [{ request, status: 'Question' }],
    questions: [
        {
            id: value(C.makeReplyKey('q1')),
            text: value(C.makeText('Which orders can be cancelled?')),
            requests: [request],
            options: [{ id: value(C.makeReplyKey('open')), label: value(C.makeText('Open ones')) }],
            multiple: false,
        },
    ],
};
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the examples stand in for what the verified types' factories check
const pending = request as C.PendingRequest;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the examples stand in for what the verified types' factories check
const active = session as C.ActiveSession;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the examples stand in for what the verified types' factories check
const restorable = revision as C.RestorableRevision;

register(
    Contract.contract(
        {
            make: {
                AgentRunId: C.makeAgentRunId,
                Text: C.makeText,
                LineNumber: C.makeLineNumber,
                ColumnNumber: C.makeColumnNumber,
                Tally: C.makeTally,
                ContentHash: C.makeContentHash,
                WorkspacePath: C.makeWorkspacePath,
                RequestId: C.makeRequestId,
                RevisionId: C.makeRevisionId,
                SessionId: C.makeSessionId,
                ParticipantId: C.makeParticipantId,
                DisplayName: C.makeDisplayName,
                ElementName: C.makeElementName,
                StormingName: C.makeStormingName,
                StormingLocalName: C.makeStormingLocalName,
                TimelineName: C.makeTimelineName,
                StormingEventName: C.makeStormingEventName,
                OccurrencePath: C.makeOccurrencePath,
                ReplyKey: C.makeReplyKey,
                MarkId: C.makeMarkId,
                Emoji: makeEmoji,
                AssumptionApprovalId: C.makeAssumptionApprovalId,
            },
            Session: sessionCommands,
            Request: requestCommands,
            AgentRun: agentRunCommands,
            Revision: revisionCommands,
            Mark: markCommands,
            AssumptionApproval: approvalCommands,
        },
        {
            // `serial` is the run queue's (one running run per session, a unique index of the store): not a property of one run
            declared: {
                Collaboration: {
                    Emoji: { singleEmoji: isNormalEmoji },
                    Revision: declaredChecks.Revision,
                    TakeRevision: { hashMatchesFiles: ({ contentHash, files: fs }) => snapshotHash(fs) === contentHash },
                    RestoreRevision: { hashMatchesFiles: ({ contentHash, files: fs }) => snapshotHash(fs) === contentHash },
                },
            },
            arbitraries: {
                Collaboration: {
                    // random strings are rarely one emoji: a few of every shape (text presentation, ZWJ, skin tone, flag, keycap)
                    Emoji: fc.constantFrom(...['👍', '❤️', '👨‍👩‍👧‍👦', '👍🏽', '🇯🇵', '1️⃣', '🏳️‍🌈'].map((e) => value(makeEmoji(e)))),
                    CompletedAgentRun,
                    OpenSession,
                    RecordedRevision: hashed(base.RecordedRevision),
                    ConfirmedRevision: hashed(base.ConfirmedRevision),
                },
            },
            examples: {
                AgentRun: {
                    commands: {
                        queue: [
                            [
                                {
                                    id: running.id,
                                    session: active,
                                    requests: [pending],
                                    input: { requests: [frozen] },
                                    queuedBy: facilitator,
                                    queuedByRole: 'Facilitator',
                                    queuedAt: at,
                                },
                            ],
                        ],
                        finish: [
                            [running, { report: success, resultRevision: revision, changed: false, finishedAt: at }],
                            [
                                running,
                                {
                                    report: success,
                                    resultRevision: knownRevisionId('6f0b0b1e-1f0a-4c3e-9a4e-000000000005'),
                                    changed: true,
                                    reply,
                                    finishedAt: at,
                                },
                            ],
                            [running, { report: { ...success, newDtErrors: tally(1) }, resultRevision: revision, changed: false, reply, finishedAt: at }],
                        ],
                        askClarification: [
                            [running, { question: value(C.makeText('Which orders?')), reply: asking, resultRevision: revision, finishedAt: at }],
                        ],
                        decline: [[running, { reply, resultRevision: revision, finishedAt: at }]],
                    },
                },
                Revision: {
                    commands: {
                        take: [
                            [
                                {
                                    id: revision,
                                    session,
                                    origin: { kind: 'SessionStart', session },
                                    contentHash: snapshotHash(files),
                                    files,
                                    validation,
                                    takenAt: at,
                                },
                            ],
                        ],
                        restore: [
                            [
                                {
                                    id: knownRevisionId('6f0b0b1e-1f0a-4c3e-9a4e-000000000006'),
                                    session,
                                    restoredFrom: restorable,
                                    preRestore: revision,
                                    contentHash: snapshotHash(files),
                                    files,
                                    validation,
                                    restoredByRole: 'Facilitator',
                                    takenAt: at,
                                },
                            ],
                        ],
                    },
                },
            },
        },
    ),
);

// a file's hash is its bytes': the examples above are consistent
if (files[0].hash !== hashBytes(new TextEncoder().encode('context Sales {}\n'))) throw new Error('inconsistent example');
