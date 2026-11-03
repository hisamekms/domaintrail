// The public surface of @domaintrail/agent (the `.` export; ADR 0027, Dependency rules): the agent's two roles (ADR
// 0030, decision 6) — the runner (`startSubscriber`: the session's runs) and the answerer (`startAnswerer`: stage 3 of
// the triage, answers, proposals) — their ports, and the adapters an app wires. `dt agent --role answer|run` and the
// in-process agent start one or both.

// ---- core: the roles and their ports ---------------------------------------------------------------------------
export { startSubscriber, type Subscriber, type SubscriberEnd, type SubscriberOptions } from './core/subscriber.js';
export { startAnswerer, type Answerer, type AnswererDeps, type AnswererEnd, type AnswererOptions } from './core/answerer.js';
export { buildAnswerPrompt, buildProposePrompt, buildTriagePrompt } from './core/answer-prompt.js';
export {
    type AgentApi,
    type AgentInvocation,
    type AgentOutcome,
    type AgentRunner,
    type AnswerAgent,
    type AnswerStreamItem,
    type AnswerTurn,
    type AnswerTurnResult,
    ReadScopeTooLarge,
    type StreamItem,
    type WorkspaceFiles,
} from './core/ports.js';
export { AGENT_ROLES, type AgentRole } from '@domaintrail/collaboration/protocol';

// ---- adapters, for the app that wires them ---------------------------------------------------------------------
export { createClaudeCodeRunner, type AgentCommand } from './adapters/claude-code.js';
export { createWarmClaudeRunner, type WarmRunnerOptions } from './adapters/claude-warm.js';
export { checkClaudeCode, type ClaudeUsability } from './adapters/claude-usable.js';
export { userClaudeDefaults } from './adapters/claude-settings.js';
export { createWorkspaceView, ignoredEntries, type IgnoredSource, type WorkspaceView, type WorkspaceViewOptions } from './adapters/workspace-view.js';
// the answerer role's Claude Code: stage 3 with no tools, answers and proposals with the reading tools only
export { ANSWERER_TOOLS, answererArguments, createClaudeAnswerer, triageArguments, type ClaudeAnswererOptions } from './adapters/claude-answer.js';
// the warm process itself, for a role other than the runs (its own tools, prompt and schema)
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
    type ResolvedRunConfig,
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
    type AgentConfigFile,
    type ResolvedAgentConfig,
} from './adapters/config.js';
export { createDtTools, type DtCommand } from './adapters/dt-tools.js';
export { createHttpAgentApi } from './adapters/http-agent-api.js';
export { randomNonce, systemClock } from './adapters/system.js';
export { scanWorkspace } from './adapters/workspace-scan.js';
