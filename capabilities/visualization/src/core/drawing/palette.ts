// The colours and fonts of a drawing outside the browser, read from the Live View's stylesheet (styles.css): its
// custom properties of the light theme (`:root`) and of the dark one (`:root[data-theme='dark']`, over the light), each
// followed through its `var()`s to a colour. The page reads the same properties from the browser (`pageStyle`); this
// reads them from the text, so that `dt export svg` draws in the page's colours without a copy of them.
import { PALETTE_VARS, type Fonts, type Palette, type Rgba } from './portable-svg.js';

/** The Live View's themes, as its stylesheet has them. */
export type DiagramTheme = 'light' | 'dark';

/** The stylesheet's custom properties, by theme (the dark theme's over the light's). */
export interface StyleTokens {
    readonly light: ReadonlyMap<string, string>;
    readonly dark: ReadonlyMap<string, string>;
}

const LIGHT_BLOCK = ':root {';
const DARK_BLOCK = ":root[data-theme='dark'] {";

/** The custom properties declared directly in the block that opens with `opening` (up to its closing brace). */
function block(css: string, opening: string): Map<string, string> {
    const start = css.indexOf(opening);
    if (start < 0) throw new Error(`styles.css has no block ${opening}`);
    const body = css.slice(start + opening.length, css.indexOf('\n}', start)).replace(/\/\*[\s\S]*?\*\//g, '');
    return new Map([...body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!.trim()]));
}

/** The light and dark themes' custom properties of a stylesheet. */
export function styleTokens(css: string): StyleTokens {
    const light = block(css, LIGHT_BLOCK);
    return { light, dark: new Map([...light, ...block(css, DARK_BLOCK)]) };
}

/** A colour with its channels in 0–1 and its opacity, before it is written as an `Rgba`. */
interface Colour {
    r: number;
    g: number;
    b: number;
    a: number;
}

const TRANSPARENT: Colour = { r: 0, g: 0, b: 0, a: 0 };

/** Splits the arguments of a CSS function at its top-level commas. */
function args(s: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of s) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
            out.push(current.trim());
            current = '';
        } else current += ch;
    }
    out.push(current.trim());
    return out;
}

function hsl(h: number, s: number, l: number): Omit<Colour, 'a'> {
    const k = (n: number): number => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return { r: f(0), g: f(8), b: f(4) };
}

/**
 * The colour a token's value resolves to: `#rgb` / `#rrggbb`, `rgb()` / `rgba()`, `hsl()`, `transparent`, `var()` of
 * another token, and `color-mix(in srgb, …)` of those (mixed with premultiplied alpha, as CSS does).
 */
function colour(value: string, tokens: ReadonlyMap<string, string>, seen: readonly string[] = []): Colour {
    const v = value.trim();
    const ref = /^var\((--[a-z0-9-]+)\)$/.exec(v);
    if (ref) {
        const name = ref[1]!;
        const next = tokens.get(name);
        if (next === undefined || seen.includes(name)) throw new Error(`styles.css: ${name} is not a colour it defines`);
        return colour(next, tokens, [...seen, name]);
    }
    if (v === 'transparent') return TRANSPARENT;
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
    if (hex) {
        const h = hex[1]!.length === 3 ? hex[1]!.replace(/./g, (c) => c + c) : hex[1]!;
        return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255, a: 1 };
    }
    const fn = /^([a-z-]+)\((.*)\)$/s.exec(v);
    if (fn) {
        const parts = args(fn[2]!);
        const n = (s: string): number => parseFloat(s);
        switch (fn[1]) {
            case 'rgb':
            case 'rgba':
                return { r: n(parts[0]!) / 255, g: n(parts[1]!) / 255, b: n(parts[2]!) / 255, a: parts[3] === undefined ? 1 : n(parts[3]) };
            case 'hsl':
            case 'hsla':
                return { ...hsl(n(parts[0]!), n(parts[1]!) / 100, n(parts[2]!) / 100), a: parts[3] === undefined ? 1 : n(parts[3]) };
            case 'color-mix':
                if (parts[0] === 'in srgb' && parts.length === 3) return mix(parts[1]!, parts[2]!, tokens, seen);
        }
    }
    throw new Error(`styles.css: cannot read the colour ${v}`);
}

/** `color-mix(in srgb, a, b)`: each side a colour and maybe a percentage; a missing one is the rest of 100%. */
function mix(a: string, b: string, tokens: ReadonlyMap<string, string>, seen: readonly string[]): Colour {
    const side = (s: string): { c: Colour; p?: number } => {
        const m = /^(.*?)\s+([\d.]+)%$/.exec(s);
        return m ? { c: colour(m[1]!, tokens, seen), p: parseFloat(m[2]!) / 100 } : { c: colour(s, tokens, seen) };
    };
    const [x, y] = [side(a), side(b)];
    const p = x.p ?? (y.p === undefined ? 0.5 : 1 - y.p);
    const q = y.p ?? 1 - p;
    const alpha = x.c.a * p + y.c.a * q;
    if (alpha === 0) return TRANSPARENT;
    const channel = (k: 'r' | 'g' | 'b'): number => (x.c[k] * x.c.a * p + y.c[k] * y.c.a * q) / alpha;
    return { r: channel('r'), g: channel('g'), b: channel('b'), a: alpha };
}

/** A colour as SVG 1.1 takes it: 8-bit channels, and the opacity to two decimals (as the page reads one back). */
function rgba(c: Colour): Rgba {
    const byte = (x: number): string =>
        Math.round(Math.min(1, Math.max(0, x)) * 255)
            .toString(16)
            .padStart(2, '0');
    return { hex: `#${byte(c.r)}${byte(c.g)}${byte(c.b)}`, alpha: Math.round(c.a * 100) / 100 };
}

/** The colour of one token in a theme. */
export function tokenColour(tokens: StyleTokens, theme: DiagramTheme, name: string): Rgba {
    const map = tokens[theme];
    return rgba(colour(`var(${name})`, map));
}

/** The palette of a theme: every colour the drawing takes (`PALETTE_VARS`). */
export function stylePalette(tokens: StyleTokens, theme: DiagramTheme): Palette {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an entry for every one of PALETTE_VARS
    return Object.fromEntries(PALETTE_VARS.map((v) => [v, tokenColour(tokens, theme, v)])) as Palette;
}

/** The page's font stacks (`--sans`, `--mono`). */
export function styleFonts(tokens: StyleTokens): Fonts {
    return { sans: tokens.light.get('--sans') ?? 'sans-serif', mono: tokens.light.get('--mono') ?? 'monospace' };
}
