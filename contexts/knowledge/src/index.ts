// The public surface of @domaintrail/knowledge (the `.` export; ADR 0027, Dependency rules): Knowledge's published
// language (its generated contracts and the decisions over them), the port its adapters implement (ADR 0031), its
// settings in domaintrail.jsonc, and the session's extraction (its use case, its timing and guards, its checkpoint).

// ---- published language: the generated contracts (model/*.dt) --------------------------------------------------
export { Knowledge, err, ok, type Result } from './generated/index.js';

// ---- published language: the commands of an item, an extraction's operations, what an item leaves behind --------
export { FIRST_VERSION, knowledgeItemCommands, newSourcesOf, nextVersion, raisedOrigin, rewritesInPlace, withLiveConflicts } from './domain/items.js';
export {
    applyExtraction,
    candidateOf,
    idempotencyKey,
    itemsTouched,
    proposalsTouched,
    type AppliedOperation,
    type ProposalChange,
    type ProposalLookup,
    type DroppedOperation,
    type DropReason,
    type ExtractionOutcome,
    type ItemChange,
    type ItemLookup,
} from './domain/extraction.js';
export {
    auditOf,
    auditOfProposal,
    imagesIn,
    pastVersionOf,
    proposerActor,
    redactionOf,
    sourceMessages,
    withoutReason,
    type PastVersion,
} from './domain/records.js';
export {
    admitProposal,
    decideApproval,
    decideDismissal,
    evidenceKey,
    isMoot,
    isRetired,
    openProposals,
    proposalIdOf,
    ProposalIdCollision,
    proposalsToForget,
    retirementProposalCommands,
    type Admitted,
    type Approval,
    type ApprovalError,
    type ProposalContext,
    type ProposalRejection,
    type RetirementCandidate,
} from './domain/retirement.js';

// ---- the extraction (ADR 0031, section 3): the extractor's input and reply, the guards, the timing -----------------
export {
    EXTRACTION_EVENT_TYPES,
    EXTRACTION_LIMITS,
    extractedItemId,
    extractorJsonSchema,
    KNOWLEDGE_KINDS,
    KNOWLEDGE_ORIGINS,
    KNOWLEDGE_WHENS,
    operationsOf,
    readExtractorReply,
    readUsage,
    type ExtractedOperations,
    type ExtractionInput,
    type ExtractionJobBody,
    type ExtractionResultBody,
    HOTSPOT_NAME_MAX,
    HOTSPOT_TAKEN_MAX,
    hotspotNameJsonSchema,
    type HotspotNameInput,
    type ExtractionUsage,
    type ExtractorReply,
    type KnownItem,
    type KnownSticky,
    type ReplyFinding,
    type ReplyOperation,
    type ReplyProblem,
    type ReplySource,
    type TalkMessage,
} from './domain/extractor.js';
export {
    gateGoesOn,
    gateJsonSchema,
    GATE_VERDICTS,
    mechanicalStage,
    readGateReply,
    type GateInput,
    type GateReading,
    type GateVerdict,
    type MechanicalOutcome,
    type StageMessage,
} from './domain/stages.js';
export {
    droppedOutcome,
    guardExtraction,
    nextSettleAt,
    sameCall,
    settled,
    settleHeld,
    type GuardDecision,
    type GuardInput,
    type HeldKind,
    type HeldOperation,
    type HeldOutcome,
} from './domain/guards.js';
export {
    chooseStickies,
    MAX_WORKSPACE_STICKIES,
    mentionedStickies,
    type ChosenStickies,
    type StickyBasis,
    type StickyFocus,
    type StormingStickies,
    type WorkspaceSticky,
} from './domain/stickies.js';
export { decideExtraction, type ExtractionTiming, type ExtractionTrigger, type TalkState, type TimingDecision } from './domain/timing.js';

