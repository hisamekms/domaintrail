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
    | 'kernel'
    /**
     * an import across the inner modules of a package (`inner`): by the rest of the package, of an inner module; by an
     * inner module, of another one it does not list in its `upstream`, or of a module it lists in `never` —
     * `<file>: <specifier>`
     */
    | 'inner-modules';

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
    /**
     * The modules that lie inside its sources until T8 moves them into packages of their own, by directory (as `kernel`
     * for the shared kernel): the module each becomes, the other inner modules it may import (`upstream`), and the
     * modules of the package it must not import (`never`, without `.js`). The rest of the package is the package
     * itself, which an inner module may import; it imports no inner module (index.ts, the entry, exports them all).
     * So the move adds no cycle (rule `inner-modules`).
     */
    inner?: Record<string, { becomes: string; upstream: readonly string[]; never?: readonly string[] }>;
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
        // the typed model with its dependencies and diff, Modeling's rule IDs; Storming's IR, semantic graph and
        // occurrences, its rule IDs (T8: contexts/storming)
        published: [
            'model/model',
            'model/dependencies',
            'model/usages',
            'model/ids',
            'model/aggregates',
            'model/diff',
            'model/rule-ids',
            'storming/ir',
            'storming/semantic',
            'storming/rule-ids',
            'storming/files',
        ],
        // diagnostics, suggestions, sources and locations, `camel` (T8: shared/kernel)
        kernel: 'kernel',
        inner: {
            // Storming reads Modeling's typed model, which knows nothing of it; its analysis takes the model as its
            // input and does not run Modeling's analysis (T4)
            storming: { becomes: 'contexts/storming', upstream: [], never: ['core/analyze'] },
            // the project analysis runs Modeling's analysis, then Storming's with the model, and the generation's
            // checks (T4, T5)
            analysis: { becomes: 'capabilities/analysis', upstream: ['storming', 'generator'] },
            // the TypeScript generator, its section of the configuration (`generator/config.ts`, T6) and its name check
            // (M011), which the project analysis runs; Modeling's own code (the checkers) does not import it (T5), and
            // it does not run Modeling's analysis. Until T10
            // its name check and `naming` read the AST: they take `core/model-index` (the AST index) and
            // `core/diagnostic-sink` from the package, which an inner module may import; T10 puts them onto the typed
            // model, and T8 makes generation a capability of its own that imports only Modeling's `.`
            generator: { becomes: 'capabilities/generation', upstream: [], never: ['core/analyze'] },
        },
    },
    collaboration: {
        kind: 'context',
        dir: 'contexts/collaboration',
        sources: 'contexts/collaboration/src',
        // Collaboration → Modeling, Storming (Storming is part of modeling until T8). Today's test also let it take
        // visualization's types; it imports none, and the map does not carry that edge over (ADR 0027).
        upstream: ['modeling'],
    },
    visualization: {
        kind: 'capability',
        dir: 'capabilities/visualization',
        sources: 'capabilities/visualization/src',
        upstream: ['modeling'],
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
        upstream: ['modeling'],
        exceptions: {
            // the platform knows no context: since T6 it receives the configuration's values (the sources, the
            // directories never scanned, the config file's format, the generator's marker) and takes from modeling only
            // the kernel's `SourceFile` (a type), which a platform may take, but the kernel lies inside modeling until T8
            // makes it shared/kernel
            kinds: ['modeling'],
        },
    },
    presentation: {
        kind: 'app',
        dir: 'packages/presentation',
        sources: 'packages/presentation/src',
        upstream: ['agent', 'collaboration', 'modeling', 'visualization'],
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
        dir: 'apps/web',
        sources: 'apps/web',
        upstream: ['collaboration', 'modeling', 'visualization'],
    },
};
