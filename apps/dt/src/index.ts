// The public surface of @domaintrail/dt (the `.` export; ADR 0027, Dependency rules): the entry points the
// composition wires — the CLI, the language server, the Live View's HTTP and WebSocket servers, the session's routes.
// Composition merges into it in T8.

// ---- the CLI ---------------------------------------------------------------------------------------------------
export { consoleIO, runCli, type CliIO } from './cli/main.js';
export { SessionError, type CliDeps } from './cli/ports.js';

// ---- the configuration: domaintrail.jsonc composed from its sections' owners (T6) -------------------------------
export {
    checkTsContexts,
    CONFIG_FILE_FORMAT,
    CONFIG_FILES,
    ConfigError,
    defaultConfig,
    resolveConfig,
    type ResolvedConfig,
    type ResolvedSessionConfig,
} from './config/config.js';

// ---- the language server (loaded only by `dt lsp`) -------------------------------------------------------------
export { startLanguageServer } from './lsp/start.js';
export type { LanguageServerFiles, LanguageServerOptions } from './lsp/server.js';

// ---- the Live View's HTTP and WebSocket servers ----------------------------------------------------------------
export { isLoopbackBind, sessionHostPolicy } from './server/http/access.js';
export { defaultWebDir, loadAssets, type Assets } from './server/http/assets.js';
export { createApiRoutes } from './server/http/routes.js';
export { createViewHttpServer } from './server/http/server.js';
export { createWebSocketHub, type Connection } from './server/websocket/hub.js';

// ---- the session's routes, identities, presence and events; the agent API --------------------------------------
// `statusOf` maps the use cases' errors to HTTP statuses (the T0 baseline test/session-errors-contract.test.ts pins it)
export { createSessionHttp, meOf, stateBody, statusOf } from './server/session/routes.js';
export { createSessionIdentities } from './server/session/identities.js';
export { createPresenceRelay, type SessionConnection } from './server/session/presence.js';
export { createEventRelay, lastSeq } from './server/session/relay.js';
export { createAgentApi } from './server/session/agent.js';
