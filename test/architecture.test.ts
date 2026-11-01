// The boundaries of the workspace packages (ADR 0025, ADR 0027) that the package graph cannot enforce by itself. Every
// boundary check is derived from the map in test/architecture/map.ts (the kind of each package, what it depends on,
// its exceptions): the dependencies each package.json declares, the dependencies between kinds, the public surface
// (`exports` and the entries imported across packages), and the layers. A failure names the rule, ADR 0027 and the
// usual fix; an exception that no longer occurs fails too, so the exception list only shrinks.
// Besides the map: that each package imports only what it declares, that a dependency declared in several manifests
// has one version (Dependabot updates them together; see ADR 0025), and where Node, Bun and the browser run.
// The isolated linker resolves only declared dependencies from a package's own node_modules, but a lookup that misses
// there walks up to the root's node_modules, which hold the CLI's dependencies and every @domaintrail/* package.
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Glob } from 'bun';
import { EXPORTS, MAP, MAY_DEPEND_ON, SURFACES, type Kind, type Rule } from './architecture/map';

const ROOT = path.join(import.meta.dir, '..');
const MAP_FILE = 'test/architecture/map.ts';

/** Relative imports that leave their package: the CLI embeds the guide as text (bundled into dist/dt.js). */
const OUTSIDE_PACKAGE: Record<string, string[]> = {
    'packages/presentation/src/cli/main.ts': ['docs/guide.md'],
};

/** What a file under `domain/`, `core/` or `application/` may not import besides builtins: the file system, the network, layout. */
const IO_PACKAGES = ['chokidar', 'ws', 'elkjs'];
/** The directories of a package's pure part: a context's `domain/`, a capability's `core/` (ADR 0027, Layout). */
const PURE = ['domain', 'core'];
/** The directories of a package's technology: a context's `infrastructure/`, a capability's `adapters/`. */
const TECHNOLOGY = ['infrastructure', 'adapters'];

interface PackageJson {
    name: string;
    exports?: string | Record<string, string>;
    workspaces?: string[];
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}

interface Import {
    /** The importing file, relative to the repository. */
    file: string;
    specifier: string;
    /** For a relative import, the imported path relative to the repository. */
    resolved?: string;
    /** `import type` / `export type`: erased at run time. */
    typeOnly: boolean;
    /** The names it takes (`import { a, type B as C }` → a, B), or all of them (`import * as`, a side-effect import). */
    names: string[] | 'all';
}

/** A unit test next to the code, or a helper of the unit tests (CONTRIBUTING.md, Tests): not part of the package's code. */
const isTest = (file: string): boolean => /\.test\.tsx?$/.test(file) || path.posix.basename(file) === 'test-helpers.ts';

/**
 * The module specifiers of a file's import and export declarations and dynamic imports, with the names they take. A
 * declaration starts its line, so the code that the generators write into template literals (`import * as fc from
 * 'fast-check';`) is not one.
 */
function specifiers(source: string): { specifier: string; typeOnly: boolean; names: string[] | 'all' }[] {
    const declarations = source.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:([\w$*{},\s]+?)\s+from\s+)?['"]([^'"]+)['"]/gm);
    const dynamic = source.matchAll(/(?:const\s+(\{[^}]*\})\s*=\s*await\s+)?\bimport\(\s*['"]([^'"]+)['"]\s*\)/g);
    return [
        ...[...declarations].map((m) => ({ specifier: m[3], typeOnly: m[1] !== undefined, names: namesOf(m[2]) })),
        ...[...dynamic].map((m) => ({ specifier: m[2], typeOnly: false, names: namesOf(m[1]) })),
    ];
}

/** The names an import clause takes: `{ a, type B as C }` → a, B; a default or namespace import (or none) takes all. */
function namesOf(clause: string | undefined): string[] | 'all' {
    const braces = clause?.match(/\{([^}]*)\}/);
    if (!braces || /\*/.test(clause!.replace(braces[0], ''))) return 'all';
    return braces[1]
        .split(',')
        .map((n) =>
            n
                .trim()
                .replace(/^type\s+/, '')
                .split(/\s+as\s+|\s*:\s*/)[0]
                .trim(),
        )
        .filter(Boolean);
}

