import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { APIRoute } from 'astro';

// the Live View's favicon (apps/web/favicon.svg: the brand's mark, its strokes following the OS's scheme), served as is;
// the build runs in site/
export const GET: APIRoute = async (): Promise<Response> =>
    new Response(await readFile(resolve(process.cwd(), '../apps/web/favicon.svg')), { headers: { 'Content-Type': 'image/svg+xml' } });
