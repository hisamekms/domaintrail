// The public surface of @domaintrail/presentation (the `.` export; ADR 0027, Dependency rules): the entry points the
// composition wires — the CLI, the language server, the Live View's HTTP and WebSocket servers, the session's routes.
// Presentation and composition merge into one app, apps/dt, in T8.

// ---- the CLI ---------------------------------------------------------------------------------------------------
export { consoleIO, runCli, type CliIO } from './cli/main.js';
export { SessionError, type CliDeps } from './cli/ports.js';

// ---- the language server (loaded only by `dt lsp`) -------------------------------------------------------------
export { startLanguageServer } from './lsp/start.js';
export type { LanguageServerFiles, LanguageServerOptions } from './lsp/server.js';

// ---- the Live View's HTTP and WebSocket servers ----------------------------------------------------------------
export { isLoopbackBind, sessionHostPolicy } from './http/access.js';
export { defaultWebDir, loadAssets, type Assets } from './http/assets.js';
export { createApiRoutes } from './http/routes.js';
export { createViewHttpServer } from './http/server.js';
export { createWebSocketHub, type Connection } from './websocket/hub.js';

// ---- the session's routes, identities, presence and events; the agent API --------------------------------------
// `statusOf` maps the use cases' errors to HTTP statuses (the T0 baseline test/session-errors-contract.test.ts pins it)
export { createSessionHttp, meOf, stateBody, statusOf } from './session/routes.js';
export { createSessionIdentities } from './session/identities.js';
export { createPresenceRelay, type SessionConnection } from './session/presence.js';
export { createEventRelay, lastSeq } from './session/relay.js';
export { createAgentApi } from './session/agent.js';
