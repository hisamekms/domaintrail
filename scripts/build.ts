// Builds the npm package into dist/: the Live View page (dist/web) and the CLI bundled for Node (dist/dt.js).
// The CLI's dependencies (the root package.json's `dependencies`) stay external and are installed with the package;
// the workspace packages (@domaintrail/*, private) and the page's own dependencies are bundled.
import { chmod, rm } from 'node:fs/promises';
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
    entrypoints: [path.join(ROOT, 'web', 'index.html')],
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
