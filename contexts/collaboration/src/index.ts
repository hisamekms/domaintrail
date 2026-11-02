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
// undoing a run: which runs can be undone, whether one was undone (its assumptions closed), what the agent is told
export { isUndo, MAX_UNDO_DIFF, undoableChanges, undoStatus, type UndoChanges, type UndoFile, type UndoRun, type UndoStatus } from './domain/undo.js';
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
// the IDs from values known to be UUIDs (the ID generator's, input already checked); the generated constructors check
export { knownAgentRunId, knownAssumptionApprovalId, knownMarkId, knownRequestId, knownRevisionId, knownSessionId } from './domain/ids.js';
// the rule of the `Emoji` primitive: what counts as one emoji and the form it is kept in (the page decides alike)
export { DEFAULT_QUICK_REACTIONS, MAX_EMOJI_BYTES, readEmoji } from './domain/emoji.js';

// ---- application: the use cases, the actor, access and identity, the classifier, the ports ----------------------
export {
    createCollaboration,
    UNDO_CAPABILITY,
    type CollaborationUseCases,
    type SessionState,
    type Undone,
    type UndoObstacle,
} from './application/use-cases.js';
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
