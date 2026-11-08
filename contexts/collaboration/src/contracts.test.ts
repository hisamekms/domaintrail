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
import { oneRecommended, proposalCommands } from './domain/proposals.js';
import { inCascadeOrder, triageCommands } from './domain/triage.js';
import { isNormalEmoji } from './domain/emoji.js';
import { knownAgentRunId, knownChangeProposalId, knownRequestId, knownRevisionId, knownSessionId, knownTriageId } from './domain/ids.js';

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(`invalid example: ${JSON.stringify(r.error)}`);
    return r.value;
};

/** The defaults, without the given arbitraries and declared checks: the building blocks of those given below. */
const base = Contract.arbitraries();

const success: C.RunReport = { exitCode: 0, formatted: 'Ran', checked: 'Ran', newDtErrors: tally(0), unparsedDtes: tally(0) };
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
        mode: base.SessionMode,
    })
    .map(({ id, startedAt, facilitator, others, mode }) => ({
        state: 'Open' as const,
        id,
        startedAt,
        mode,
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

/** A triage of the request, pending after stage 1, and decided: the outcomes the random inputs rarely reach. */
const pendingTriage: C.PendingTriage = {
    state: 'Pending',
    id: knownTriageId('6f0b0b1e-1f0a-4c3e-9a4e-000000000007'),
    session,
    request,
    addressedBy: 'Mention',
    addressedByParticipant: facilitator,
    steps: [{ stage: 'Mechanical', verdict: 'Unknown', durationMs: value(C.makeMilliseconds(0)), at }],
    openedAt: at,
};
const step = (stage: C.TriageStage, verdict: C.TriageVerdict): C.TriageStep => ({ stage, verdict, durationMs: value(C.makeMilliseconds(12)), at });
const decidedTriage = (kind: C.TriageVerdict): C.DecidedTriage => ({ ...pendingTriage, state: 'Decided', kind, decidedBy: 'Model', decidedAt: at });
const order: C.ModelTarget = { kind: 'DtElement', element: value(C.makeElementName('Sales.Order')) };
const proposalContent: C.ProposalContent = {
    targets: [order],
    how: value(C.makeProposalText('Add cancel from Confirmed to Cancelled.')),
    options: [],
};
const openProposal: C.OpenChangeProposal = {
    state: 'Open',
    id: knownChangeProposalId('6f0b0b1e-1f0a-4c3e-9a4e-000000000008'),
    session,
    triage: pendingTriage.id,
    request,
    requestedBy: facilitator,
    content: proposalContent,
    proposedAt: at,
};
const label = (l: string): C.ProposalLabel => value(C.makeProposalLabel(l));
const optionsProposal: C.OpenChangeProposal = {
    ...openProposal,
    content: {
        ...proposalContent,
        options: [
            { label: label('The aggregate only'), targets: [order], recommended: true },
            { label: label('Its stickies too'), targets: [order], how: value(C.makeProposalText('Rename the sticky too.')), recommended: false },
        ],
    },
};

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
                TriageId: C.makeTriageId,
                ChangeProposalId: C.makeChangeProposalId,
                ProposalText: C.makeProposalText,
                ProposalLabel: C.makeProposalLabel,
                ProposalOptionIndex: C.makeProposalOptionIndex,
                Confidence: C.makeConfidence,
                Milliseconds: C.makeMilliseconds,
            },
            Session: sessionCommands,
            Request: requestCommands,
            AgentRun: agentRunCommands,
            Revision: revisionCommands,
            Mark: markCommands,
            AssumptionApproval: approvalCommands,
            Triage: triageCommands,
            ChangeProposal: proposalCommands,
        },
        {
            // `serial` is the run queue's (one running run per session, a unique index of the store): not a property of one run
            declared: {
                Collaboration: {
                    Emoji: { singleEmoji: isNormalEmoji },
                    ProposalContent: { oneRecommended },
                    Revision: declaredChecks.Revision,
                    TakeRevision: { hashMatchesFiles: ({ contentHash, files: fs }) => snapshotHash(fs) === contentHash },
                    RestoreRevision: { hashMatchesFiles: ({ contentHash, files: fs }) => snapshotHash(fs) === contentHash },
                    // `onePerRequest` is the store's (a unique index): not a property of one triage
                    RecordTriage: { inOrder: (triage, { step }) => inCascadeOrder(triage.steps, step.stage) },
                },
            },
            arbitraries: {
                Collaboration: {
                    // random strings are rarely one emoji: a few of every shape (text presentation, ZWJ, skin tone, flag, keycap)
                    Emoji: fc.constantFrom(...['👍', '❤️', '👨‍👩‍👧‍👦', '👍🏽', '🇯🇵', '1️⃣', '🏳️‍🌈'].map((e) => value(makeEmoji(e)))),
                    CompletedAgentRun,
                    OpenSession,
                    RecordedRevision: hashed(base.RecordedRevision),
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
                            // a run that changed nothing may skip dt fmt / dt check; one that changed files may not (ADR 0030)
                            [
                                running,
                                { report: { ...success, formatted: 'Skipped', checked: 'Skipped' }, resultRevision: revision, changed: false, finishedAt: at },
                            ],
                            [
                                running,
                                {
                                    report: { ...success, formatted: 'Skipped', checked: 'Skipped' },
                                    resultRevision: knownRevisionId('6f0b0b1e-1f0a-4c3e-9a4e-000000000005'),
                                    changed: true,
                                    finishedAt: at,
                                },
                            ],
                        ],
                        askClarification: [
                            [running, { question: value(C.makeText('Which orders?')), reply: asking, resultRevision: revision, finishedAt: at }],
                        ],
                        decline: [[running, { reply, resultRevision: revision, finishedAt: at }]],
                    },
                },
                Triage: {
                    commands: {
                        record: [
                            [pendingTriage, { step: step('Clef', 'Unknown'), recordedAt: at }],
                            [pendingTriage, { step: step('Model', 'ChangeRequest'), recordedAt: at }],
                            [pendingTriage, { step: step('Model', 'Unknown'), recordedAt: at }],
                            [pendingTriage, { step: step('Mechanical', 'NotForAi'), recordedAt: at }],
                        ],
                        override: [
                            [decidedTriage('Consultation'), { step: step('Answerer', 'ChangeRequest'), overriddenAt: at }],
                            [decidedTriage('ChangeRequest'), { step: step('Runner', 'Consultation'), overriddenAt: at }],
                        ],
                        readdress: [[decidedTriage('NotForAi'), { by: facilitator, byRole: 'Facilitator', readdressedAt: at }]],
                        conclude: [[decidedTriage('ChangeRequest'), { to: { kind: 'Run', run: running.id }, concludedAt: at }]],
                    },
                },
                ChangeProposal: {
                    commands: {
                        approve: [
                            [
                                openProposal,
                                {
                                    approvedBy: facilitator,
                                    approvedByRole: 'Facilitator',
                                    option: undefined,
                                    editedHow: value(C.makeProposalText('Add cancel from Placed only.')),
                                    run: running.id,
                                    approvedAt: at,
                                },
                            ],
                            [
                                optionsProposal,
                                {
                                    approvedBy: facilitator,
                                    approvedByRole: 'Facilitator',
                                    option: value(C.makeProposalOptionIndex(1)),
                                    editedHow: undefined,
                                    run: running.id,
                                    approvedAt: at,
                                },
                            ],
                        ],
                        reject: [
                            [openProposal, { rejectedBy: facilitator, rejectedByRole: 'Facilitator', note: value(C.makeText('Not now.')), rejectedAt: at }],
                        ],
                        withdraw: [[openProposal, { withdrawnBy: facilitator, withdrawnAt: at }]],
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
