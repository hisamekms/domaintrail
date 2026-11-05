// The public surface of @domaintrail/knowledge (the `.` export; ADR 0027, Dependency rules): Knowledge's published
// language (its generated contracts and the decisions over them), the port its adapters implement (ADR 0031), and its
// settings in domaintrail.jsonc.

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