async function importsOf(name: string): Promise<Import[]> {
    const { sources } = MAP[name];
    const imports: Import[] = [];
    for await (const rel of new Glob('**/*.{ts,tsx}').scan({ cwd: path.join(ROOT, sources) })) {
        if (rel.split('/').includes('node_modules')) continue;
        imports.push(...(await importsIn(path.posix.join(sources, rel))));
    }
    return imports;
}

async function importsIn(file: string): Promise<Import[]> {
    return specifiers(await readFile(path.join(ROOT, file), 'utf8')).map(({ specifier, typeOnly, names }) => {
        const resolved = specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)) : undefined;
        return { file, specifier, resolved, typeOnly, names };
    });
}

/**
 * What a package's index.ts (its `.` entry) exports, by name: the module of its sources each name comes from
 * (`domain/emoji`). index.ts names everything it exports (`export { a, type B } from './x.js'`, `export * as ns from`), so
 * that the rules can tell which module an import through `.` reaches.
 */
async function surfaceOf(name: string): Promise<Map<string, string> | undefined> {
    const file = Bun.file(path.join(ROOT, MAP[name].sources, 'index.ts'));
    if (!(await file.exists())) return undefined;
    const source = await file.text();
    const names = new Map<string, string>();
    const module = (from: string): string => path.posix.normalize(from).replace(/\.js$/, '');
    for (const m of source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/gm)) {
        for (const entry of m[1]
            .split(',')
            .map((e) => e.trim().replace(/^type\s+/, ''))
            .filter(Boolean)) {
            const [, alias] = entry.match(/(?:\w+\s+as\s+)?(\w+)$/)!;
            names.set(alias, module(m[2]));
        }
    }
    for (const m of source.matchAll(/^export\s+\*\s+as\s+(\w+)\s+from\s+'([^']+)'/gm)) names.set(m[1], module(m[2]));
    return names;
}

const NAMES = Object.keys(MAP);
const ALL_IMPORTS = Object.fromEntries(await Promise.all(NAMES.map(async (name) => [name, await importsOf(name)] as const)));
/** The imports of each package's code; its unit tests have rules of their own (see `tests`). */
const IMPORTS = Object.fromEntries(NAMES.map((name) => [name, ALL_IMPORTS[name].filter((i) => !isTest(i.file))]));
/** The imports of each package's unit tests and their helpers. */
const UNIT_TEST_IMPORTS = Object.fromEntries(NAMES.map((name) => [name, ALL_IMPORTS[name].filter((i) => isTest(i.file))]));
const SURFACES_BY_NAME = Object.fromEntries(await Promise.all(NAMES.map(async (name) => [name, await surfaceOf(name)] as const)));
const MANIFESTS: Record<string, PackageJson> = Object.fromEntries(
    await Promise.all(NAMES.map(async (name) => [name, (await Bun.file(path.join(ROOT, MAP[name].dir, 'package.json')).json()) as PackageJson] as const)),
);

/** The package name of a bare specifier (`@scope/name/sub` → `@scope/name`, `name/sub` → `name`). */
const packageName = (specifier: string): string =>
    specifier
        .split('/')
        .slice(0, specifier.startsWith('@') ? 2 : 1)
        .join('/');
const isBuiltin = (specifier: string): boolean => specifier.startsWith('node:') || specifier === 'bun' || specifier.startsWith('bun:');
/** Builtins that do no I/O: paths and URLs are computed, not read. */
const PURE_BUILTINS = ['node:path', 'node:url'];
const isIO = (specifier: string): boolean => (isBuiltin(specifier) && !PURE_BUILTINS.includes(specifier)) || IO_PACKAGES.includes(packageName(specifier));
/** The directory segments of a path (without the file name). */
const segments = (file: string): string[] => file.split('/').slice(0, -1);
/** Whether an import reaches one of the directories (`application`, `infrastructure`, ...) by its path. */
const reaches = (imp: Import, dirs: string[]): boolean => (imp.resolved ?? imp.specifier).split('/').some((s) => dirs.includes(s));
/** A file's path inside its package's sources. */
const local = (name: string, file: string): string => file.slice(MAP[name].sources.length + 1);
const show = (imps: Import[]): string[] => imps.map((i) => `${i.file}: ${i.specifier}`);

