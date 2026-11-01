// The boundary map of ADR 0027: the kind of each workspace package, the @domaintrail/* packages it depends on, and the
// violations that the code still has (its exceptions). test/architecture.test.ts derives every boundary check from
// this table; there are no per-package rules besides it. *Decided by the maintainer:* a TypeScript table first; it
// moves to a `.dt` context map (ADR 0006) once the context map can say upstream/downstream and published language.
//
// The map lives under test/ because only the architecture test reads it: inside a package it would be a module that
// some package then depends on. What lies outside the workspace packages is outside the map: `bin/`, `scripts/` and
// `test/` import the packages as the root package.json's devDependencies, and are bound only by `exports` (T2).
//
// The exceptions only shrink: an exception that no longer occurs fails the test. New code adds none; a task adds only
// the ones it lists in docs/plans/0027-boundaries.md.

/** The kinds of module of ADR 0027 (Three kinds of module, Layout). */
export type Kind = 'context' | 'capability' | 'platform' | 'app';

/** The kinds a kind may depend on (ADR 0027, Dependency rules). A dependency must also be declared in `upstream`. */
export const MAY_DEPEND_ON: Record<Kind, readonly Kind[]> = {
    // declared upstream contexts only
    context: ['context'],
    // contexts; other capabilities only when declared (`analysis → generation`); the platform
    capability: ['context', 'capability', 'platform'],
    platform: ['platform'],
    // contexts, capabilities, the platform; not another app
    app: ['context', 'capability', 'platform'],
};

/**
 * The entries of another package that a kind may import (ADR 0027, Dependency rules; Protocols): `.` is the published
 * language and the use cases, `./protocol` the wire types. A context takes only the published language of its
 * upstream contexts.
 */
export const SURFACES: Record<Kind, readonly string[]> = {
    context: ['.'],
    capability: ['.', './protocol'],
    platform: ['.'],
    app: ['.', './protocol'],
};

/** What a package.json `exports` may list (ADR 0027, Enforcement). */
export const EXPORTS = ['.', './protocol'] as const;

/** The rules the architecture test checks; each names what an exception of that rule holds. */
export type Rule =
    /** a dependency between kinds that MAY_DEPEND_ON does not allow — the upstream package's name */
    | 'kinds'
    /** an `exports` key other than `.` and `./protocol` — the key */
    | 'exports'
    /** an import of another package other than its SURFACES — the specifier */
    | 'public-surface'
    /** an import of another package's `infrastructure/` or `adapters/` by a module that is not an app — the specifier */
    | 'foreign-infrastructure'
    /** an import of I/O by a file under `domain/` or `core/` — `<file under the sources>: <specifier>` */
    | 'pure-core-io'
    /** an import of `application/`, `infrastructure/` or `adapters/` by a file under `domain/` or `core/` — `<file>: <specifier>` */
    | 'pure-core-layers'
    /** an import of I/O by a file under `application/` — `<file>: <specifier>` */
    | 'application-io';

export interface Module {
    kind: Kind;
    /** The directory of its package.json, relative to the repository; the package is `@domaintrail/<name>`. */
    dir: string;
    /** Its sources, relative to the repository. */
    sources: string;
    /**
     * The @domaintrail/* packages it depends on, which its package.json declares exactly: a context's upstream contexts,
     * the contexts a capability uses and the capabilities it declares, what an app wires.
     */
    upstream: readonly string[];
    /** The violations it still has, by rule; the comment of each group names the task that removes it. */
    exceptions?: Partial<Record<Rule, readonly string[]>>;
}

