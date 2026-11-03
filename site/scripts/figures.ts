// `bun run figures`: draws each figure of figures.json with `dt export svg` from its example workspace
// (examples/<guide>/<example>), into public/figures/<guide>/<name>.svg. While this `dt` has no `dt export svg`, it
// writes a placeholder instead (marked as one, with the figure's name and the command that will draw it), so that the
// site builds.
//
//   bun run figures            every figure
//   bun run figures --strict   fail when `dt export svg` is missing (the workflow, once it is on main)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLES, SITE, dt } from './dt.ts';

/** A figure: the flags of `dt export svg` (`dt export svg --help`), and the example it is drawn from. */
export interface FigureSpec {
    readonly example: string;
    readonly storming: string;
    readonly stage?: string;
    readonly timeline?: string;
    readonly level: 'big-picture' | 'design';
    readonly exceptions?: 'show' | 'hide';
    readonly theme?: 'light' | 'dark';
    readonly lang?: 'ja' | 'en';
    readonly names?: 'label' | 'name' | 'both';
    readonly heading?: boolean;
    readonly legend?: boolean;
}

type Manifest = Record<string, Record<string, FigureSpec>>;

const OUT = join(SITE, 'public', 'figures');
const LEVELS: readonly string[] = ['big-picture', 'design'];

function readManifest(): Manifest {
    const raw: unknown = JSON.parse(readFileSync(join(SITE, 'figures.json'), 'utf8'));
    if (typeof raw !== 'object' || raw === null || !('guides' in raw) || typeof raw.guides !== 'object' || raw.guides === null)
        throw new Error('figures.json: no "guides" object');
    const guides: Manifest = {};
    for (const [guide, value] of Object.entries(raw.guides)) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the manifest is ours; each entry is checked below
        const figures = (value as { figures: Record<string, FigureSpec> }).figures;
        for (const [name, f] of Object.entries(figures)) {
            if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`figures.json: "${guide}/${name}" is not a file name (a-z, 0-9, -)`);
            if (!f.example || !f.storming || !LEVELS.includes(f.level))
                throw new Error(`figures.json: "${guide}/${name}" needs example, storming and level (${LEVELS.join(' | ')})`);
            if (f.stage && f.timeline) throw new Error(`figures.json: "${guide}/${name}" names both a stage and a timeline`);
        }
        guides[guide] = figures;
    }
    return guides;
}

/** The flags of `dt export svg` for a figure, without the output (`-o`). */
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
        '--lang',
        f.lang ?? 'ja',
        ...(f.names ? ['--names', f.names] : []),
        ...(f.heading ? ['--heading'] : []),
        ...(f.legend ? ['--legend'] : []),
    ];
}

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A figure that is not drawn yet: a dashed sheet with its name and the command that will draw it. */
function placeholder(name: string, example: string, args: readonly string[]): string {
    // the flags with their values, on one line under the command
    const pairs = args.reduce<string[]>((acc, a) => (a.startsWith('--') ? [...acc, a] : [...acc.slice(0, -1), `${acc.at(-1)} ${a}`]), []);
    const lines = [`dt -r examples/${example} export svg`, pairs.join('  ')];
    return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="300" viewBox="0 0 960 300" role="img" aria-label="placeholder: ${escape(name)}">
  <rect x="1" y="1" width="958" height="298" rx="12" fill="#f8f9fc" stroke="#c7cbf0" stroke-width="2" stroke-dasharray="10 8"/>
  <text x="480" y="104" text-anchor="middle" font-family="ui-monospace, Menlo, monospace" font-size="15" font-weight="700" fill="#a15c07">PLACEHOLDER — dt export svg is not available yet</text>
  <text x="480" y="146" text-anchor="middle" font-family="ui-monospace, Menlo, monospace" font-size="26" font-weight="700" fill="#4338ca">${escape(name)}</text>
  ${lines.map((l, i) => `<text x="480" y="${196 + i * 22}" text-anchor="middle" font-family="ui-monospace, Menlo, monospace" font-size="13" fill="#4d526e">${escape(l)}</text>`).join('\n  ')}
</svg>
`;
}

function exportSvgAvailable(): boolean {
    const help = dt(['export', 'svg', '--help']);
    return help.code === 0 && /svg/i.test(help.out);
}

const strict = process.argv.includes('--strict');
const guides = readManifest();
const available = exportSvgAvailable();
if (!available && strict) {
    console.error('dt export svg is not available in this dt');
    process.exit(1);
}
let failed = 0;
for (const [guide, figures] of Object.entries(guides)) {
    mkdirSync(join(OUT, guide), { recursive: true });
    for (const [name, f] of Object.entries(figures)) {
        const file = join(OUT, guide, `${name}.svg`);
        const args = exportArgs(f);
        if (!available) {
            writeFileSync(file, placeholder(`${guide}/${name}`, `${guide}/${f.example}`, args));
            console.log(`placeholder ${guide}/${name}`);
            continue;
        }
        const ran = dt(['-r', join(EXAMPLES, guide, f.example), 'export', 'svg', ...args, '-o', file]);
        if (ran.code !== 0) {
            failed++;
            console.error(`FAIL ${guide}/${name}: ${ran.out.trim()}`);
        } else console.log(`drawn ${guide}/${name}`);
    }
}
if (!available) console.log('dt export svg is not available yet: the figures are placeholders');
if (failed > 0) process.exit(1);
