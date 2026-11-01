// The boundary map of ADR 0027: the kind of each workspace package, the @domaintrail/* packages it depends on, and the
// violations that the code still has (its exceptions). test/architecture.test.ts derives every boundary check from
// this table; there are no per-package rules besides it. *Decided by the maintainer:* a TypeScript table first; it
// moves to a `.dt` context map (ADR 0006) once the context map can say upstream/downstream and published language.
//
// The map lives under test/ because only the architecture test reads it: inside a package it would be a module that
// some package then depends on. What lies outside the workspace packages is outside the map: `bin/`, `scripts/` and
// `test/` import the packages as the root package.json's devDependencies, through their entries only (`exports`, and
// a rule of the architecture test).
//
// The exceptions only shrink: an exception that no longer occurs fails the test. New code adds none; a task adds only
// the ones it lists in docs/plans/0027-boundaries.md.

/** The kinds of module of ADR 0027 (Three kinds of module, Layout); `kernel` is `shared/kernel`. */
export type Kind = 'context' | 'capability' | 'platform' | 'kernel' | 'app';

/** The kinds a kind may depend on (ADR 0027, Dependency rules). A dependency must also be declared in `upstream`. */
export const MAY_DEPEND_ON: Record<Kind, readonly Kind[]> = {
    // declared upstream contexts only; the kernel
    context: ['context', 'kernel'],
    // contexts; other capabilities only when declared (`analysis → generation`); the platform; the kernel
    capability: ['context', 'capability', 'platform', 'kernel'],
    platform: ['platform', 'kernel'],
    // everyone may take the kernel; it depends on nothing
    kernel: [],
    // contexts, capabilities, the platform, the kernel; not another app
    app: ['context', 'capability', 'platform', 'kernel'],
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
    kernel: ['.'],
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
    /**
     * an import of another package other than its SURFACES — the specifier; or a context's import through an upstream
     * context's `.` of a name from outside its `published` modules — `@domaintrail/<package>/<module>`
     */
    | 'public-surface'
    /**
     * an import of another package's `infrastructure/` or `adapters/` by a module that is not an app — the module it
     * reaches, `@domaintrail/<package>/<module>` (through `.`, the module index.ts takes the name from)
     */
    | 'foreign-infrastructure'
    /** an import of I/O by a file under `domain/` or `core/` — `<file under the sources>: <specifier>` */
    | 'pure-core-io'
    /** an import of `application/`, `infrastructure/` or `adapters/` by a file under `domain/` or `core/` — `<file>: <specifier>` */
    | 'pure-core-layers'
    /** an import of I/O by a file under `application/` — `<file>: <specifier>` */
    | 'application-io'
    /**
     * an import by a file of the kernel (shared/kernel) of anything but the kernel's own files and the pure builtins
     * (Langium, the model, any other module) — `<file>: <specifier>`
     */
    | 'kernel'
    /**
     * an import of Langium or of a context's `infrastructure/syntax/` by a file under `domain/` or `core/` — the file,
     * `<file under the sources>` (one entry per checker that still reads the AST, until T10)
     */
    | 'syntax';

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
    /**
     * A context's published language: the modules of its sources (`model/model`) whose names its index.ts exports for
     * the contexts downstream (ADR 0027, Dependency rules). The rest of `.` (use cases, adapters) is for the apps and
     * capabilities; a context importing it violates `public-surface`, keyed by the module it reaches.
     */
    published?: readonly string[];
    /** The violations it still has, by rule; the comment of each group names the task that removes it. */
    exceptions?: Partial<Record<Rule, readonly string[]>>;
}