/** Another @domaintrail/* package that an import reaches, and the entry (`.`, `./protocol`, `./core/analyze`, ...). */
function foreign(name: string, imp: Import): { target: string; entry: string } | undefined {
    if (!imp.specifier.startsWith('@domaintrail/')) return undefined;
    const [, target, ...rest] = imp.specifier.split('/');
    if (target === name) return undefined;
    return { target, entry: rest.length === 0 ? '.' : `./${rest.join('/')}` };
}

/**
 * The modules of another package that an import reaches, as `@domaintrail/<package>/<module>`: through `.`, the modules
 * index.ts takes the imported names from; through another entry, that entry.
 */
function reachedModules(name: string, imp: Import): string[] {
    const reached = foreign(name, imp);
    if (!reached) return [];
    const surface = SURFACES_BY_NAME[reached.target];
    if (reached.entry !== '.' || !surface) return [`@domaintrail/${reached.target}/${reached.entry.slice(2) || 'index'}`];
    const modules = imp.names === 'all' ? [...surface.values()] : imp.names.map((n) => surface.get(n) ?? `index (no export ${n})`);
    return [...new Set(modules)].map((m) => `@domaintrail/${reached.target}/${m}`);
}

// ---- the rules and their verdict -------------------------------------------------------------------------------

/** A violation of a rule: the module, the key an exception names (see `Rule` in the map), and where it occurs. */
interface Violation {
    module: string;
    key: string;
    where: string[];
}

interface RuleText {
    /** The section of ADR 0027 that states it. */
    section: string;
    statement: string;
    fix: (v: Violation) => string;
}

/** The usual fix for a dependency between two kinds that the map does not allow. */
function kindFix(from: Kind, to: Kind | undefined): string {
    if (to === 'app') return 'nothing depends on an app: move what both need out of the app, into the context, capability or platform that owns it';
    if (from === 'context' && to === 'capability')
        return "a context may not depend on a capability: move the domain knowledge into the context, or let the capability read the context's published language";
    if (from === 'context' && to === 'platform')
        return "a context does no I/O through the platform: define a port in the context's application and implement it in an app";
    if (from === 'platform')
        return 'the platform knows no context or capability: let the app that wires it pass what it needs as values (or through a port the platform defines), or move the code to its owner';
    return 'move the code to the module that owns it, or depend on that module the way the map allows';
}

