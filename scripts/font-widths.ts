// Measures the Live View's fonts in a browser and writes the table `dt export svg` lays text out with
// (capabilities/visualization/src/core/drawing/font-widths.ts): the advance width of each character of a few ranges, in
// thousandths of an em, for the sans stack at 400, 600 and 700 and the mono stack at 400 and 600, and the ascent and
// descent of each stack. The page measures with a canvas's `measureText`; the table is what such a canvas measured on
// the machine this ran on (Chrome on macOS: Hiragino Sans and SF Mono), so that the CLI wraps text as the page does
// there. Run it again when styles.css's `--sans` or `--mono` changes:
//   PLAYWRIGHT=<path to the playwright package> bun scripts/font-widths.ts && bun run fmt
// Playwright is not a dependency of the repository: give the path of an installed one. It launches Chrome (`channel:
// 'chrome'`); it never downloads a browser.
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

const ROOT = path.join(import.meta.dir, '..');
const OUT = path.join(ROOT, 'capabilities', 'visualization', 'src', 'core', 'drawing', 'font-widths.ts');

/** The ranges of code points measured: Latin, punctuation, arrows, symbols and the half-width forms. */
const RANGES: readonly (readonly [number, number])[] = [
    [0x20, 0x7e],
    [0xa0, 0xff],
    [0x2010, 0x205e],
    [0x2190, 0x21ff],
    [0x2200, 0x22ff],
    [0x2460, 0x24ff],
    [0x2500, 0x25ff],
    [0x2600, 0x27bf],
    [0xff61, 0xff9f],
];
const SANS_WEIGHTS = [400, 600, 700] as const;
const MONO_WEIGHTS = [400, 600] as const;
/** The size measured at: large enough that a thousandth of an em is a whole pixel. */
const SIZE = 1000;

/** A custom property of styles.css's `:root`. */
function token(css: string, name: string): string {
    const m = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(css);
    if (!m) throw new Error(`styles.css has no ${name}`);
    return m[1]!.trim();
}

interface Measured {
    widths: Record<string, number[][]>;
    metrics: Record<'sans' | 'mono', { ascent: number; descent: number }>;
}

const css = await readFile(path.join(ROOT, 'apps', 'web', 'styles.css'), 'utf8');
const stacks = { sans: token(css, '--sans'), mono: token(css, '--mono') };
const module = process.env.PLAYWRIGHT;
if (!module) throw new Error('Set PLAYWRIGHT to the path of an installed playwright package.');
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- playwright is not a dependency: the part of it used here
const { chromium } = (await import(module)) as {
    chromium: { launch(o: object): Promise<{ newPage(): Promise<{ evaluate<T>(fn: (arg: never) => T, arg: unknown): Promise<T> }>; close(): Promise<void> }> };
};
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const measured = await page.evaluate(
    ((arg: { stacks: { sans: string; mono: string }; ranges: [number, number][]; size: number; fonts: [string, 'sans' | 'mono', number][] }): Measured => {
        const ctx = document.createElement('canvas').getContext('2d')!;
        const widths: Record<string, number[][]> = {};
        for (const [key, stack, weight] of arg.fonts) {
            ctx.font = `${weight} ${arg.size}px ${arg.stacks[stack]}`;
            widths[key] = arg.ranges.map(([from, to]) => {
                const row: number[] = [];
                for (let cp = from; cp <= to; cp++) row.push(Math.round(ctx.measureText(String.fromCodePoint(cp)).width));
                return row;
            });
        }
        const metric = (stack: 'sans' | 'mono'): { ascent: number; descent: number } => {
            ctx.font = `400 ${arg.size}px ${arg.stacks[stack]}`;
            const t = ctx.measureText('Mあ');
            return { ascent: Math.round(t.fontBoundingBoxAscent), descent: Math.round(t.fontBoundingBoxDescent) };
        };
        return { widths, metrics: { sans: metric('sans'), mono: metric('mono') } };
    }) as (arg: never) => Measured,
    {
        stacks,
        ranges: RANGES,
        size: SIZE,
        fonts: [...SANS_WEIGHTS.map((w) => [`sans${w}`, 'sans', w]), ...MONO_WEIGHTS.map((w) => [`mono${w}`, 'mono', w])],
    },
);
await browser.close();

/** A row of widths as two base-36 digits each (up to 1295 thousandths of an em), in lines of 64 characters. */
const encode = (row: readonly number[]): string[] => {
    const s = row.map((w) => Math.min(1295, w).toString(36).padStart(2, '0')).join('');
    const lines: string[] = [];
    for (let i = 0; i < s.length; i += 128) lines.push(s.slice(i, i + 128));
    return lines;
};
const hex = (n: number): string => `0x${n.toString(16)}`;
const table = Object.entries(measured.widths)
    .map(
        ([key, rows]) =>
            `    ${key}: [\n${rows
                .map(
                    (row) =>
                        `        [\n${encode(row)
                            .map((l) => `            '${l}',`)
                            .join('\n')}\n        ],`,
                )
                .join('\n')}\n    ],`,
    )
    .join('\n');
const source = `// Generated by scripts/font-widths.ts: do not edit. The advance widths of the Live View's fonts, as Chrome on macOS
// measured them, in thousandths of an em: per font, a row per range of \`FONT_RANGES\`, each character two base-36
// digits. The stacks:
//   sans: ${stacks.sans}
//   mono: ${stacks.mono}

/** The ranges of code points the table has, first and last. */
export const FONT_RANGES: readonly (readonly [number, number])[] = [${RANGES.map(([a, b]) => `[${hex(a)}, ${hex(b)}]`).join(', ')}];

/** The rows of widths of each font (\`sans400\`, \`sans600\`, \`sans700\`, \`mono400\`, \`mono600\`). */
export const FONT_WIDTHS: Readonly<Record<string, readonly (readonly string[])[]>> = {
${table}
};

/** The ascent and descent of each stack's lines, in thousandths of an em (a canvas's \`fontBoundingBox\` of \`Mあ\`). */
export const FONT_METRICS = {
    sans: { ascent: ${measured.metrics.sans.ascent}, descent: ${measured.metrics.sans.descent} },
    mono: { ascent: ${measured.metrics.mono.ascent}, descent: ${measured.metrics.mono.descent} },
} as const;
`;
await writeFile(OUT, source);
console.log(`wrote ${path.relative(ROOT, OUT)}`);
