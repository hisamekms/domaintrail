// The last step of `bun run build`: reads the built site (dist/) and fails when
// - a link or an image of a page points to nothing in the site (a page, a file, or a heading of that page), or
// - Markdown reached the page as text: a literal `**` or `*…*` in what a reader sees (code aside), the sign of emphasis
//   that was not parsed (CommonMark's flanking rules next to Japanese punctuation, or Markdown in a component's prop).
//
// SITE_BASE is the base path the site was built with (astro.config.mjs); links outside it are not the site's.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SITE } from './dt.ts';

const DIST = join(SITE, 'dist');
const BASE = `/${(process.env.SITE_BASE ?? '/').replace(/^\/|\/$/g, '')}/`.replace(/^\/\/$/, '/');

function htmlFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
        const path = join(dir, d.name);
        return d.isDirectory() ? htmlFiles(path) : d.name.endsWith('.html') ? [path] : [];
    });
}

/** The page's URL path under the base, from its file (`event-storming/index.html` → `/base/event-storming/`). */
const pageUrl = (file: string): string =>
    `${BASE}${relative(DIST, file)
        .replace(/index\.html$/, '')
        .replace(/\\/g, '/')}`;

/** The file a site path is served from, or undefined. */
function fileOf(path: string): string | undefined {
    if (!path.startsWith(BASE)) return undefined;
    const rest = decodeURIComponent(path.slice(BASE.length));
    const direct = join(DIST, rest);
    if (existsSync(direct) && statSync(direct).isFile()) return direct;
    const index = join(DIST, rest, 'index.html');
    return existsSync(index) ? index : undefined;
}

const idsCache = new Map<string, Set<string>>();
function idsOf(file: string): Set<string> {
    let ids = idsCache.get(file);
    if (!ids) {
        ids = new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? ''));
        idsCache.set(file, ids);
    }
    return ids;
}

/** What a reader sees: the text of the page, without scripts, styles and code. */
const visibleText = (html: string): string =>
    html
        .replace(/<(script|style|code|pre)\b[^>]*>[\s\S]*?<\/\1>/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&ast;/g, '*');

const problems: string[] = [];
const files = htmlFiles(DIST);
for (const file of files) {
    const html = readFileSync(file, 'utf8');
    const page = pageUrl(file);
    const where = relative(DIST, file);
    const text = visibleText(html);
    for (const m of text.matchAll(/.{0,20}(?:\*\*|(?<![\w*])\*[^\s*][^*\n]{0,80}\*(?![\w*])).{0,20}/g))
        problems.push(`${where}: Markdown left as text: …${m[0].trim()}…`);
    for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
        const raw = (m[1] ?? '').replace(/&amp;/g, '&');
        if (/^(?:[a-z]+:|\/\/)/i.test(raw)) continue;
        const [pathPart = '', fragment] = raw.split('#');
        const url = new URL(pathPart || page, `http://site${page}`);
        if (!url.pathname.startsWith(BASE)) {
            problems.push(`${where}: ${raw} is outside the site's base (${BASE})`);
            continue;
        }
        const target = fileOf(url.pathname);
        if (!target) {
            problems.push(`${where}: ${raw} points to nothing`);
            continue;
        }
        if (fragment && target.endsWith('.html') && !idsOf(target).has(decodeURIComponent(fragment)))
            problems.push(`${where}: ${raw}: no heading or element #${decodeURIComponent(fragment)}`);
    }
}
if (problems.length > 0) {
    console.error(problems.join('\n'));
    console.error(`check-dist: ${problems.length} problem(s) in ${files.length} pages`);
    process.exit(1);
}
console.log(`check-dist: ${files.length} pages, every link resolves, no Markdown left as text`);
