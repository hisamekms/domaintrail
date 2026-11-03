// The public surface of @domaintrail/workspace (the `.` export; ADR 0027, Dependency rules): the workspace on disk —
// its sources, the configuration file, the output of `dt generate ts`, snapshots, watching — for the app that wires it.

export { type GitRefWatcher, type SourceEvent, type SourceSelection, type Unsubscribe, type WorkspaceWatcher } from './ports.js';
export { existsExactly, findConfigFile, findConfigFiles, loadConfig, type ConfigFileFormat, type ConfigText } from './infrastructure/config.js';
export { createWorkspaceReader, findDomainFiles, loadWorkspace, readSources, SourceScope } from './infrastructure/files.js';
export { createGeneratedOutput } from './infrastructure/generated-output.js';
export { hasCastLintRule, LINT_HINT } from './infrastructure/lint-hint.js';
export { createWorkspaceSnapshot } from './infrastructure/snapshot.js';
// the `.gitignore` rules of a workspace (git's semantics), for what an agent may read
export { GitIgnore, repositoryTop } from './infrastructure/gitignore.js';
// what git itself says of them, where it speaks for the root (every source of ignores, `core.excludesFile` included)
export { gitFileState, gitIgnoredEntries, gitNestedRepositories, gitReadableFiles, type GitFilesOptions } from './infrastructure/git-files.js';
export { createGitRefWatcher, createWorkspaceWatcher } from './infrastructure/watchers.js';
