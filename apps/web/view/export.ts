// Exporting the diagram of a canvas as a file: a portable SVG (`portable-svg.ts`), or a PNG rasterized from it at twice
// its size on white. The page gives the builder what it cannot know itself: the light theme's colours (resolved from
// styles.css's custom properties), the page's font stacks, and a canvas's `measureText` to lay text out with. PDF is the
// print path (the browser's print dialog saves one). The options (the heading, the legend) are the viewer's, remembered.
import { useCallback, useState } from 'react';
import type { LaidOutGraph } from '@domaintrail/visualization';
import { legendContent, type LegendView } from '../legend';
import type { Messages } from '../i18n';
import type { Rect, Scene } from '../scene';
import { graphBounds } from './canvas';
import { PALETTE_VARS, portableSvg, type Fonts, type Palette, type PortableSvg, type Rgba, type TextMeasure } from './portable-svg';

/** What a canvas can export now: its diagram and what is said about it. */
export interface ExportTarget {
    graph: LaidOutGraph;
    /** The scene drawn (as the canvas draws it, without selection or hover). */
    scene: () => Scene;
    /** The line above the diagram (`sheetHeading`). */
    heading: string;
    legend: LegendView | null;
    /** The file's name without its extension (`exportFileName`). */
    fileName: (ext: 'png' | 'svg') => string;
}

/** What an export (and a print, for the legend) includes besides the diagram: the viewer's choice, remembered. */
export interface ExportOptions {
    /** The heading line, in a PNG or SVG (a printed sheet always has it). */
    heading: boolean;
    /** The view's legend, under the diagram (printed too). */
    legend: boolean;
}

export const EXPORT_OPTIONS_KEY = 'domaintrail.export';
const DEFAULT_OPTIONS: ExportOptions = { heading: false, legend: false };

/** The options stored in `storage` (the defaults, off, for anything missing or unreadable). */
export function readExportOptions(storage: Pick<Storage, 'getItem'> | undefined): ExportOptions {
    try {
        const raw = storage?.getItem(EXPORT_OPTIONS_KEY);
        const saved: unknown = raw ? JSON.parse(raw) : undefined;
        if (!saved || typeof saved !== 'object') return DEFAULT_OPTIONS;
        const value = (key: keyof ExportOptions): boolean => {
            const v: unknown = Reflect.get(saved, key);
            return typeof v === 'boolean' ? v : DEFAULT_OPTIONS[key];
        };
        return { heading: value('heading'), legend: value('legend') };
    } catch {
        return DEFAULT_OPTIONS;
    }
}

/** Stores the options (nothing when the storage is unavailable). */
export function writeExportOptions(storage: Pick<Storage, 'setItem'> | undefined, options: ExportOptions): void {
    try {
        storage?.setItem(EXPORT_OPTIONS_KEY, JSON.stringify(options));
    } catch {
        // storage unavailable (private mode, etc.)
    }
}

const browserStorage = (): Storage | undefined => (typeof localStorage === 'undefined' ? undefined : localStorage);

/** The export options and their setter, remembered per browser. */
export function useExportOptions(): [ExportOptions, (options: ExportOptions) => void] {
    const [options, setOptions] = useState(() => readExportOptions(browserStorage()));
    const set = useCallback((next: ExportOptions) => {
        setOptions(next);
        writeExportOptions(browserStorage(), next);
    }, []);
    return [options, set];
}

/** Room around the diagram in an export (the builder adds its own margin around everything). */
const EXPORT_MARGIN = 8;

/** The part of the page an export shows: everything the graph draws, with a little room for the marks on its boxes. */
export function exportBounds(graph: LaidOutGraph): Rect {
    const b = graphBounds(graph) ?? { x: 0, y: 0, w: 1, h: 1 };
    return { x: b.x - EXPORT_MARGIN, y: b.y - EXPORT_MARGIN - 4, w: b.w + 2 * EXPORT_MARGIN, h: b.h + 2 * EXPORT_MARGIN + 4 };
}

/** A PNG's pixels per px of the diagram (twice, for sharp text). */
export const PNG_SCALE = 2;
/** The largest canvas a browser draws reliably: per side, and in all. */
const MAX_SIDE = 16384;
const MAX_PIXELS = 64 * 1024 * 1024;

