// The public surface of @domaintrail/agent (the `.` export; ADR 0027, Dependency rules): the subscriber that runs the
// session's requests (`dt session subscribe`), its ports, and the adapters an app wires (infrastructure/: adapters/
// after T8).

// ---- application: the subscriber and its ports -----------------------------------------------------------------
export { startSubscriber, type Subscriber, type SubscriberEnd, type SubscriberOptions } from './application/subscriber.js';
export { type AgentInvocation, type AgentOutcome, type AgentRunner } from './application/ports.js';

// ---- adapters, for the app that wires them ---------------------------------------------------------------------
export { createClaudeCodeRunner, type AgentCommand } from './infrastructure/claude-code.js';
export { dtCommandOf, pinDt, writeDtShim, type PinnedDt } from './infrastructure/dt-shim.js';
export { createDtTools, type DtCommand } from './infrastructure/dt-tools.js';
export { createHttpAgentApi } from './infrastructure/http-agent-api.js';
export { randomNonce, systemClock } from './infrastructure/system.js';
export { scanWorkspace } from './infrastructure/workspace-scan.js';
