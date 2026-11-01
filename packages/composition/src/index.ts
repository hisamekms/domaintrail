// The public surface of @domaintrail/composition (the `.` export; ADR 0027, Dependency rules): the entry points of
// `dt` with every adapter wired — the CLI (`bin/dt.ts`), the Live View server, the session server, the subscriber.
// Presentation and composition merge into one app, apps/dt, in T8.

export { cliDeps, runDt } from './cli.js';
export { startViewServer, type ViewServer, type ViewServerOptions } from './view.js';
export {
    issueFacilitatorLink,
    startSessionServer,
    WS_EXPIRED,
    WS_REVOKED,
    WS_SESSION_CLOSED,
    type SessionServer,
    type SessionServerOptions,
} from './session.js';
export { readCredential, startSubscriber, type RunningSubscriber, type SubscriberOptions } from './subscriber.js';
export { createWatcherHold, ECHO_MS, type WatcherHold } from './watcher-hold.js';
export { createModelValidator } from './validator.js';