// Exceptions are grouped by the task of docs/plans/0027-boundaries.md that removes them. `exports: ['./*']` and the
// deep imports (`public-surface`) are T2's: an index.ts (and protocol.ts) per package, `exports` narrowed, every deep
// import replaced; a group marked with another task stays a deep import until that task, because what it imports is
// not the published language of its package.
export const MAP: Record<string, Module> = {
    modeling: {
        kind: 'context',
        dir: 'packages/modeling',
        sources: 'packages/modeling/src',
        upstream: [],
        exceptions: {
            exports: ['./*'],
            'pure-core-io': [
                // the configuration: split by owner, and the `realpathSync` check of `session.agent.dt` out of the pure
                // validation (T6)
                'core/config.ts: node:fs',
            ],
        },
    },
    collaboration: {
        kind: 'context',
        dir: 'packages/collaboration',
        sources: 'packages/collaboration/src',
        // Collaboration → Modeling, Storming (Storming is part of modeling until T8). Today's test also let it take
        // visualization's types; it imports none, and the map does not carry that edge over (ADR 0027).
        upstream: ['modeling'],
        exceptions: {
            exports: ['./*'],
            'public-surface': [
                // Modeling's and Storming's published language (T2); `Diagnostic` goes to the kernel (T3)
                '@domaintrail/modeling/core/diagnostics',
                '@domaintrail/modeling/model/model',
                '@domaintrail/modeling/storming/ir',
                // the project analysis (`isStormingFile`, `analyze`): the capability `analysis` after T4, which a
                // context may not import; the validator goes behind Collaboration's ModelValidator port, implemented in
                // the app (T4, T8)
                '@domaintrail/modeling/core/analyze',
                // not Modeling's language: the rule of Collaboration's `Emoji` primitive (`isNormalEmoji`) and the
                // `session.classifier` setting (`ClefModel`) move to Collaboration (T6)
                '@domaintrail/modeling/core/emoji',
                '@domaintrail/modeling/core/config',
            ],
        },
    },
    visualization: {
        kind: 'capability',
        dir: 'packages/visualization',
        sources: 'packages/visualization/src',
        upstream: ['modeling'],
        exceptions: {
            exports: ['./*'],
            'public-surface': [
                // Modeling's and Storming's published language (T2)
                '@domaintrail/modeling/core/diagnostics',
                '@domaintrail/modeling/model/dependencies',
                '@domaintrail/modeling/model/model',
                '@domaintrail/modeling/storming/ir',
                // the project analysis (T2; the capability `analysis` after T4) and the `sources` setting (T6)
                '@domaintrail/modeling/core/analyze',
                '@domaintrail/modeling/core/config',
            ],
        },
    },
    agent: {
        kind: 'capability',
        dir: 'packages/agent',
        sources: 'packages/agent/src',
        upstream: ['collaboration'],
        exceptions: {
            exports: ['./*'],
            'public-surface': [
                // Collaboration's published language (T2): its generated contracts; the agent's reply (limits, schema,
                // validation) and a message's tokens, run-time modules both sides use
                '@domaintrail/collaboration/generated/index',
                '@domaintrail/collaboration/domain/reply',
                '@domaintrail/collaboration/domain/body',
            ],
        },
    },
    workspace: {
        kind: 'platform',
        dir: 'packages/workspace',
        sources: 'packages/workspace/src',
        upstream: ['modeling'],
        exceptions: {
            // the platform knows no context: `SourceFile` goes to the kernel (T3); the configuration's sections are
            // owned elsewhere and their values (sources, ignored directories, the generated marker) passed in (T6)
            kinds: ['modeling'],
            exports: ['./*'],
            'public-surface': [
                // until the dependency above goes (T3, T6)
                '@domaintrail/modeling/core/analyze',
                '@domaintrail/modeling/core/config',
                '@domaintrail/modeling/generator/typescript',
            ],
        },
    },
    presentation: {
        kind: 'app',
        dir: 'packages/presentation',
        sources: 'packages/presentation/src',
        upstream: ['collaboration', 'modeling', 'visualization'],
        exceptions: {
            exports: ['./*'],
            'public-surface': [
                // Collaboration's application, published language and generated contracts (T2)
                '@domaintrail/collaboration/application/access',
                '@domaintrail/collaboration/application/actor',
                '@domaintrail/collaboration/application/identity',
                '@domaintrail/collaboration/application/ports',
                '@domaintrail/collaboration/application/use-cases',
                '@domaintrail/collaboration/domain/body',
                '@domaintrail/collaboration/domain/marks',
                '@domaintrail/collaboration/domain/reply',
                '@domaintrail/collaboration/domain/targets',
                '@domaintrail/collaboration/generated/index',
                // Modeling's published language and use cases: model, diagnostics, suggestions, format, generator (T2)
                '@domaintrail/modeling/core/analyze',
                '@domaintrail/modeling/core/diagnostics',
                '@domaintrail/modeling/core/suggest',
                '@domaintrail/modeling/format/format',
                '@domaintrail/modeling/generator/naming',
                '@domaintrail/modeling/generator/typescript',
                '@domaintrail/modeling/model/ids',
                '@domaintrail/modeling/model/model',
                '@domaintrail/modeling/model/usages',
                '@domaintrail/modeling/storming/format',
                // the LSP over the syntax: AST helpers and the Langium modules (T2; Modeling's `infrastructure/syntax`
                // after T8)
                '@domaintrail/modeling/core/labels',
                '@domaintrail/modeling/core/model-index',
                '@domaintrail/modeling/language/domain-module',
                '@domaintrail/modeling/language/generated/ast',
                '@domaintrail/modeling/language/generated/module',
                '@domaintrail/modeling/storming/language/module',
                // the configuration (T2; split by owner in T6) and the emoji rule (T6, with Collaboration)
                '@domaintrail/modeling/core/config',
                '@domaintrail/modeling/core/emoji',
                // visualization's application and graph (T2)
                '@domaintrail/visualization/application/ports',
                '@domaintrail/visualization/application/view-service',
                '@domaintrail/visualization/domain/graph/ir',
            ],
        },
    },
    composition: {
        kind: 'app',
        dir: 'packages/composition',
        sources: 'packages/composition/src',
        // the wiring; presentation and composition merge into one app, apps/dt (T8)
        upstream: ['agent', 'collaboration', 'modeling', 'presentation', 'visualization', 'workspace'],
        exceptions: {
            // an app depends on no other app: presentation and composition merge into apps/dt (T8)
            kinds: ['presentation'],
            exports: ['./*'],
            'public-surface': [
                // the agent's core and adapters it wires (T2)
                '@domaintrail/agent/application/ports',
                '@domaintrail/agent/application/subscriber',
                '@domaintrail/agent/infrastructure/claude-code',
                '@domaintrail/agent/infrastructure/dt-shim',
                '@domaintrail/agent/infrastructure/dt-tools',
                '@domaintrail/agent/infrastructure/http-agent-api',
                '@domaintrail/agent/infrastructure/system',
                '@domaintrail/agent/infrastructure/workspace-scan',
                // Collaboration's application and infrastructure it wires (T2)
                '@domaintrail/collaboration/application/access',
                '@domaintrail/collaboration/application/classifier',
                '@domaintrail/collaboration/application/identity',
                '@domaintrail/collaboration/application/ports',
                '@domaintrail/collaboration/application/use-cases',
                '@domaintrail/collaboration/domain/body',
                '@domaintrail/collaboration/generated/index',
                '@domaintrail/collaboration/infrastructure/blobs',
                '@domaintrail/collaboration/infrastructure/clef',
                '@domaintrail/collaboration/infrastructure/identity',
                '@domaintrail/collaboration/infrastructure/session-dir',
                '@domaintrail/collaboration/infrastructure/session-files',
                '@domaintrail/collaboration/infrastructure/sqlite',
                '@domaintrail/collaboration/infrastructure/system',
                '@domaintrail/collaboration/infrastructure/validator',
                // the configuration (T2; composed here from its owners' sections in T6)
                '@domaintrail/modeling/core/config',
                // the entry points (T2; one app with composition in T8)
                '@domaintrail/presentation/cli/main',
                '@domaintrail/presentation/cli/ports',
                '@domaintrail/presentation/http/access',
                '@domaintrail/presentation/http/assets',
                '@domaintrail/presentation/http/routes',
                '@domaintrail/presentation/http/server',
                '@domaintrail/presentation/lsp/server',
                '@domaintrail/presentation/session/agent',
                '@domaintrail/presentation/session/identities',
                '@domaintrail/presentation/session/presence',
                '@domaintrail/presentation/session/relay',
                '@domaintrail/presentation/session/routes',
                '@domaintrail/presentation/websocket/hub',
                // visualization's application and adapters it wires (T2)
                '@domaintrail/visualization/application/layout-engine',
                '@domaintrail/visualization/application/ports',
                '@domaintrail/visualization/application/view-service',
                '@domaintrail/visualization/infrastructure/elk',
                '@domaintrail/visualization/infrastructure/file-layout-store',
                '@domaintrail/visualization/infrastructure/git',
                // the platform's file system, watching, snapshots (T2)
                '@domaintrail/workspace/infrastructure/config',
                '@domaintrail/workspace/infrastructure/files',
                '@domaintrail/workspace/infrastructure/generated-output',
                '@domaintrail/workspace/infrastructure/lint-hint',
                '@domaintrail/workspace/infrastructure/snapshot',
                '@domaintrail/workspace/infrastructure/watchers',
            ],
        },
    },
    web: {
        kind: 'app',
        dir: 'web',
        sources: 'web',
        upstream: ['collaboration', 'modeling', 'visualization'],
        exceptions: {
            'public-surface': [
                // Collaboration's published language and generated contracts (T2)
                '@domaintrail/collaboration/domain/body',
                '@domaintrail/collaboration/domain/marks',
                '@domaintrail/collaboration/domain/targets',
                '@domaintrail/collaboration/generated/index',
                // Modeling's and Storming's published language (T2); `Diagnostic` goes to the kernel (T3)
                '@domaintrail/modeling/core/diagnostics',
                '@domaintrail/modeling/model/dependencies',
                '@domaintrail/modeling/model/model',
                '@domaintrail/modeling/model/usages',
                '@domaintrail/modeling/storming/ir',
                // the emoji rule (T6, with Collaboration)
                '@domaintrail/modeling/core/emoji',
                // visualization's core and ports (T2); the diff, `aggregateDependencies` and the storming's semantic
                // graph move to Modeling and Storming (T7)
                '@domaintrail/visualization/application/ports',
                '@domaintrail/visualization/domain/graph/build',
                '@domaintrail/visualization/domain/graph/context-map',
                '@domaintrail/visualization/domain/graph/diff',
                '@domaintrail/visualization/domain/graph/ir',
                '@domaintrail/visualization/domain/storming/graph',
                '@domaintrail/visualization/domain/storming/ir',
                '@domaintrail/visualization/domain/storming/semantic',
                '@domaintrail/visualization/domain/storming/trie',
            ],
        },
    },
};
