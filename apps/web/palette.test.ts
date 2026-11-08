// The text tokens' contrast on the surfaces, read from styles.css: WCAG 2 (4.5:1) and APCA (0.0.98G-4g) for the text,
// the secondary text and the quietest text (muted), in both themes. The values come from the CSS variables (the dark
// block overrides the root one, and var() chains are followed to a hex primitive).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const styles = readFileSync(join(import.meta.dir, 'styles.css'), 'utf8');

type Theme = 'light' | 'dark';

/** The custom properties declared directly in the block that opens with `opening` (up to its closing brace). */
function block(opening: string): Map<string, string> {
    const start = styles.indexOf(opening);
    if (start < 0) throw new Error(`no block ${opening}`);
    const body = styles.slice(start + opening.length, styles.indexOf('\n}', start));
    return new Map([...body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]));
}

const root = block(':root {');
const dark = block(":root[data-theme='dark'] {");

/** The hex colour a token resolves to in a theme. */
function resolve(token: string, theme: Theme): string {
    const value = (theme === 'dark' ? dark.get(token) : undefined) ?? root.get(token);
    if (value === undefined) throw new Error(`no ${token}`);
    const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value);
    if (ref) return resolve(ref[1], theme);
    if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${token} is not a hex colour: ${value}`);
    return value;
}

function channels(hex: string): [number, number, number] {
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** WCAG 2 contrast ratio. */
function wcag(a: string, b: string): number {
    const lum = (hex: string): number => {
        const [r, g, bl] = channels(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

/** APCA 0.0.98G-4g lightness contrast (Lc) of a text on a background: positive dark on light, negative light on dark. */
function apca(text: string, bg: string): number {
    const y = (hex: string): number => {
        const [r, g, b] = channels(hex);
        const v = 0.2126729 * r ** 2.4 + 0.7151522 * g ** 2.4 + 0.072175 * b ** 2.4;
        return v > 0.022 ? v : v + (0.022 - v) ** 1.414;
    };
    const [yt, yb] = [y(text), y(bg)];
    if (Math.abs(yb - yt) < 0.0005) return 0;
    if (yb > yt) {
        const s = (yb ** 0.56 - yt ** 0.57) * 1.14;
        return s < 0.1 ? 0 : (s - 0.027) * 100;
    }
    const s = (yb ** 0.65 - yt ** 0.62) * 1.14;
    return s > -0.1 ? 0 : (s + 0.027) * 100;
}

const surfaces = ['--bg', '--surface', '--surface-muted'];

describe('the APCA helper', () => {
    test('matches the reference values of 0.0.98G-4g', () => {
        expect(apca('#888888', '#ffffff')).toBeCloseTo(63.06, 1);
        expect(apca('#ffffff', '#888888')).toBeCloseTo(-68.54, 1);
        expect(apca('#000000', '#aaaaaa')).toBeCloseTo(58.15, 1);
        expect(apca('#aaaaaa', '#000000')).toBeCloseTo(-56.24, 1);
    });
});

describe('the text tokens on the surfaces', () => {
    // the minimum |Lc| per theme, text role and surface (bg, surface, surface-muted); light muted is held to Lc 75 on
    // the panels' white and stays near it on the tinted bg and surface-muted
    const minimum: Record<Theme, Record<string, [number, number, number]>> = {
        light: { '--text': [90, 90, 90], '--text-secondary': [75, 75, 75], '--muted': [70, 75, 70] },
        dark: { '--text': [90, 90, 90], '--text-secondary': [75, 75, 75], '--muted': [60, 60, 60] },
    };
    for (const theme of ['light', 'dark'] as const) {
        for (const [text, levels] of Object.entries(minimum[theme])) {
            surfaces.forEach((surface, i) => {
                test(`${theme}: ${text} on ${surface} reaches APCA Lc ${levels[i]} and 4.5:1`, () => {
                    const [fg, bg] = [resolve(text, theme), resolve(surface, theme)];
                    expect(Math.abs(apca(fg, bg))).toBeGreaterThanOrEqual(levels[i]);
                    expect(wcag(fg, bg)).toBeGreaterThanOrEqual(4.5);
                });
            });
        }
    }
    test('dark: muted stays visibly quieter than the secondary text (at least Lc 10 apart)', () => {
        for (const surface of surfaces) {
            const bg = resolve(surface, 'dark');
            const secondary = Math.abs(apca(resolve('--text-secondary', 'dark'), bg));
            expect(secondary - Math.abs(apca(resolve('--muted', 'dark'), bg))).toBeGreaterThanOrEqual(10);
        }
    });
});

describe('a resolved hotspot', () => {
    // its label on its toned paper (4.5:1, and Lc 75 in light, 60 in dark: quieter than an open hotspot's, as the
    // theme's muted text is), the check on its disc (a symbol, held to 4.5:1 too)
    const lc: Record<Theme, number> = { light: 75, dark: 60 };
    for (const theme of ['light', 'dark'] as const) {
        test(`${theme}: its text reads on its toned paper, and its check on the green disc`, () => {
            const [text, paper] = [resolve('--es-hotspot-resolved-text', theme), resolve('--es-hotspot-resolved', theme)];
            expect(wcag(text, paper)).toBeGreaterThanOrEqual(4.5);
            expect(Math.abs(apca(text, paper))).toBeGreaterThanOrEqual(lc[theme]);
            expect(wcag(resolve('--es-resolved-mark-ink', theme), resolve('--es-resolved-mark', theme))).toBeGreaterThanOrEqual(4.5);
        });

        test(`${theme}: is quieter than an open hotspot (its edge and its \`on\` nearer the surface)`, () => {
            const surface = resolve('--surface', theme);
            expect(wcag(resolve('--es-hotspot-resolved-border', theme), surface)).toBeLessThan(wcag(resolve('--es-hotspot-border', theme), surface));
            expect(wcag(resolve('--es-hotspot-resolved-edge', theme), surface)).toBeLessThan(wcag(resolve('--model-edge-quiet', theme), surface));
            expect(wcag(resolve('--es-hotspot-resolved', theme), surface)).toBeLessThan(wcag(resolve('--es-hotspot', theme), surface));
        });
    }
});

describe('the actions of the detail of a storming element', () => {
    // an icon is held to the text's 4.5:1 (it carries the action's meaning alone, its name only in the tooltip)
    for (const theme of ['light', 'dark'] as const) {
        test(`${theme}: the brand icon reads on its pale wash and on the surface, and the primary's on the brand`, () => {
            expect(wcag(resolve('--brand', theme), resolve('--brand-wash', theme))).toBeGreaterThanOrEqual(4.5);
            expect(wcag(resolve('--brand', theme), resolve('--surface', theme))).toBeGreaterThanOrEqual(4.5);
            expect(wcag(resolve('--on-brand', theme), resolve('--brand', theme))).toBeGreaterThanOrEqual(4.5);
            // the wash stays a wash: nearer the surface than the brand is
            expect(wcag(resolve('--brand-wash', theme), resolve('--surface', theme))).toBeLessThan(1.5);
        });
    }
});
