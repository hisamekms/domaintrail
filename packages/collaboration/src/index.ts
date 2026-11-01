// The public surface of @domaintrail/collaboration (the `.` export; ADR 0027, Dependency rules): Collaboration's
// published language (its generated contracts and the domain modules the agent and the page share), its use cases and
// ports, and the infrastructure an app wires. Its wire types are `./protocol`.

// ---- published language: the generated contracts (model/*.dt) --------------------------------------------------
export { Collaboration, err, ok, type Result } from './generated/index.js';

// ---- published language: a message's body, the agent's reply, marks, targets -----------------------------------
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
export { MAX_REQUEST_TARGETS, type TargetStatus } from './domain/targets.js';
export { previousRunIds } from './domain/previous-runs.js';

// ---- application: the use cases, the actor, access and identity, the classifier, the ports ----------------------
export { createCollaboration, type CollaborationUseCases, type SessionState } from './application/use-cases.js';
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
export { type Clock, type CollaborationDeps, type OutboxEntry, type SignIn, type Stores } from './application/ports.js';

// ---- infrastructure, for the app that wires it -----------------------------------------------------------------
export { openSessionBlobs } from './infrastructure/blobs.js';
export { createClefClassifier } from './infrastructure/clef.js';
export { createCloudflareAccess, type AccessAdapterOptions, type AccessTokenVerifier } from './infrastructure/identity.js';
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
export { createUnitOfWork, openDatabase, openSessionDatabase } from './infrastructure/sqlite.js';
export { randomIds, randomSecrets, systemClock } from './infrastructure/system.js';
export { createModelValidator } from './infrastructure/validator.js';