// Exceptions are grouped by the task of docs/plans/0027-boundaries.md that removes them. Since T2 every package is
// imported through its index.ts (`.`) and `./protocol`; what a context still takes from outside an upstream's
// published language is listed by the module it reaches.
export const MAP: Record<string, Module> = {
    modeling: {
        kind: 'context',
        dir: 'contexts/modeling',
        sources: 'contexts/modeling/src',
        upstream: ['kernel'],
        // the typed model with its dependencies and diff, the stable IDs, Modeling's rule IDs
        published: ['domain/model', 'domain/dependencies', 'domain/usages', 'domain/ids', 'domain/aggregates', 'domain/diff', 'domain/rule-ids'],
        exceptions: {
            // T10 (ADR 0027, Modeling: every checker moves onto the typed model): the checkers that still read the AST,
            // its index and the diagnostic sink from `infrastructure/syntax/` (and Langium), one entry per file; each
            // checker's task removes its entry
            syntax: ['domain/rules/labels.ts', 'domain/rules/names.ts', 'domain/rules/shared.ts', 'domain/rules/structure.ts', 'domain/rules/unions.ts'],
        },
    },
    storming: {
        kind: 'context',
        dir: 'contexts/storming',
        sources: 'contexts/storming/src',
        // Storming → Modeling: it reads Modeling's typed model, which knows nothing of it; its analysis takes the model
        // as its input and does not run Modeling's analysis (T4)
        upstream: ['kernel', 'modeling'],
        // the IR of a storming, its semantic graph and timeline occurrences, its rule IDs, its files
        published: ['domain/ir', 'domain/semantic', 'domain/rule-ids', 'domain/files'],
    },
    collaboration: {
        kind: 'context',
        dir: 'contexts/collaboration',
        sources: 'contexts/collaboration/src',
        // Collaboration → Modeling, Storming. Today's test also let it take visualization's types; it imports none, and
        // the map does not carry that edge over (ADR 0027).
        upstream: ['kernel', 'modeling', 'storming'],
    },
    analysis: {
        kind: 'capability',
        dir: 'capabilities/analysis',
        sources: 'capabilities/analysis/src',
        // the project analysis runs Modeling's analysis, then Storming's with the model, and the generation's checks
        // (T4, T5)
        upstream: ['generation', 'kernel', 'modeling', 'storming'],
    },
    generation: {
        kind: 'capability',
        dir: 'capabilities/generation',
        sources: 'capabilities/generation/src',
        // the TypeScript generator, its sections of the configuration (T6) and its name check (M011), which the project
        // analysis runs (T5)
        upstream: ['kernel', 'modeling'],
        exceptions: {
            // T10: the name check (`core/tsnames.ts`) and `core/naming.ts`'s generated names read Modeling's AST, its
            // index and its diagnostic sink, which modeling's `.` exports for them; on the typed model they need none
            'foreign-infrastructure': [
                '@domaintrail/modeling/infrastructure/syntax/generated/ast',
                '@domaintrail/modeling/infrastructure/syntax/model-index',
                '@domaintrail/modeling/infrastructure/syntax/diagnostic-sink',
            ],
            // T10: `core/naming.ts` names the AST node a generated name comes from (Langium's `AstNode`)
            syntax: ['core/naming.ts'],
        },
    },
    visualization: {
        kind: 'capability',
        dir: 'capabilities/visualization',
        sources: 'capabilities/visualization/src',
        // the view service and the git baseline analyze the workspace through the project analysis
        upstream: ['analysis', 'kernel', 'modeling', 'storming'],
    },
    agent: {
        kind: 'capability',
        dir: 'capabilities/agent',
        sources: 'capabilities/agent/src',
        upstream: ['collaboration'],
    },
    workspace: {
        kind: 'platform',
        dir: 'platform/workspace',
        sources: 'platform/workspace/src',
        // the platform knows no context: it receives the configuration's values (the sources, the directories never
        // scanned, the config file's format, the generator's marker) and takes the kernel's `SourceFile` (T6, T8)
        upstream: ['kernel'],
    },
    kernel: {
        kind: 'kernel',
        dir: 'shared/kernel',
        sources: 'shared/kernel/src',
        // diagnostics, suggestions, sources and locations, `camel`: everyone may take it, it imports nothing (T3, T8)
        upstream: [],
    },
    dt: {
        kind: 'app',
        dir: 'apps/dt',
        sources: 'apps/dt/src',
        // the one binary: the CLI, the language server, the servers, and the wiring of every adapter (`main.ts`,
        // `wiring/`; presentation and composition before T8)
        upstream: ['agent', 'analysis', 'collaboration', 'generation', 'kernel', 'modeling', 'storming', 'visualization', 'workspace'],
    },
    web: {
        kind: 'app',
        dir: 'apps/web',
        sources: 'apps/web',
        // its unit tests analyze examples/shop through the project analysis (a devDependency)
        upstream: ['analysis', 'collaboration', 'kernel', 'modeling', 'storming', 'visualization'],
    },
};
