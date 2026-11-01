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
     * an import by a file of the kernel of anything but the kernel's own files and the pure builtins (Langium, the
     * model, any other module) — `<file>: <specifier>`
     */
    | 'kernel';

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
    /**
     * The directory of its sources that holds the shared kernel (ADR 0027, Layout: `shared/kernel/`) until T8 moves it
     * into a package of its own: `Diagnostic`, `SourceFile`, `Location`, the suggestions. Every package may take what
     * index.ts exports from it, a context too, as if it came from `shared/kernel` (ADR 0027, Dependency rules). It
     * imports nothing outside it but the pure builtins (rule `kernel`).
     */
    kernel?: string;
    /** The violations it still has, by rule; the comment of each group names the task that removes it. */
    exceptions?: Partial<Record<Rule, readonly string[]>>;
}

// Exceptions are grouped by the task of docs/plans/0027-boundaries.md that removes them. Since T2 every package is
// imported through its index.ts (`.`) and `./protocol`; what a context still takes from outside an upstream's
// published language is listed by the module it reaches.
export const MAP: Record<string, Module> = {
    modeling: {
        kind: 'context',
        dir: 'packages/modeling',
        sources: 'packages/modeling/src',
        upstream: [],
        // the typed model, Storming's IR (T8: contexts/storming)
        published: ['model/model', 'model/dependencies', 'model/usages', 'model/ids', 'storming/ir'],
        // diagnostics, suggestions, sources and locations (T8: shared/kernel)
        kernel: 'kernel',
        exceptions: {
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
            'public-surface': [
                // the project analysis (`isStormingFile`, `analyze`; modeling's `analysis/` since T4): the capability
                // `analysis`, which a context may not import; the validator goes behind Collaboration's ModelValidator
                // port, implemented in the app (T8)
                '@domaintrail/modeling/analysis/analyze',
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
    },
    agent: {
        kind: 'capability',
        dir: 'packages/agent',
        sources: 'packages/agent/src',
        upstream: ['collaboration'],
    },
    workspace: {
        kind: 'platform',
        dir: 'packages/workspace',
        sources: 'packages/workspace/src',
        upstream: ['modeling'],
        exceptions: {
            // the platform knows no context: it still takes the configuration (`DEFAULT_SOURCES`, `IGNORED_DIRS`,
            // `sourceMatcher`, `resolveConfig`, `staysInside`, ...) and the generator's `GENERATED_MARKER` from
            // modeling; their owners pass the values in (T6). Its `SourceFile` is the kernel's since T3, which the
            // platform may take, but the kernel lies inside modeling until T8 makes it shared/kernel
            kinds: ['modeling'],
        },
    },
    presentation: {
        kind: 'app',
        dir: 'packages/presentation',
        sources: 'packages/presentation/src',
        upstream: ['collaboration', 'modeling', 'visualization'],
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
        },
    },
    web: {
        kind: 'app',
        dir: 'web',
        sources: 'web',
        upstream: ['collaboration', 'modeling', 'visualization'],
    },
};