// ---- the store's port, and who may use it ------------------------------------------------------------------------
export type {
    AppliedExtraction,
    ApprovedProposal,
    AuditQuery,
    Deletion,
    ItemWithHistory,
    KnowledgeImage,
    KnowledgeQuery,
    KnowledgeStore,
    MissingStickies,
    Page,
    PublishedEntry,
    PublishedLevel,
    PublishedSticky,
    PublishedStorming,
    PublishResult,
    RedactionEntry,
    RetiredFilter,
    RetireError,
    RetirementInput,
    StickyCount,
    StormingPublisher,
} from './application/ports.js';
export { PUBLISHED_LEVELS } from './application/ports.js';
export { authorize, type KnowledgeAction } from './application/authorize.js';
export {
    costLine,
    createSessionExtraction,
    EMPTY_CHECKPOINT,
    extractionInput,
    gateInput,
    messagesSince,
    type ExtractionCheckpoint,
    type ExtractionCheckpoints,
    type ExtractionCost,
    type ExtractionRunOutcome,
    type ExtractionStage,
    type Extractor,
    type ExtractorAnswer,
    type GateCost,
    type SessionExtraction,
    type SessionExtractionDeps,
    type SessionMessage,
    type SessionTalk,
} from './application/extraction.js';
export { createRedactionSync, type RedactionCursors, type RedactionSync, type RedactionSyncDeps } from './application/redaction-sync.js';
export { createExtractionScheduler, type ExtractionScheduler, type ExtractionSchedulerDeps, type Timers } from './application/extraction-scheduler.js';
export { loadExtractionSwitch, type ExtractionSwitch, type ExtractionSwitches } from './application/extraction-switch.js';
export {
    CLEARED_KEPT_MS,
    createHotspotHandOvers,
    hotspotOf,
    type ClearedHandOver,
    type ClearedReason,
    type HotspotHandOvers,
    type HotspotHandOversDeps,
    type PendingHandOver,
    type PendingHandOvers,
    type RequestOutcome,
    type Settled,
} from './application/hotspot-handovers.js';
// the checkpoint, the switch, the redaction cursors and the waiting hotspot presses in the session database (adapters, wired by the app)
export { CHECKPOINT_SCHEMA, createSqliteCheckpoints, extractionCosts, forgetHeldQuotes } from './infrastructure/sqlite-checkpoints.js';
export { createSqliteExtractionSwitches, EXTRACTION_SWITCH_SCHEMA } from './infrastructure/sqlite-extraction-switch.js';
export { createSqliteRedactionCursors, REDACTION_CURSOR_SCHEMA } from './infrastructure/sqlite-redaction-cursors.js';
export { createSqliteHotspotHandOvers, HOTSPOT_HANDOVERS_SCHEMA } from './infrastructure/sqlite-hotspot-handovers.js';

// ---- its settings in domaintrail.jsonc (the `knowledge` section), and the store's credentials from the environment --
export {
    ACCESS_SERVICE_TOKEN_HEADERS,
    DEFAULT_EXTRACTION,
    DEFAULT_KNOWLEDGE_STORE,
    isStoreUrl,
    KNOWLEDGE_CLIENT_ID_ENV,
    KNOWLEDGE_CLIENT_SECRET_ENV,
    KNOWLEDGE_CONFIG_KEYS,
    KNOWLEDGE_STORES,
    knowledgeCredentials,
    missingCredentialsMessage,
    projectFromDirName,
    resolveKnowledgeConfig,
    validateKnowledgeConfig,
    type ExtractionConfigFile,
    type KnowledgeConfigFile,
    type KnowledgeCredentials,
    type KnowledgeStoreKind,
    type MissingKnowledgeCredentials,
    type ResolvedExtractionConfig,
    type ResolvedKnowledgeConfig,
} from './application/config.js';

// ---- the items' files and `dt check` on them -------------------------------------------------------------------
export { IMAGES_DIR, KNOWLEDGE_DIR, printItemFile, readItemFile, type FileProblem, type ItemFile } from './domain/item-file.js';
export { knowledgeDiagnostics, type KnowledgeFile, type KnowledgeNames, type KnowledgeRuleId } from './domain/check.js';

// ---- infrastructure, for the app that wires it -----------------------------------------------------------------
export {
    createFilesKnowledgeStore,
    DEFAULT_UNDO_WINDOW_MS,
    readKnowledgeFiles,
    type FilesKnowledgeStore,
    type FilesKnowledgeStoreOptions,
} from './infrastructure/files.js';
export {
    cloudflareKnowledgeStore,
    KnowledgeStoreError,
    type AccessServiceToken,
    type CloudflareKnowledgeStore,
    type CloudflareKnowledgeStoreSettings,
} from './infrastructure/cloudflare.js';
