// The boundaries of the workspace packages (ADR 0025) that the package graph cannot enforce by itself: the layers
// inside a package, which package may reach which infrastructure, that each package declares what it imports, and that
// a dependency declared in several manifests has one version (Dependabot updates them together; see ADR 0025).
// The isolated linker resolves only declared dependencies from a package's own node_modules, but a lookup that misses
// there walks up to the root's node_modules, which hold the CLI's dependencies and every @domaintrail/* package.
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Glob } from 'bun';

const ROOT = path.join(import.meta.dir, '..');

/** The workspace packages, their sources, and the @domaintrail/* packages each depends on (ADR 0025). */
const PACKAGES: Record<string, { dir: string; sources: string; dependsOn: string[] }> = {
    modeling: { dir: 'packages/modeling', sources: 'packages/modeling/src', dependsOn: [] },
    // the collaboration contracts and their implementation (ADR 0026): modeling, and visualization's types once it imports them
    collaboration: { dir: 'packages/collaboration', sources: 'packages/collaboration/src', dependsOn: ['modeling'] },
    workspace: { dir: 'packages/workspace', sources: 'packages/workspace/src', dependsOn: ['modeling'] },
    visualization: { dir: 'packages/visualization', sources: 'packages/visualization/src', dependsOn: ['modeling'] },
    presentation: { dir: 'packages/presentation', sources: 'packages/presentation/src', dependsOn: ['modeling', 'visualization'] },
    composition: {
        dir: 'packages/composition',
        sources: 'packages/composition/src',
        dependsOn: ['modeling', 'presentation', 'visualization', 'workspace'],
    },
    web: { dir: 'web', sources: 'web', dependsOn: ['modeling', 'visualization'] },
};

/** What collaboration may depend on, and who may depend on it (ADR 0026); its imports of visualization are types only. */
const COLLABORATION_REACHES = ['modeling', 'visualization'];
const COLLABORATION_USED_BY = ['agent', 'composition', 'presentation', 'web'];

/** Relative imports that leave their package: the CLI embeds the guide as text (bundled into dist/dt.js). */
const OUTSIDE_PACKAGE: Record<string, string[]> = {
    'packages/presentation/src/cli/main.ts': ['docs/guide.md'],
};

interface PackageJson {
    name: string;
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
}

/**
 * The module specifiers of a file's import and export declarations and dynamic imports. A declaration starts its
 * line, so the code that the generators write into template literals (`import * as fc from 'fast-check';`) is not one.
 */
function specifiers(source: string): { specifier: string; typeOnly: boolean }[] {
    const declarations = source.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[\w$*{},\s]+?\s+from\s+)?['"]([^'"]+)['"]/gm);
    const dynamic = source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g);
    return [
        ...[...declarations].map((m) => ({ specifier: m[2], typeOnly: m[1] !== undefined })),
        ...[...dynamic].map((m) => ({ specifier: m[1], typeOnly: false })),
    ];
}

async function importsOf(area: string): Promise<Import[]> {
    const { sources } = PACKAGES[area];
    const imports: Import[] = [];
    for await (const rel of new Glob('**/*.{ts,tsx}').scan({ cwd: path.join(ROOT, sources) })) {
        if (rel.split('/').includes('node_modules')) continue;
        const file = path.posix.join(sources, rel);
        for (const { specifier, typeOnly } of specifiers(await readFile(path.join(ROOT, file), 'utf8'))) {
            const resolved = specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)) : undefined;
            imports.push({ file, specifier, resolved, typeOnly });
        }
    }
    return imports;
}

const AREAS = Object.keys(PACKAGES);
const IMPORTS = Object.fromEntries(await Promise.all(AREAS.map(async (area) => [area, await importsOf(area)] as const)));
const MANIFESTS: Record<string, PackageJson> = Object.fromEntries(
    await Promise.all(AREAS.map(async (area) => [area, (await Bun.file(path.join(ROOT, PACKAGES[area].dir, 'package.json')).json()) as PackageJson] as const)),
);

/** The package name of a bare specifier (`@scope/name/sub` → `@scope/name`, `name/sub` → `name`). */
const packageName = (specifier: string): string =>
    specifier
        .split('/')
        .slice(0, specifier.startsWith('@') ? 2 : 1)
        .join('/');
const isBuiltin = (specifier: string): boolean => specifier.startsWith('node:') || specifier === 'bun' || specifier.startsWith('bun:');
/** The directory segments of a path (without the file name). */
const segments = (file: string): string[] => file.split('/').slice(0, -1);
/** The layer an import reaches: `domain`, `application` or `infrastructure` in its path, if any. */
const reaches = (imp: Import, layer: string): boolean => (imp.resolved ?? imp.specifier).split('/').includes(layer);
const show = (imps: Import[]): string[] => imps.map((i) => `${i.file}: ${i.specifier}`);