const RULES: Record<Rule, RuleText> = {
    kinds: {
        section: 'Dependency rules',
        statement:
            'a context depends only on its declared upstream contexts; a capability on contexts, the platform and declared capabilities; the platform only on the platform; an app on contexts, capabilities and the platform; nothing on an app.',
        fix: (v) => kindFix(MAP[v.module].kind, MAP[v.key]?.kind),
    },
    exports: {
        section: 'Dependency rules, Enforcement',
        statement: 'a package.json `exports` lists only `.` (published language and use cases) and `./protocol` (wire types).',
        fix: () =>
            'give the package an index.ts (and a protocol.ts for its wire types), export them as `.` and `./protocol`, and change the imports of every other package to them',
    },
    'public-surface': {
        section: 'Dependency rules',
        statement:
            'across packages only what `exports` lists is imported: `.` and `./protocol`; a context takes only the published language (`.`) of its declared upstream contexts. Deep imports (`@domaintrail/<package>/<path>`) are rejected.',
        fix: (v) =>
            v.key.split('/').length > 2 && MAP[v.module].kind === 'context' && MAP[packageName(v.key).split('/')[1]]?.published
                ? `a context takes only the published language of its upstream contexts, and ${v.key} is not part of it: move what it needs into the published language of its owner (or into this context), or pass it in through a port`
                : `import it from '${packageName(v.key)}' and export it from that package's index.ts if it is its published language or a use case (protocol.ts if it is a wire type); if it is neither, the code belongs on the other side of the boundary: move it to its owner`,
    },
    'foreign-infrastructure': {
        section: 'Layout, Enforcement',
        statement: "only an app imports another package's `infrastructure/` or `adapters/`.",
        fix: () => "depend on a port that the package's application defines (or on its published language) and let an app wire the implementation",
    },
    'pure-core-io': {
        section: 'Layout, Enforcement',
        statement: `\`domain/\` and \`core/\` import no I/O (node:* but ${PURE_BUILTINS.join(', ')}, bun, ${IO_PACKAGES.join(', ')}).`,
        fix: () =>
            "put the I/O behind a port of the package's application, implemented in `infrastructure/` (a capability's `adapters/`), or pass the values in",
    },
    'pure-core-layers': {
        section: 'Layout, Enforcement',
        statement: '`domain/` and `core/` import neither `application/` nor `infrastructure/` (`adapters/`): the pure part depends on nothing outside it.',
        fix: () => 'move what the pure part needs into `domain/` (`core/`), or turn the dependency around with a port that `application/` defines',
    },
    'application-io': {
        section: 'Layout, Enforcement',
        statement: `\`application/\` imports no I/O (node:* but ${PURE_BUILTINS.join(', ')}, bun, ${IO_PACKAGES.join(', ')}): it reaches technology through ports.`,
        fix: () => "define a port in `application/` and implement it in `infrastructure/` (a capability's `adapters/`), wired by an app",
    },
    kernel: {
        section: 'Layout',
        statement: `the kernel (shared/kernel; a package's \`kernel\` directory in the map until T8) is kept small: it imports only its own files and ${PURE_BUILTINS.join(', ')}, no Langium and no other module.`,
        fix: () =>
            'keep the kernel to plain types and functions: leave what needs Langium or the model in the module that uses it (as `DiagnosticSink` in core/), or pass it in as a value',
    },
    'inner-modules': {
        section: 'Layout; Project analysis and configuration',
        statement:
            "the modules that lie inside a package until T8 (the map's `inner`: Storming, the project analysis, the generator) depend in one direction: the package's own code imports none of them, and an inner module imports another only when the map lists it in its `upstream`, never a module of its `never`.",
        fix: () =>
            "turn the dependency around: the downstream module takes what it needs as its input (Storming's analysis takes the typed model, a checker takes a name rule from the kernel), and the project analysis (`analysis/`) runs the analyses and the generation's checks and combines them",
    },
};

/** The problems of a rule: violations that no exception lists, and exceptions that no longer occur. */
function verdict(rule: Rule, violations: Violation[]): string[] {
    const text = RULES[rule];
    const found = new Map<string, Violation>();
    for (const v of violations) {
        const id = `${v.module}\u0000${v.key}`;
        const known = found.get(id);
        if (known) known.where.push(...v.where.filter((w) => !known.where.includes(w)));
        else found.set(id, { ...v, where: [...v.where] });
    }
    const problems: string[] = [];
    for (const v of found.values()) {
        if (MAP[v.module].exceptions?.[rule]?.includes(v.key)) continue;
        problems.push(
            [
                `✗ ${rule}: ${v.module} (${MAP[v.module].kind}) — ${v.key}`,
                `  at: ${v.where.join(', ')}`,
                `  rule (ADR 0027, ${text.section}): ${text.statement}`,
                `  fix: ${text.fix(v)}.`,
                `  The exceptions in ${MAP_FILE} only shrink: do not add one for new code.`,
            ].join('\n'),
        );
    }
    for (const [module, entry] of Object.entries(MAP)) {
        for (const key of entry.exceptions?.[rule] ?? []) {
            if (found.has(`${module}\u0000${key}`)) continue;
            problems.push(
                [
                    `✗ ${rule}: the exception ${module} — ${key} no longer occurs.`,
                    `  Remove it from ${MAP_FILE} (ADR 0027, Enforcement: the exception list only shrinks).`,
                ].join('\n'),
            );
        }
    }
    return problems;
}

