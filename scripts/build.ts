// Builds the npm package into dist/: the Live View page (dist/web) and the CLI bundled for Node (dist/dmtr.js).
// Dependencies stay external and are installed from package.json; the page's own dependencies are bundled.
import { chmod, rm } from 'node:fs/promises';
import * as path from 'node:path';

const ROOT = path.join(import.meta.dir, '..');
const DIST = path.join(ROOT, 'dist');

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
    entrypoints: [path.join(ROOT, 'bin', 'dmtr.ts')],
    outdir: DIST,
    naming: '[name].js',
    target: 'node',
    format: 'esm',
    packages: 'external',
    banner: '#!/usr/bin/env node',
});
await chmod(path.join(DIST, 'dmtr.js'), 0o755);
