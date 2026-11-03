// `bun run figures`: draws each figure of figures.json with `dt export svg` from its example workspace, into
// public/figures/<name>.svg. While this `dt` has no `dt export svg`, it writes a placeholder instead (marked as one,
// with the figure's name and the command that will draw it), so that the site builds.
//
//   bun run figures            every figure
//   bun run figures --strict   fail when `dt export svg` is missing (the workflow, once it exists)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLES, SITE, dt } from './dt.ts';

interface FigureSpec {
    readonly example: string;
    readonly storming: string;
    readonly stage?: string;
    readonly timeline?: string;
    readonly level: 'big-picture' | 'design-level';
    readonly exceptions?: 'show' | 'hide';
    readonly theme?: 'light' | 'dark';
}

const OUT = join(SITE, 'public', 'figures');

function readManifest(): Record<string, FigureSpec> {
    const raw: unknown = JSON.parse(readFileSync(join(SITE, 'figures.json'), 'utf8'));
    if (typeof raw !== 'object' || raw === null || !('figures' in raw) || typeof raw.figures !== 'object' || raw.figures === null)
        throw new Error('figures.json: no "figures" object');
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the manifest is ours; each entry is checked below
    const figures = raw.figures as Record<string, FigureSpec>;
    for (const [name, f] of Object.entries(figures)) {
        if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`figures.json: "${name}" is not a file name (a-z, 0-9, -)`);
        if (!f.example || !f.storming || !f.level) throw new Error(`figures.json: "${name}" needs example, storming and level`);
        if (f.stage && f.timeline) throw new Error(`figures.json: "${name}" names both a stage and a timeline`);
    }
    return figures;
}

/** The flags of `dt export svg` for a figure, without the output. */
export function exportArgs(f: FigureSpec): string[] {
    return [
        '--storming',
        f.storming,
        ...(f.stage ? ['--stage', f.stage] : []),
        ...(f.timeline ? ['--timeline', f.timeline] : []),
        '--level',
        f.level,
        ...(f.exceptions ? ['--exceptions', f.exceptions] : []),
        '--theme',
        f.theme ?? 'light',
    ];
}

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A figure that is not drawn yet: a dashed sheet with its name and the command that will draw it. */
function placeholder(name: string, example: string, args: readonly string[]): string {
    // the flags two by two, a line each, so that a long command fits
    const pairs = args.reduce<string[]>((acc, a) => (a.startsWith('--') ? [...acc, a] : [...acc.slice(0, -1), `${acc.at(-1)} ${a}`]), []);
    const lines = [`dt -r examples/${example} export svg`, pairs.join('  ')];
    return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="300" viewBox="0 0 960 300" role="img" aria-label="placeholder: ${escape(name)}">
  <rect x="1" y="1" width="958" height="298" rx="12" fill="#f8f9fc" stroke="#c7cbf0" stroke-width="2" stroke-dasharray="10 8"/>
  <text x="480" y="104" text-anchor="middle" font-family="ui-monospace, Menlo, monospace" font-size="15" font-weight="700" fill="#a15c07">PLACEHOLDER — dt export svg is not available yet</text>
  <text x="480" y="146" text-anchor="middle" font-family="ui-monospace, Menlo, monospace" font-size="26" font-weight="700" fill="#4338ca">${escape(name)}</text>
  ${lines.map((l, i) => `<text x="480" y="${196 + i * 22}" text-anchor="middle" font-family="ui-monospace, Menlo, monospace" font-size="14" fill="#4d526e">${escape(l)}</text>`).join('\n  ')}
</svg>
`;
}

function exportSvgAvailable(): boolean {
    const help = dt(['export', 'svg', '--help']);
    return help.code === 0 && /svg/i.test(help.out);
}

const strict = process.argv.includes('--strict');
const figures = readManifest();
mkdirSync(OUT, { recursive: true });
const available = exportSvgAvailable();
if (!available && strict) {
    console.error('dt export svg is not available in this dt');
    process.exit(1);
}
let failed = 0;
for (const [name, f] of Object.entries(figures)) {
    const file = join(OUT, `${name}.svg`);
    const args = exportArgs(f);
    if (!available) {
        writeFileSync(file, placeholder(name, f.example, args));
        console.log(`placeholder ${name}`);
        continue;
    }
    const ran = dt(['-r', join(EXAMPLES, f.example), 'export', 'svg', ...args, '-o', file]);
    if (ran.code !== 0) {
        failed++;
        console.error(`FAIL ${name}: ${ran.out.trim()}`);
    } else console.log(`drawn ${name}`);
}
if (!available) console.log('dt export svg is not available yet: the figures are placeholders');
if (failed > 0) process.exit(1);
