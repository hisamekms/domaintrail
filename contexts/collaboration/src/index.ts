// The public surface of @domaintrail/collaboration (the `.` export; ADR 0027, Dependency rules): Collaboration's
// published language (its generated contracts and the domain modules the agent and the page share), its use cases and
// ports, and the infrastructure an app wires. Its wire types are `./protocol`.

// ---- published language: the generated contracts (model/*.dt) --------------------------------------------------
export { Collaboration, err, ok, type Result } from './generated/index.js';

// ---- published language: a message's body, the agent's reply, marks, approvals, targets -------------------------
export {
    MAX_REQUEST_MENTIONS,
    parseBody,
    peopleAsNames,
    plainBody,
    renumberTokens,
    tokenName,
    tokensIn,
    type BodyCounts,
    type BodySegment,
} from './domain/body.js';
export {
    checkAgentReplyDeep,
    mapRequests,
    plainQuestion,
    readAnswer,
    readReply,
    REPLY_LIMITS,
    REPLY_OUTCOMES,
    replyJsonSchema,
    requestNumber,
    toAgentReply,
    type AnswerData,
    type PickData,
    type ReplyData,
    type ReplyOutcome,
} from './domain/reply.js';
export {
    isVoteTarget,
    laterRunOf,
    makeEmoji,
    MAX_REACTION_EMOJI,
    markKey,
    markTargetStatus,
    signKey,
    VOTE,
    type MarkSignData,
    type MarkStatus,
    type MarkTargetData,
} from './domain/marks.js';
export { approvalOf, assumptionStatus, type ApprovalFacts } from './domain/approvals.js';
// reverting a run: which runs can be reverted, whether one was reverted (its assumptions closed), what the agent is told
export {
    awaitsServer,
    isRevert,
    MAX_REVERT_DIFF,
    revertableChanges,
    revertedRunId,
    revertStatus,
    type RevertChanges,
    type RevertFile,
    type RevertRun,
    type RevertStatus,
} from './domain/revert.js';
// what a running run is doing: the phases any agent maps its own events onto, and the check of an activity
export {
    isActivityPhase,
    isActivitySubject,
    MAX_ACTIVITY_SUBJECT,
    readActivity,
    RUN_ACTIVITY_PHASES,
    sameActivity,
    type RunActivity,
    type RunActivityPhase,
} from './domain/activity.js';
export { MAX_REQUEST_TARGETS, type TargetStatus } from './domain/targets.js';
// who talks to the AI (ADR 0030): the AI as a participant, addressing, the triage's stages, proposals, the answerer's
// output, the session so far, the modes
export { AI_NAME, AI_PARTICIPANT, AI_PARTICIPANT_ID, isAi } from './domain/ai.js';
export {
    ACKNOWLEDGEMENTS,
    addressing,
    answerJobOf,
    CASCADE,
    clefVerdict,
    decisionOf,
    inCascadeOrder,
    mechanicalVerdict,
    modelVerdict,
    nextStage,
    triageRoute,
    TRIAGE_THRESHOLDS,
    type AddressingFacts,
    type ClefProbabilities,
    type MechanicalRule,
    type ModelAnswer,
    type TriageRoute,
} from './domain/triage.js';
export { approvedContent, PROPOSAL_LIMITS, proposalJsonSchema, readProposal, type ProposalData, type ProposalProblem } from './domain/proposals.js';
export {
    answererJsonSchema,
    proposeJsonSchema,
    readAnswererReply,
    readProposeReply,
    readTriageAnswer,
    TRIAGE_KINDS,
    TRIAGE_REASON_LIMIT,
    triageJsonSchema,
    type AnswererReply,
    type TriageAnswer,
    type TriageKindData,
} from './domain/answers.js';
export { chatWindow, sessionSoFar, TIMELINE_LIMITS, timelineEntries, type SessionSoFar, type TimelineEntry, type TimelineRecords } from './domain/timeline.js';
export { sessionOpening, type SessionOpening } from './domain/modes.js';
export { readToolOutcome, succeeded } from './domain/validation.js';
// the IDs from values known to be UUIDs (the ID generator's, input already checked); the generated constructors check
export {
    knownAgentRunId,
    knownAssumptionApprovalId,
    knownChangeProposalId,
    knownMarkId,
    knownRequestId,
    knownRevisionId,
    knownSessionId,
    knownTriageId,
} from './domain/ids.js';
// the rule of the `Emoji` primitive: what counts as one emoji and the form it is kept in (the page decides alike)
export { DEFAULT_QUICK_REACTIONS, MAX_EMOJI_BYTES, readEmoji } from './domain/emoji.js';

// ---- application: the use cases, the actor, access and identity, the classifier, the ports ----------------------
export {
    createCollaboration,
    REVERT_CAPABILITY,
    SERVER_REVERT_OWNER,
    type CollaborationUseCases,
    type SessionState,
    type RevertNextError,
    type RevertObstacle,
    type RevertOutcome,
    type RevertRequested,
} from './application/use-cases.js';
export {
    MAX_TRIAGE_REASON,
    type AnswerJob,
    type AnswerTooLong,
    type ConversationUseCases,
    type InvalidTriageInput,
    type MessageSent,
    type ProposalsApproved,
    type SessionOpened,
    type TriageProgress,
    type TriageStepInput,
} from './application/conversation.js';
export { actorOf, type Actor } from './application/actor.js';
export { createSessionAccess, secretHash, type LinkInvalid, type SessionAccess } from './application/access.js';
export {
    FACILITATOR_NAME,
    FACILITATOR_PARTICIPANT,
    participantOf,
    sameIdentity,
    type Identity,
    type IdentityKey,
    type IdentityMode,
    type IdentityProvider,
} from './application/identity.js';
// the classification of every message for the facilitator's 「AI に送る」 (superseded by the triage's stage 2, ADR 0030):
// kept for today's page until M4/M6 remove it
export { createClassifications, type Classifications, type MessageClassifier } from './application/classifier.js';
export { createRunActivities, RUN_ENDING_EVENTS, type RunActivities } from './application/activities.js';
// its settings in the `session` section of domaintrail.jsonc (T6), composed by the app
export {
    ACCESS_CHECKS,
    COLLABORATION_CONFIG_KEYS,
    resolveCollaborationConfig,
    validateAccessNeeded,
    validateCollaborationConfig,
    validateIdentityConfig,
    validatePreviousRunsConfig,
    type ClefModel,
    type CollaborationConfigFile,
    type ResolvedCollaborationConfig,
} from './application/config.js';
export {
    type Clock,
    type CollaborationDeps,
    type ModelValidator,
    type OutboxEntry,
    type SignIn,
    type SourceFormatter,
    type Stores,
} from './application/ports.js';

// ---- infrastructure, for the app that wires it -----------------------------------------------------------------
export { openSessionBlobs } from './infrastructure/blobs.js';
export { createClefClassifier } from './infrastructure/clef.js';
export { createCloudflareAccess, type AccessAdapterOptions, type AccessClaims, type AccessTokenVerifier } from './infrastructure/identity.js';
export { SESSION_DIR } from './infrastructure/session-dir.js';
export {
    AGENT_FILE,
    readAgentCredential,
    readServerAddress,
    removeSessionFiles,
    writeAgentCredential,
    writeServerAddress,
    type AgentCredential,
} from './infrastructure/session-files.js';
export { createUnitOfWork, openSessionDatabase } from './infrastructure/sqlite.js';
export { randomIds, randomSecrets, systemClock } from './infrastructure/system.js';