describe('workspace packages', () => {
    test('every package has sources and imports', () => {
        for (const area of AREAS) expect(IMPORTS[area].length).toBeGreaterThan(0);
    });

    test('each package is named after its area and declares exactly the @domaintrail/* packages of the graph', () => {
        for (const area of AREAS) {
            const manifest = MANIFESTS[area];
            expect(manifest.name).toBe(`@domaintrail/${area}`);
            const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((d) => d.startsWith('@domaintrail/'));
            expect({ area, declared: declared.sort() }).toEqual({ area, declared: PACKAGES[area].dependsOn.map((d) => `@domaintrail/${d}`).sort() });
        }
    });

    test('a package imports only builtins, itself and what its package.json declares', () => {
        for (const area of AREAS) {
            const manifest = MANIFESTS[area];
            const declared = new Set([manifest.name, ...Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })]);
            const undeclared = IMPORTS[area].filter((i) => !i.resolved && !isBuiltin(i.specifier) && !declared.has(packageName(i.specifier)));
            expect(show(undeclared)).toEqual([]);
        }
    });

    test('a third-party dependency has the same version spec in every manifest that declares it', async () => {
        const root = (await Bun.file(path.join(ROOT, 'package.json')).json()) as PackageJson;
        const manifests: [string, PackageJson][] = [
            ['package.json', root],
            ...AREAS.map((area) => [`${PACKAGES[area].dir}/package.json`, MANIFESTS[area]] as [string, PackageJson]),
        ];
        const specs = new Map<string, Map<string, string>>();
        for (const [file, manifest] of manifests) {
            for (const [name, spec] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
                if (name.startsWith('@domaintrail/')) continue;
                specs.set(name, (specs.get(name) ?? new Map<string, string>()).set(file, spec));
            }
        }
        expect([...specs.values()].some((byFile) => byFile.size > 1)).toBe(true);
        const drifted = [...specs]
            .filter(([, byFile]) => new Set(byFile.values()).size > 1)
            .map(([name, byFile]) => ({ name, specs: Object.fromEntries(byFile) }));
        expect(drifted).toEqual([]);
    });

    test('relative imports stay inside their package', () => {
        for (const area of AREAS) {
            const { sources } = PACKAGES[area];
            const outside = IMPORTS[area].filter((i) => i.resolved && !i.resolved.startsWith(`${sources}/`) && !OUTSIDE_PACKAGE[i.file]?.includes(i.resolved));
            expect(show(outside)).toEqual([]);
        }
    });
});

describe('layers', () => {
    const all = AREAS.flatMap((area) => IMPORTS[area].map((imp) => ({ area, imp })));

    test('no domain/ file imports application/ or infrastructure/', () => {
        const domain = all.filter(({ imp }) => segments(imp.file).includes('domain'));
        expect(domain.length).toBeGreaterThan(0);
        const wrong = domain.filter(({ imp }) => reaches(imp, 'application') || reaches(imp, 'infrastructure'));
        expect(show(wrong.map(({ imp }) => imp))).toEqual([]);
    });

    test('no application/ file imports node:*, chokidar, ws or elkjs', () => {
        const application = all.filter(({ imp }) => segments(imp.file).includes('application'));
        expect(application.length).toBeGreaterThan(0);
        const io = ['chokidar', 'ws', 'elkjs'];
        const wrong = application.filter(({ imp }) => imp.specifier.startsWith('node:') || io.includes(packageName(imp.specifier)));
        expect(show(wrong.map(({ imp }) => imp))).toEqual([]);
    });

    test("only composition imports another package's infrastructure/", () => {
        const wrong = all.filter(
            ({ area, imp }) =>
                area !== 'composition' &&
                imp.specifier.startsWith('@domaintrail/') &&
                packageName(imp.specifier) !== `@domaintrail/${area}` &&
                reaches(imp, 'infrastructure'),
        );
        expect(show(wrong.map(({ imp }) => imp))).toEqual([]);
    });

    test('web imports no infrastructure/', () => {
        expect(show(IMPORTS.web.filter((imp) => reaches(imp, 'infrastructure')))).toEqual([]);
    });

    test('presentation imports neither composition nor workspace', () => {
        const wrong = IMPORTS.presentation.filter((i) => ['@domaintrail/composition', '@domaintrail/workspace'].includes(packageName(i.specifier)));
        expect(show(wrong)).toEqual([]);
    });

    test('collaboration reaches only modeling and the types of visualization', () => {
        expect(PACKAGES.collaboration.dependsOn.filter((d) => !COLLABORATION_REACHES.includes(d))).toEqual([]);
        const wrong = IMPORTS.collaboration.filter(
            (i) =>
                i.specifier.startsWith('@domaintrail/') &&
                packageName(i.specifier) !== '@domaintrail/collaboration' &&
                !(packageName(i.specifier) === '@domaintrail/modeling' || (packageName(i.specifier) === '@domaintrail/visualization' && i.typeOnly)),
        );
        expect(show(wrong)).toEqual([]);
    });

    test('only agent, composition, presentation and web depend on collaboration', () => {
        const users = AREAS.filter((area) => PACKAGES[area].dependsOn.includes('collaboration'));
        expect(users.filter((area) => !COLLABORATION_USED_BY.includes(area))).toEqual([]);
    });

    test('modeling imports no other @domaintrail/* package', () => {
        expect(show(IMPORTS.modeling.filter((i) => i.specifier.startsWith('@domaintrail/')))).toEqual([]);
    });
});