function expectNoProblems(rule: Rule, violations: Violation[]): void {
    const problems = verdict(rule, violations);
    if (problems.length > 0) throw new Error(`${problems.length} problem(s) with the rule ${rule}:\n\n${problems.join('\n\n')}`);
}

// ---- the map itself --------------------------------------------------------------------------------------------

describe('the boundary map', () => {
    test('it lists every workspace package, and nothing else', async () => {
        const root = (await Bun.file(path.join(ROOT, 'package.json')).json()) as PackageJson;
        const dirs: string[] = [];
        for (const pattern of root.workspaces ?? []) {
            for await (const manifest of new Glob(`${pattern}/package.json`).scan({ cwd: ROOT })) dirs.push(path.posix.dirname(manifest));
        }
        expect(dirs.sort()).toEqual(
            Object.values(MAP)
                .map((m) => m.dir)
                .sort(),
        );
    });

    test('its upstreams are other packages of the map, and its exceptions name known rules once each', () => {
        for (const [name, entry] of Object.entries(MAP)) {
            expect({ name, unknown: entry.upstream.filter((u) => !(u in MAP) || u === name) }).toEqual({ name, unknown: [] });
            for (const [dir, inner] of Object.entries(entry.inner ?? {})) {
                expect({ name, dir, unknown: inner.upstream.filter((u) => !(u in entry.inner!) || u === dir) }).toEqual({ name, dir, unknown: [] });
            }
            for (const [rule, keys] of Object.entries(entry.exceptions ?? {})) {
                expect({ name, rule, known: rule in RULES }).toEqual({ name, rule, known: true });
                expect({ name, rule, duplicated: keys.filter((k, i) => keys.indexOf(k) !== i) }).toEqual({ name, rule, duplicated: [] });
            }
        }
    });
});

// ---- dependencies ----------------------------------------------------------------------------------------------

describe('dependencies', () => {
    test('every package has sources and imports', () => {
        for (const name of NAMES) expect(IMPORTS[name].length).toBeGreaterThan(0);
    });

    test("each package is named after its entry in the map and declares exactly the map's @domaintrail/* upstream", () => {
        for (const name of NAMES) {
            const manifest = MANIFESTS[name];
            expect(manifest.name).toBe(`@domaintrail/${name}`);
            const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((d) => d.startsWith('@domaintrail/'));
            expect({ name, declared: declared.sort() }).toEqual({ name, declared: MAP[name].upstream.map((d) => `@domaintrail/${d}`).sort() });
        }
    });

    test('a package depends only on the kinds the map allows (kinds)', () => {
        const violations = NAMES.flatMap((name) =>
            MAP[name].upstream
                .filter((u) => !MAY_DEPEND_ON[MAP[name].kind].includes(MAP[u].kind))
                .map((u) => ({ module: name, key: u, where: [`${MAP[name].dir}/package.json`] })),
        );
        expectNoProblems('kinds', violations);
    });

    test('a package imports only builtins, itself and what its package.json declares', () => {
        for (const name of NAMES) {
            const manifest = MANIFESTS[name];
            const declared = new Set([manifest.name, ...Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })]);
            const undeclared = IMPORTS[name].filter((i) => !i.resolved && !isBuiltin(i.specifier) && !declared.has(packageName(i.specifier)));
            expect(show(undeclared)).toEqual([]);
        }
    });

    test('a third-party dependency has the same version spec in every manifest that declares it', async () => {
        const root = (await Bun.file(path.join(ROOT, 'package.json')).json()) as PackageJson;
        const manifests: [string, PackageJson][] = [
            ['package.json', root],
            ...NAMES.map((name) => [`${MAP[name].dir}/package.json`, MANIFESTS[name]] as [string, PackageJson]),
        ];
        const specs = new Map<string, Map<string, string>>();
        for (const [file, manifest] of manifests) {
            for (const [dep, spec] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
                if (dep.startsWith('@domaintrail/')) continue;
                specs.set(dep, (specs.get(dep) ?? new Map<string, string>()).set(file, spec));
            }
        }
        expect([...specs.values()].some((byFile) => byFile.size > 1)).toBe(true);
        const drifted = [...specs]
            .filter(([, byFile]) => new Set(byFile.values()).size > 1)
            .map(([dep, byFile]) => ({ dep, specs: Object.fromEntries(byFile) }));
        expect(drifted).toEqual([]);
    });

    test('relative imports stay inside their package', () => {
        for (const name of NAMES) {
            const { sources } = MAP[name];
            const outside = IMPORTS[name].filter((i) => i.resolved && !i.resolved.startsWith(`${sources}/`) && !OUTSIDE_PACKAGE[i.file]?.includes(i.resolved));
            expect(show(outside)).toEqual([]);
        }
    });
});

