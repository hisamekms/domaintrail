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
    DONE,
    guideMarksOf,
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
export {
    approvedInstruction,
    elementReference,
    instructionOf,
    parseElementReference,
    PROPOSAL_LIMITS,
    proposalData,
    proposalJsonSchema,
    readProposal,
    readProposalText,
    recommendedOption,
    type ProposalData,
    type ProposalOptionData,
    type ProposalProblem,
} from './domain/proposals.js';
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
// the `/` commands' interviews and the message templates (the plan's round 4 and round 5)
export {
    awaitedMessage,
    briefData,
    briefLines,
    briefText,
    BRIEF_HEADS,
    journeyBriefText,
    withEditedText,
    type BriefContext,
    type JourneyBriefData,
    commandId,
    interviewerJsonSchema,
    interviewMessages,
    INTERVIEW_COMMANDS,
    INTERVIEW_LIMITS,
    interviewCommandOf,
    isInterviewCommandId,
    isRunning,
    readBrief,
    readBriefText,
    readInterviewerReply,
    runningInterview,
    UI_LANGUAGES,
    type BriefData,
    type BriefLine,
    type InterviewCommandId,
    type InterviewerReply,
    type InterviewProblem,
} from './domain/interviews.js';
// the candidate and answer commands of the `/` list (the plan's "Built-in ES commands, phase 1")
export {
    CANDIDATE_LIMITS,
    candidateData,
    commandJsonSchema,
    isCommandRunning,
    isSlashCommandName,
    NEXT_LIMITS,
    nextAnswerData,
    nextAnswerText,
    readCommandReply,
    SLASH_COMMAND_NAMES,
    SLASH_COMMANDS,
    slashCommandName,
    slashCommandOf,
    slashCommandSpec,
    SUGGESTED_COMMAND_IDS,
    SUGGESTED_COMMANDS,
    suggestedCommandId,
    type CandidateData,
    type CommandProblem,
    type CommandReply,
    type CommandReplyShape,
    type NextAnswerData,
    type NextStepData,
    type SuggestedCommandId,
    type SlashCommandName,
    type SlashCommandSpec,
    type SlashCommandType,
} from './domain/slash-commands.js';
// the guide's map and what is known at once (`/guide`)
export {
    contextDone,
    contextFacts,
    crossContextReferences,
    diagnosticTarget,
    ES_GOALS,
    ES_STEPS,
    esStepDone,
    GUIDE_LIMITS,
    GUIDE_PATTERNS,
    GUIDE_STEP_KEYS,
    esJourneyKey,
    guideData,
    guideFindings,
    guideMap,
    guideMaps,
    guideMarkId,
    guideMarks,
    journeyMap,
    markableGuideMark,
    MAX_JOURNEY_MAPS,
    NO_MARKS,
    ROW_STEPS,
    type EsJourney,
    type GuideMarkKey,
    type GuideMarkReader,
    type GuideMarkStore,
    type ModelJourney,
    guideSnapshot,
    guideStorming,
    guideWorld,
    MARKABLE_STEPS,
    MIN_EVENTS,
    MODEL_PATTERNS,
    modelGoalStep,
    modelStepDone,
    NO_GOAL,
    readGuideGoal,
    SET_GOAL,
    stormingFacts,
    currentJourney,
    ES_LEVELS,
    ES_MARKABLE,
    esJourneyMap,
    goalOf,
    guideJourneyMap,
    journeyMarks,
    markAct,
    PATTERN_SUBJECT,
    patternMarkable,
    placeSteps,
    type StepPlace,
    type ContextFacts,
    type EsGoalLevel,
    type EsStep,
    type GuideGoal,
    type GuideMapInput,
    type GuidePatternPath,
    type GuideWorkspace,
    type StormingFacts,
} from './domain/guide.js';
// the journey file (`domaintrail.journey.json`): its shape, reading and writing it, the acts that change it, its checks
export {
    agentJourneys,
    applyBrief,
    applyJourneyAct,
    defaultJourney,
    EMPTY_JOURNEYS,
    JOURNEY_FILE,
    JOURNEY_ID,
    JOURNEY_LIMITS,
    JOURNEY_SCHEMA_REF,
    JOURNEY_STATES,
    JOURNEY_USES,
    JOURNEY_VERSION,
    journeyDiagnostics,
    journeyIdFor,
    journeyKeys,
    journeyNames,
    journeyOf,
    journeySummaries,
    missingOf,
    readJourney,
    writeJourney,
    type EsJourneyEntry,
    type JourneyAct,
    type JourneyActError,
    type JourneyFile,
    type JourneyFrom,
    type JourneyNames,
    type JourneyProblem,
    type JourneyRead,
    type JourneyRef,
    type JourneyRuleId,
    type JourneyState,
    type JourneySummary,
    type JourneyUse,
    type ModelJourneyEntry,
} from './domain/journey.js';
// dt's note in the interview's thread once a brief is confirmed: what was decided, where the journey is, the next step
export {
    BRIEF_FIELDS,
    changedBriefFields,
    decidedOf,
    journeyNext,
    journeyNote,
    type BriefFieldKey,
    type JourneyDecided,
    type JourneyNext,
    type JourneyNoteInput,
    type JourneyNoteText,
} from './domain/journey-note.js';
export { checkTemplates, TEMPLATE_CONTEXTS, TEMPLATE_LIMITS, type MessageTemplateConfig, type TemplateContext } from './domain/templates.js';
// where the requester was looking when they sent a message
export {
    type InvalidViewedAt,
    type KnownViewNames,
    readViewedAt,
    resolveViewedAt,
    VIEWED_AT_LIMITS,
    viewedAtData,
    type ViewedAtLike,
} from './domain/viewed-at.js';
export { readToolOutcome, succeeded } from './domain/validation.js';
// the IDs from values known to be UUIDs (the ID generator's, input already checked); the generated constructors check
export {
    knownAgentRunId,
    knownAssumptionApprovalId,
    knownChangeProposalId,
    knownInterviewId,
    knownMarkId,
    knownRequestId,
    knownRevisionId,
    knownSessionId,
    knownSlashCommandId,
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
export { journeyFileMarks, journeyKeyOf, readJourneys, updateJourneys, type JourneyUseCases, type JourneyWriteError } from './application/journeys.js';
export { type SlashCommandJob, type SlashCommandStartedResult, type SlashCommandUseCases, type WrongCommandType } from './application/slash-commands.js';
export { type InterviewJob, type InterviewStarted as InterviewStartedResult, type InterviewUseCases } from './application/interviews.js';
export { actorOf, type Actor } from './application/actor.js';
export { createSessionAccess, secretHash, type LinkInvalid, type SessionAccess, type SessionNotOpen } from './application/access.js';
// the join requests of the `link` identity mode: made through the invite link, decided by the facilitator
export {
    createJoinRequests,
    JOIN_REQUEST_TTL_MS,
    JOIN_REQUEST_WINDOW_MS,
    JOIN_REQUESTS_PER_INVITE,
    JOIN_REQUESTS_PER_KEY,
    MAX_PENDING_JOIN_REQUESTS,
    type InviteExhausted,
    type JoinRequest,
    type JoinRequestNotFound,
    type JoinRequests,
    type JoinRequestState,
    type JoinRequestStatus,
    type RateLimited,
    type TooManyPending,
} from './application/join-requests.js';
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
// stage 2 of the triage (ADR 0030): Clef's step for a message addressed to the AI
export { CLEF_NOT_CONFIGURED, clefStep, type MessageClassifier } from './application/classifier.js';
export { createRunActivities, RUN_ENDING_EVENTS, type RunActivities } from './application/activities.js';
// its settings in domaintrail.jsonc (`collab`, `classifier`, `agent.run.maxPreviousRunDiff`), composed by the app
export {
    ACCESS_CHECKS,
    COLLABORATION_CONFIG_KEYS,
    isHttpsOrigin,
    resolveCollaborationConfig,
    validateAccessNeeded,
    validateClassifierConfig,
    validateCollaborationConfig,
    validateIdentityConfig,
    validateLinkConfig,
    validatePreviousRunsConfig,
    validateTemplatesConfig,
    type ClassifierConfigFile,
    type ClefModel,
    type CollabConfigFile,
    type CollaborationConfigFile,
    type ResolvedCollaborationConfig,
} from './application/config.js';
export {
    type Clock,
    type CollaborationDeps,
    type JourneyFileStore,
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
export { readServerAddress, removeSessionFiles, writeServerAddress, type AgentCredential, type ServerAddress } from './infrastructure/session-files.js';
export { cleanMovedDatabase, createUnitOfWork, CREDENTIAL_TABLES, openSessionDatabase } from './infrastructure/sqlite.js';
export { randomIds, randomSecrets, systemClock } from './infrastructure/system.js';