/**
 * The scale a PNG of `width` × `height` px is rasterized at: twice, unless the canvas would be larger than a browser
 * draws (a long storming): then as large as it can be.
 */
export function pngScale(width: number, height: number): number {
    const fit = Math.min(MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_PIXELS / (width * height)));
    return Math.min(PNG_SCALE, fit);
}

/** A CSS colour (any syntax the page's CSS uses) as `#rrggbb` and an opacity, read back from a canvas. */
function rgba(ctx: CanvasRenderingContext2D, css: string): Rgba {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 255] = ctx.getImageData(0, 0, 1, 1).data;
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    return { hex, alpha: Math.round((a / 255) * 100) / 100 };
}

/**
 * The light theme's colours and the page's fonts, as styles.css sets them. The theme is switched to light and back
 * within this call: the browser draws nothing in between.
 */
export function pageStyle(): { palette: Palette; fonts: Fonts } {
    const root = document.documentElement;
    const theme = root.dataset.theme;
    root.dataset.theme = 'light';
    const probe = document.createElement('div');
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    try {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an entry for every one of PALETTE_VARS
        const palette = Object.fromEntries(
            PALETTE_VARS.map((v) => {
                probe.style.color = `var(${v})`;
                return [v, rgba(ctx, getComputedStyle(probe).color)];
            }),
        ) as Palette;
        const style = getComputedStyle(root);
        const fonts = { sans: style.getPropertyValue('--sans').trim() || 'sans-serif', mono: style.getPropertyValue('--mono').trim() || 'monospace' };
        return { palette, fonts };
    } finally {
        probe.remove();
        if (theme === undefined) delete root.dataset.theme;
        else root.dataset.theme = theme;
    }
}

/** Measures text with a canvas, in the fonts the page draws with. */
export function canvasMeasure(): TextMeasure {
    const ctx = document.createElement('canvas').getContext('2d')!;
    const widths = new Map<string, number>();
    const metrics = new Map<string, { ascent: number; descent: number }>();
    const use = (font: { family: string; size: number; weight?: number }): string => {
        const spec = `${font.weight ?? 400} ${font.size}px ${font.family}`;
        ctx.font = spec;
        return spec;
    };
    return {
        width: (text, font) => {
            const key = `${font.weight ?? 400}|${font.size}|${font.family}|${text}`;
            let w = widths.get(key);
            if (w === undefined) {
                use(font);
                w = ctx.measureText(text).width;
                widths.set(key, w);
            }
            return w;
        },
        metrics: (font) => {
            const spec = use(font);
            let m = metrics.get(spec);
            if (!m) {
                const t = ctx.measureText('Mあ');
                m = { ascent: t.fontBoundingBoxAscent, descent: t.fontBoundingBoxDescent };
                metrics.set(spec, m);
            }
            return m;
        },
    };
}

/** The target drawn as a portable SVG, with the heading and the legend if asked. */
export function exportSvg(target: ExportTarget, options: ExportOptions, t: Messages): PortableSvg {
    const { palette, fonts } = pageStyle();
    return portableSvg({
        scene: target.scene(),
        bounds: exportBounds(target.graph),
        heading: options.heading ? target.heading : undefined,
        legend: options.legend && target.legend ? { title: t.legend, content: legendContent(target.legend, t), kindNames: t.esKinds } : undefined,
        palette,
        fonts,
        measure: canvasMeasure(),
    });
}

/** A portable SVG rasterized to a PNG on white, at `pngScale` (an SVG of plain shapes never taints the canvas). */
export async function rasterize(drawn: PortableSvg): Promise<Blob> {
    const scale = pngScale(drawn.width, drawn.height);
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(drawn.svg)}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(drawn.width * scale);
    canvas.height = Math.round(drawn.height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
}

/** Saves `blob` as a file named `name` (the browser's download). */
export function download(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Exports the target as a PNG or an SVG file. */
export async function exportDiagram(format: 'png' | 'svg', target: ExportTarget, options: ExportOptions, t: Messages): Promise<void> {
    // the page's fonts, as the canvas lays text out with them
    await document.fonts.ready;
    const drawn = exportSvg(target, options, t);
    const blob = format === 'svg' ? new Blob([drawn.svg], { type: 'image/svg+xml' }) : await rasterize(drawn);
    download(blob, target.fileName(format));
}
