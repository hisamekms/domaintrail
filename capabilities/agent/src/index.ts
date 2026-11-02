// The public surface of @domaintrail/agent (the `.` export; ADR 0027, Dependency rules): the subscriber that runs the
// session's requests (`dt session subscribe`), its ports, and the adapters an app wires.

// ---- core: the subscriber and its ports ------------------------------------------------------------------------
export { startSubscriber, type Subscriber, type SubscriberEnd, type SubscriberOptions } from './core/subscriber.js';
export { type AgentApi, type AgentInvocation, type AgentOutcome, type AgentRunner, type StreamItem, type WorkspaceFiles } from './core/ports.js';

// ---- adapters, for the app that wires them ---------------------------------------------------------------------
export { createClaudeCodeRunner, type AgentCommand } from './adapters/claude-code.js';
export { createWarmClaudeRunner, type WarmRunnerOptions } from './adapters/claude-warm.js';
export { checkClaudeCode, type ClaudeUsability } from './adapters/claude-usable.js';
// the warm process itself, for a role other than the runs (its own tools, prompt and schema)
export { createWarmClaude, type WarmClaude, type WarmClaudeOptions, type WarmProfile, type WarmTurn, type WarmTurnEnd } from './adapters/warm-claude.js';
export { checkDtOutsideWorkspace, dtCommandOf, pinDt, type PinnedDt } from './adapters/dt-shim.js';
// the adapters' settings in domaintrail.jsonc, `session.agent.allowedTools`, `session.agent.dt` (T6) and
// `session.agent.run` (the warm agent), composed by the app
export {
    AGENT_CONFIG_KEYS,
    AGENT_EFFORTS,
    type AgentEffort,
    DEFAULT_AGENT_TOOLS,
    DEFAULT_RESTART_AFTER,
    type RunConfig,
    resolveAgentConfig,
    validateAgentConfig,
    type AgentConfigFile,
    type ResolvedAgentConfig,
} from './adapters/config.js';
export { createDtTools, type DtCommand } from './adapters/dt-tools.js';
export { createHttpAgentApi } from './adapters/http-agent-api.js';
export { randomNonce, systemClock } from './adapters/system.js';
export { scanWorkspace } from './adapters/workspace-scan.js';