// ---- the public surface ----------------------------------------------------------------------------------------

describe('public surface', () => {
    test('exports lists only . and ./protocol (exports)', () => {
        const violations = NAMES.flatMap((name) => {
            const { exports } = MANIFESTS[name];
            const keys = exports === undefined ? [] : typeof exports === 'string' ? ['.'] : Object.keys(exports);
            return keys
                .filter((k) => !(EXPORTS as readonly string[]).includes(k))
                .map((k) => ({ module: name, key: k, where: [`${MAP[name].dir}/package.json`] }));
        });
        expectNoProblems('exports', violations);
    });

    test('another package is imported only through the entries its kind may take (public-surface)', () => {
        const violations = NAMES.flatMap((name) =>
            IMPORTS[name].flatMap((imp) => {
                const reached = foreign(name, imp);
                if (!reached) return [];
                if (!SURFACES[MAP[name].kind].includes(reached.entry)) return [{ module: name, key: imp.specifier, where: [imp.file] }];
                // a context takes only the published language of its upstream contexts (and their kernel, which is
                // shared/kernel's after T8), not the rest of their `.`
                const { published, kernel } = MAP[reached.target];
                if (MAP[name].kind !== 'context' || !published) return [];
                const allowed = (module: string): boolean => published.includes(module) || (kernel !== undefined && module.startsWith(`${kernel}/`));
                return reachedModules(name, imp)
                    .filter((m) => !allowed(m.slice(`@domaintrail/${reached.target}/`.length)))
                    .map((m) => ({ module: name, key: m, where: [imp.file] }));
            }),
        );
        expectNoProblems('public-surface', violations);
    });

    test('a package others depend on exports its src/index.ts as `.`, and its src/protocol.ts as `./protocol` when it has one', async () => {
        const depended = new Set(NAMES.flatMap((name) => MAP[name].upstream));
        for (const name of NAMES) {
            const { exports } = MANIFESTS[name];
            const entries = exports === undefined ? {} : typeof exports === 'string' ? { '.': exports } : exports;
            const protocol = await Bun.file(path.join(ROOT, MAP[name].sources, 'protocol.ts')).exists();
            const expected = depended.has(name) ? { '.': './src/index.ts', ...(protocol && { './protocol': './src/protocol.ts' }) } : entries;
            expect({ name, exports: entries }).toEqual({ name, exports: expected });
        }
    });

    test("index.ts names what it exports, from the package's own modules", async () => {
        for (const name of NAMES) {
            const surface = SURFACES_BY_NAME[name];
            if (!surface) continue;
            const source = await Bun.file(path.join(ROOT, MAP[name].sources, 'index.ts')).text();
            expect({ name, star: /^export\s+\*\s+from/m.test(source) }).toEqual({ name, star: false });
            expect({ name, outside: [...surface.values()].filter((m) => m.startsWith('..')) }).toEqual({ name, outside: [] });
        }
    });

    test("a context's published language is exported by its index.ts", () => {
        for (const name of NAMES) {
            const modules = new Set(SURFACES_BY_NAME[name]?.values() ?? []);
            expect({ name, missing: (MAP[name].published ?? []).filter((m) => !modules.has(m)) }).toEqual({ name, missing: [] });
        }
    });

    test("a package's kernel is exported by its index.ts, every module of it", async () => {
        for (const name of NAMES) {
            const { kernel, sources } = MAP[name];
            if (kernel === undefined) continue;
            const modules = new Set(SURFACES_BY_NAME[name]?.values() ?? []);
            const files: string[] = [];
            for await (const rel of new Glob('*.ts').scan({ cwd: path.join(ROOT, sources, kernel) })) {
                if (!isTest(rel)) files.push(`${kernel}/${rel.replace(/\.ts$/, '')}`);
            }
            expect(files.length).toBeGreaterThan(0);
            expect({ name, missing: files.filter((m) => !modules.has(m)) }).toEqual({ name, missing: [] });
        }
    });
});

