// The public surface of @domaintrail/knowledge (the `.` export; ADR 0027, Dependency rules): Knowledge's published
// language (its generated contracts and the decisions over them), the port its adapters implement (ADR 0031), its
// settings in domaintrail.jsonc, and the session's extraction (its use case, its timing and guards, its checkpoint).

// ---- published language: the generated contracts (model/*.dt) --------------------------------------------------
export { Knowledge, err, ok, type Result } from './generated/index.js';

// ---- published language: the commands of an item, an extraction's operations, what an item leaves behind --------
export { FIRST_VERSION, knowledgeItemCommands, nextVersion, raisedOrigin, rewritesInPlace } from './domain/items.js';
export {
    applyExtraction,
    idempotencyKey,
    itemsTouched,
    type AppliedOperation,
    type DroppedOperation,
    type DropReason,
    type ExtractionOutcome,
    type ItemChange,
    type ItemLookup,
} from './domain/extraction.js';
export { auditOf, imagesIn, pastVersionOf, redactionOf, sourceMessages, withoutReason, type PastVersion } from './domain/records.js';

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
export { decideExtraction, type ExtractionTiming, type ExtractionTrigger, type TalkState, type TimingDecision } from './domain/timing.js';

// ---- the store's port, and who may use it ------------------------------------------------------------------------
export type {
    AppliedExtraction,
    AuditQuery,
    Deletion,
    ItemWithHistory,
    KnowledgeImage,
    KnowledgeQuery,
    KnowledgeStore,
    Page,
    RedactionEntry,
    StickyCount,
} from './application/ports.js';
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
export { createExtractionScheduler, type ExtractionScheduler, type ExtractionSchedulerDeps, type Timers } from './application/extraction-scheduler.js';
export { loadExtractionSwitch, type ExtractionSwitch, type ExtractionSwitches } from './application/extraction-switch.js';
// the checkpoint and the switch in the session database (adapters, wired by the app)
export { CHECKPOINT_SCHEMA, createSqliteCheckpoints, extractionCosts } from './infrastructure/sqlite-checkpoints.js';
export { createSqliteExtractionSwitches, EXTRACTION_SWITCH_SCHEMA } from './infrastructure/sqlite-extraction-switch.js';

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
export { cloudflareKnowledgeStore, KnowledgeStoreError, type AccessServiceToken, type CloudflareKnowledgeStoreSettings } from './infrastructure/cloudflare.js';
