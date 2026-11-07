// `bun run figures`: draws each figure of figures.json with `dt export svg` from its example workspace
// (examples/<guide>/<example>), into public/figures/<guide>/<name>.svg. A figure that cannot be drawn fails the run,
// and with it the site's build: no figure is ever left as a stand-in.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLES, SITE, dt } from './dt.ts';

/** A figure: the flags of `dt export svg` (`dt export svg --help`), and the example it is drawn from. */
export interface FigureSpec {
    readonly example: string;
    readonly storming: string;
    readonly stage?: string;
    readonly timeline?: string;
    readonly level: 'big-picture' | 'design';
    /** The flow drawn at the place (`dt export svg --flow`): every flow (default) or the main flows only. */
    readonly flow?: 'all' | 'main';
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
            // `dt export svg --help`: one flow, --flow or --timeline
            if (f.timeline && f.flow) throw new Error(`figures.json: "${guide}/${name}" sets a flow on a timeline`);
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
        ...(f.flow ? ['--flow', f.flow] : []),
        '--theme',
        f.theme ?? 'light',
        '--lang',
        f.lang ?? 'ja',
        ...(f.names ? ['--names', f.names] : []),
        ...(f.heading ? ['--heading'] : []),
        ...(f.legend ? ['--legend'] : []),
    ];
}

const guides = readManifest();
let failed = 0;
for (const [guide, figures] of Object.entries(guides)) {
    mkdirSync(join(OUT, guide), { recursive: true });
    for (const [name, f] of Object.entries(figures)) {
        const file = join(OUT, guide, `${name}.svg`);
        const ran = dt(['-r', join(EXAMPLES, guide, f.example), 'export', 'svg', ...exportArgs(f), '-o', file]);
        if (ran.code !== 0) {
            failed++;
            console.error(`FAIL ${guide}/${name}: ${ran.out.trim()}`);
        } else console.log(`drawn ${guide}/${name}`);
    }
}
if (failed > 0) process.exit(1);