// ---- layers ----------------------------------------------------------------------------------------------------

describe('layers', () => {
    const all = NAMES.flatMap((name) => IMPORTS[name].map((imp) => ({ name, imp, dirs: segments(local(name, imp.file)) })));
    const pure = all.filter(({ dirs }) => dirs.some((d) => PURE.includes(d)));
    const atFile = (name: string, imp: Import): Violation => ({ module: name, key: `${local(name, imp.file)}: ${imp.specifier}`, where: [imp.file] });

    test("only an app imports another package's infrastructure/ or adapters/ (foreign-infrastructure)", () => {
        // through `.`, by the modules index.ts takes the imported names from
        const violations = all
            .filter(({ name }) => MAP[name].kind !== 'app')
            .flatMap(({ name, imp }) =>
                reachedModules(name, imp)
                    .filter((m) => m.split('/').some((s) => TECHNOLOGY.includes(s)))
                    .map((m) => ({ module: name, key: m, where: [imp.file] })),
            );
        expectNoProblems('foreign-infrastructure', violations);
    });

    test('domain/ and core/ import no I/O (pure-core-io)', () => {
        expect(pure.length).toBeGreaterThan(0);
        expectNoProblems(
            'pure-core-io',
            pure.filter(({ imp }) => isIO(imp.specifier)).map(({ name, imp }) => atFile(name, imp)),
        );
    });

    test('domain/ and core/ import neither application/ nor infrastructure/ (pure-core-layers)', () => {
        expectNoProblems(
            'pure-core-layers',
            pure.filter(({ imp }) => reaches(imp, ['application', ...TECHNOLOGY])).map(({ name, imp }) => atFile(name, imp)),
        );
    });

    test('the kernel imports only its own files and the pure builtins: no Langium, no other module (kernel)', () => {
        const inKernel = (name: string, file: string): boolean => {
            const { kernel, sources } = MAP[name];
            return kernel !== undefined && file.startsWith(`${sources}/${kernel}/`);
        };
        // the kernel's files import nothing today; `a package's kernel is exported` checks that there are files
        const kernel = all.filter(({ name, imp }) => inKernel(name, imp.file));
        expectNoProblems(
            'kernel',
            kernel
                .filter(({ name, imp }) => (imp.resolved ? !inKernel(name, imp.resolved) : !PURE_BUILTINS.includes(imp.specifier)))
                .map(({ name, imp }) => atFile(name, imp)),
        );
    });

    test('the inner modules of a package depend in one direction, the package itself on none of them (inner-modules)', () => {
        const innerOf = (name: string, file: string): string | undefined => {
            const { inner, sources } = MAP[name];
            const dir = file.startsWith(`${sources}/`) ? local(name, file).split('/')[0] : undefined;
            return inner && dir !== undefined && dir in inner ? dir : undefined;
        };
        const violations = all
            .filter(({ name, imp }) => MAP[name].inner !== undefined && imp.resolved !== undefined && local(name, imp.file) !== 'index.ts')
            .filter(({ name, imp }) => {
                const from = innerOf(name, imp.file);
                const to = innerOf(name, imp.resolved!);
                if (from === undefined) return to !== undefined;
                const { upstream, never = [] } = MAP[name].inner![from];
                return (to !== undefined && to !== from && !upstream.includes(to)) || never.includes(local(name, imp.resolved!).replace(/\.js$/, ''));
            })
            .map(({ name, imp }) => atFile(name, imp));
        expect(Object.values(MAP).some((m) => m.inner !== undefined)).toBe(true);
        expectNoProblems('inner-modules', violations);
    });

    test('application/ imports no I/O (application-io)', () => {
        const application = all.filter(({ dirs }) => dirs.includes('application'));
        expect(application.length).toBeGreaterThan(0);
        expectNoProblems(
            'application-io',
            application.filter(({ imp }) => isIO(imp.specifier)).map(({ name, imp }) => atFile(name, imp)),
        );
    });
});

