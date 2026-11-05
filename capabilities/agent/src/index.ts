// The public surface of @domaintrail/agent (the `.` export; ADR 0027, Dependency rules): the agent's roles (ADR 0030,
// decision 6; ADR 0031, section 3) — the runner (`startSubscriber`: the session's runs), the answerer (`startAnswerer`:
// stage 3 of the triage, answers, proposals) and the extractor (`startExtractor`: knowledge from the talk) — their
// ports, and the adapters an app wires. `dt agent --role answer|run` and the in-process agent start one or both; the
// extractor goes with the answerer (read-only, both).

// ---- core: the roles and their ports ---------------------------------------------------------------------------
export { startSubscriber, type Subscriber, type SubscriberEnd, type SubscriberOptions } from './core/subscriber.js';
export { startAnswerer, type Answerer, type AnswererDeps, type AnswererEnd, type AnswererOptions } from './core/answerer.js';
export { buildAnswerPrompt, buildProposePrompt, buildTriagePrompt, type DiagnosticsScope } from './core/answer-prompt.js';
export { startExtractor, type Extractor, type ExtractorDeps, type ExtractorEnd, type ExtractorOptions } from './core/extractor.js';
export { buildExtractionPrompt, extractorInstructions } from './core/extract-prompt.js';
// the ways of working the prompts give, which the app takes from the guide it embeds
export type { Practice } from './core/prompt.js';
export {
    type AgentApi,
    type AgentInvocation,
    type AgentOutcome,
    type AgentRunner,
    type AnswerAgent,
    type AnswerStreamItem,
    type AnswerTurn,
    type AnswerTurnResult,
    type ExtractAgent,
    type ExtractionApi,
    type ExtractionStreamItem,
    ReadScopeTooLarge,
    type StreamItem,
    type WorkspaceFiles,
} from './core/ports.js';
export { AGENT_ROLES, type AgentRole } from '@domaintrail/collaboration/protocol';

// ---- adapters, for the app that wires them ---------------------------------------------------------------------
export {
    caseless,
    claudeArguments,
    CONFIG_EDIT_DENIED,
    CONFIG_FILE_NAMES,
    DT_WRITTEN_FILE_NAMES,
    createClaudeCodeRunner,
    extraReadRules,
    type AgentCommand,
    type ExtraRead,
    type RunnerReadScope,
    UnexpressiblePath,
} from './adapters/claude-code.js';
export { createWarmClaudeRunner, type WarmRunnerOptions } from './adapters/claude-warm.js';
export { checkClaudeCode, type ClaudeUsability } from './adapters/claude-usable.js';
export { userClaudeDefaults } from './adapters/claude-settings.js';
export {
    createWorkspaceView,
    foldedName,
    holdsRepository,
    ignoredEntries,
    type IgnoredSource,
    MAX_IGNORED_ENTRIES,
    TooManyDeniedEntries,
    type WorkspaceView,
    type WorkspaceViewOptions,
} from './adapters/workspace-view.js';
// what the AI reads outside the workspace (`agent.read.paths`): the configuration's check, and the paths as they are
export { checkReadPaths, checkTarget, readPathError, readTargets, type ReadTarget, shownReadPath } from './adapters/read-paths.js';
// the answerer role's Claude Code: stage 3 with no tools, answers and proposals with the reading tools only
export { ANSWERER_TOOLS, answererArguments, createClaudeAnswerer, triageArguments, type ClaudeAnswererOptions } from './adapters/claude-answer.js';
// the warm process itself, for a role other than the runs (its own tools, prompt and schema)
// the extractor's Claude Code: no tools at all, the extractor's schema and instructions, a fresh process each
export { createClaudeExtractor, extractorArguments, type ClaudeExtractorOptions } from './adapters/claude-extract.js';
export { createWarmClaude, type WarmClaude, type WarmClaudeOptions, type WarmProfile, type WarmTurn, type WarmTurnEnd } from './adapters/warm-claude.js';
export { checkDtOutsideWorkspace, dtCommandOf, pinDt, type PinnedDt } from './adapters/dt-shim.js';
// the adapters' settings in domaintrail.jsonc, `agent.run` (the runner: tools, `dt`, the warm agent), `agent.answer`
// (the answerer) and `agent.triage` (stage 3), composed by the app
export {
    AGENT_CONFIG_KEYS,
    AGENT_EFFORTS,
    type AgentEffort,
    ANSWER_CONFIG_KEYS,
    type AnswerConfig,
    type AnswerConfigFile,
    DEFAULT_AGENT_TOOLS,
    DEFAULT_ANSWER_RESTART_AFTER,
    DEFAULT_ANSWER_TIMEOUT,
    DEFAULT_IDLE_TIMEOUT,
    DEFAULT_RESTART_AFTER,
    DEFAULT_TRIAGE_MODEL,
    DEFAULT_EXTRACT_TIMEOUT,
    EXTRACT_CONFIG_KEYS,
    type ExtractConfig,
    type ExtractConfigFile,
    resolveExtractConfig,
    validateExtractConfig,
    type ReadConfigFile,
    type ReadPaths,
    READ_CONFIG_KEYS,
    type ResolvedRunConfig,
    resolveReadPath,
    resolveReadPaths,
    type RunConfig,
    resolveAnswerConfig,
    resolveTriageConfig,
    TRIAGE_CONFIG_KEYS,
    type TriageConfig,
    type TriageConfigFile,
    resolveAgentConfig,
    validateAgentConfig,
    validateAnswerConfig,
    validateTriageConfig,
    validateReadConfig,
    type AgentConfigFile,
    type ResolvedAgentConfig,
} from './adapters/config.js';
export { createDtTools, type DtCommand } from './adapters/dt-tools.js';
export { createHttpAgentApi } from './adapters/http-agent-api.js';
export { randomNonce, systemClock } from './adapters/system.js';
export { scanWorkspace } from './adapters/workspace-scan.js';
