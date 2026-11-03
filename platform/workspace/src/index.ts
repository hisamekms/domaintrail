// The public surface of @domaintrail/workspace (the `.` export; ADR 0027, Dependency rules): the workspace on disk —
// its sources, the configuration file, the output of `dt generate ts`, snapshots, watching — for the app that wires it.

export { type GitRefWatcher, type SourceEvent, type SourceSelection, type Unsubscribe, type WorkspaceWatcher } from './ports.js';
export { findConfigFile, loadConfig, type ConfigFileFormat } from './infrastructure/config.js';
export { createWorkspaceReader, findDomainFiles, loadWorkspace, readSources, SourceScope } from './infrastructure/files.js';
export { createGeneratedOutput } from './infrastructure/generated-output.js';
export { hasCastLintRule, LINT_HINT } from './infrastructure/lint-hint.js';
export { createWorkspaceSnapshot } from './infrastructure/snapshot.js';
// the `.gitignore` rules of a workspace (git's semantics), for what an agent may read
export { GitIgnore } from './infrastructure/gitignore.js';
export { createGitRefWatcher, createWorkspaceWatcher } from './infrastructure/watchers.js';