// ---- tests ----------------------------------------------------------------------------------------------------

describe('tests', () => {
    test('a unit test imports builtins, its own package by relative paths, and what its package.json declares', () => {
        for (const name of NAMES) {
            const manifest = MANIFESTS[name];
            const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }));
            const wrong = UNIT_TEST_IMPORTS[name].filter((i) =>
                i.resolved ? !i.resolved.startsWith(`${MAP[name].sources}/`) : !isBuiltin(i.specifier) && !declared.has(packageName(i.specifier)),
            );
            expect(show(wrong)).toEqual([]);
        }
    });

    test('a unit test imports another package only through its entries (. and ./protocol)', () => {
        const deep = NAMES.flatMap((name) =>
            UNIT_TEST_IMPORTS[name].filter((i) => foreign(name, i) && !(EXPORTS as readonly string[]).includes(foreign(name, i)!.entry)),
        );
        expect(show(deep)).toEqual([]);
    });
});

/** The code outside the packages that imports them: the integration tests, the scripts, bin/. */
const OUTSIDE = ['test', 'scripts', 'bin'];
const OUTSIDE_IMPORTS = (
    await Promise.all(
        OUTSIDE.map(async (dir) => {
            const files: string[] = [];
            for await (const rel of new Glob('**/*.{ts,tsx}').scan({ cwd: path.join(ROOT, dir) })) {
                if (!rel.split('/').includes('node_modules')) files.push(path.posix.join(dir, rel));
            }
            return (await Promise.all(files.map(importsIn))).flat();
        }),
    )
).flat();

describe('integration tests, scripts and bin/', () => {
    test('import the packages only through their entries (. and ./protocol), never by a path into a package', () => {
        expect(OUTSIDE_IMPORTS.length).toBeGreaterThan(0);
        const wrong = OUTSIDE_IMPORTS.filter((i) =>
            i.resolved
                ? Object.values(MAP).some((m) => i.resolved!.startsWith(`${m.dir}/`))
                : i.specifier.startsWith('@domaintrail/') && !(EXPORTS as readonly string[]).includes(foreign('', i)!.entry),
        );
        expect(show(wrong)).toEqual([]);
    });
});

// ---- where the code runs: not boundaries between packages, but what each package may run on -------------------

describe('runtimes', () => {
    test('collaboration runs on Node: only its infrastructure imports node:*, and nothing but the generated bun tests imports bun', () => {
        const runtime = IMPORTS.collaboration.filter((i) => !i.file.startsWith('contexts/collaboration/src/generated/tests/'));
        expect(show(runtime.filter((i) => i.specifier === 'bun' || i.specifier.startsWith('bun:')))).toEqual([]);
        expect(show(runtime.filter((i) => i.specifier.startsWith('node:') && !segments(i.file).includes('infrastructure')))).toEqual([]);
    });

    test('agent runs on Node: only its adapters import node:*, and nothing imports bun', () => {
        expect(show(IMPORTS.agent.filter((i) => i.specifier.startsWith('node:') && !segments(i.file).includes('adapters')))).toEqual([]);
        expect(show(IMPORTS.agent.filter((i) => i.specifier === 'bun' || i.specifier.startsWith('bun:')))).toEqual([]);
    });

    test('web runs in the browser: it imports no infrastructure/', () => {
        expect(show(IMPORTS.web.filter((imp) => reaches(imp, ['infrastructure'])))).toEqual([]);
    });
});
