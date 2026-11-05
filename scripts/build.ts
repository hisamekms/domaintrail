// Builds the npm package into dist/: the Live View page (dist/web), the CLI bundled for Node (dist/dt.js),
// `domaintrail/testing`, the support of the generated contract tests (dist/testing.js, with dist/testing.d.ts), and the
// knowledge store's Worker template that users deploy (dist/knowledge-worker: worker.js, wrangler.jsonc, migrations/,
// README.md, and page/, the Worker's read-only page built from apps/web/published; ADR 0031).
// The CLI's dependencies (the root package.json's `dependencies`) stay external and are installed with the package;
// the workspace packages (@domaintrail/*, private) and the page's own dependencies are bundled. fast-check, which
// `domaintrail/testing` imports, is the user's project's (an optional peer dependency).
import { chmod, cp, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import pkg from '../package.json' with { type: 'json' };

const ROOT = path.join(import.meta.dir, '..');
const DIST = path.join(ROOT, 'dist');
// a package and its subpaths (`langium/lsp`, `elkjs/lib/elk-api.js`)
const EXTERNAL = Object.keys(pkg.dependencies).flatMap((name) => [name, `${name}/*`]);

async function build(config: Bun.BuildConfig): Promise<void> {
    const result = await Bun.build(config);
    if (!result.success) {
        for (const log of result.logs) console.error(log);
        process.exit(1);
    }
}

await rm(DIST, { recursive: true, force: true });

await build({
    entrypoints: [path.join(ROOT, 'apps', 'web', 'index.html')],
    outdir: path.join(DIST, 'web'),
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
});

await build({
    entrypoints: [path.join(ROOT, 'bin', 'dt.ts')],
    outdir: DIST,
    naming: '[name].js',
    target: 'node',
    format: 'esm',
    external: EXTERNAL,
    banner: '#!/usr/bin/env node',
});
await chmod(path.join(DIST, 'dt.js'), 0o755);

await build({
    entrypoints: [path.join(ROOT, 'testing', 'index.ts')],
    outdir: DIST,
    naming: 'testing.js',
    target: 'node',
    format: 'esm',
    external: ['fast-check'],
});
// its declarations, emitted by tsc into a temporary directory (under testing/, since it imports ../package.json)
const types = await mkdtemp(path.join(tmpdir(), 'domaintrail-types-'));
const tsc = Bun.spawnSync(
    [
        process.execPath,
        path.join(ROOT, 'node_modules', '.bin', 'tsc'),
        '--ignoreConfig',
        '--declaration',
        '--emitDeclarationOnly',
        '--strict',
        '--skipLibCheck',
        '--resolveJsonModule',
        '--target',
        'ES2023',
        '--module',
        'preserve',
        '--moduleResolution',
        'bundler',
        '--types',
        '',
        '--rootDir',
        ROOT,
        '--outDir',
        types,
        path.join(ROOT, 'testing', 'index.ts'),
    ],
    { cwd: ROOT },
);
if (tsc.exitCode !== 0) {
    console.error(tsc.stdout.toString() + tsc.stderr.toString());
    process.exit(1);
}
await rename(path.join(types, 'testing', 'index.d.ts'), path.join(DIST, 'testing.d.ts'));
await rm(types, { recursive: true, force: true });

// the knowledge store's Worker: bundled whole (with the knowledge context's decisions) for workerd, beside the files of
// its template; the user's `wrangler deploy` takes worker.js as it is
const WORKER = path.join(ROOT, 'apps', 'knowledge-worker');
await build({
    entrypoints: [path.join(WORKER, 'src', 'worker.ts')],
    outdir: path.join(DIST, 'knowledge-worker'),
    naming: 'worker.js',
    target: 'browser',
    format: 'esm',
    banner: `// The knowledge store's Worker of DomainTrail ${pkg.version} (ADR 0031), built from apps/knowledge-worker. Do not edit.`,
});
await cp(path.join(WORKER, 'template'), path.join(DIST, 'knowledge-worker'), { recursive: true });

// the Worker's read-only page (ADR 0031, section 11): a second entry of the Live View's code (its canvas and knowledge
// panels, read-only), served by the Worker as static assets, so that worker.js stays the API alone
await build({
    entrypoints: [path.join(ROOT, 'apps', 'web', 'published', 'index.html')],
    outdir: path.join(DIST, 'knowledge-worker', 'page'),
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
});
