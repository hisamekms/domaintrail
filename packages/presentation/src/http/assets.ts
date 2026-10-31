import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html;charset=utf-8',
    '.js': 'text/javascript;charset=utf-8',
    '.css': 'text/css;charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

/** The page built by `bun run build`: next to the bundled CLI when installed, `dist/web` when running from source. */
export function defaultWebDir(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const bundled = path.join(here, 'web');
    return existsSync(path.join(bundled, 'index.html')) ? bundled : path.resolve(here, '../../../dist/web');
}

export interface Asset {
    type: string;
    body: Buffer;
}

/** The files of the page by URL path (`/` is `index.html`). */
export type Assets = ReadonlyMap<string, Asset>;

/** Loads the whole page up front; only these files are ever served, so no request path reaches the file system. */
export async function loadAssets(dir: string): Promise<Assets> {
    if (!existsSync(path.join(dir, 'index.html'))) throw new Error(`Live View page not found in ${dir} (run \`bun run build\`)`);
    const assets = new Map<string, Asset>();
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const file = path.join(entry.parentPath, entry.name);
        const urlPath = '/' + path.relative(dir, file).split(path.sep).join('/');
        assets.set(urlPath, { type: CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream', body: await readFile(file) });
    }
    assets.set('/', assets.get('/index.html')!);
    return assets;
}
