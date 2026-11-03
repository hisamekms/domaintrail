// The portable SVG (`@domaintrail/visualization`'s `portableSvg`, as the page exports it): plain, well-formed SVG of
// every kind of diagram, its notes' text laid out as the canvas fits it, its edges' heads as markers, and the heading
// and legend when asked.
import { afterAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
    breakUnits,
    createViewService,
    ElkLayoutEngine,
    ellipsize,
    noteText,
    PALETTE_VARS,
    portableSvg,
    wrapLines,
    xml,
    type Font,
    type LaidOutGraph,
    type Palette,
    type TextMeasure,
} from '@domaintrail/visualization';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import { MESSAGES } from '../i18n';
import { legendContent, legendKindNames } from '../legend';
import { fitLabel, NOTE_KINDS } from '../note-fit';
import { buildScene } from '../render';
import type { Scene } from '../scene';
import { exampleSources, viewPayloads } from '../test-helpers';
import { exportBounds } from './export';

/** Wide characters 1em, others 0.55em: a measure of fixed widths, as a canvas's would be of one font. */
const isWide = (ch: string): boolean => /[⺀-鿿가-힯豈-﫿︰-﹏＀-￯]/u.test(ch);
const measure: TextMeasure = {
    width: (text, font) => Array.from(text).reduce((w, ch) => w + (isWide(ch) ? 1 : 0.55) * font.size, 0),
    metrics: (font) => ({ ascent: 0.88 * font.size, descent: 0.12 * font.size }),
};
const palette = Object.fromEntries(
    PALETTE_VARS.map((v, i) => [v, { hex: `#${(i * 4).toString(16).padStart(2, '0')}2030`, alpha: v === '--context-bg' ? 0.6 : 1 }]),
) as Palette;
const fonts = { sans: "'Hiragino Sans', sans-serif", mono: 'ui-monospace, monospace' };

const engine = new ElkLayoutEngine();
afterAll(() => engine.dispose());

const STAGES = await readFile(path.join(import.meta.dir, '..', '..', '..', 'test', 'fixtures', 'stages', 'convenience-store-stages.dtes'), 'utf8');
/** The stages' fixture with a few notes of Design Level: an actor, an external system, a read model, an aggregate, commands and a policy. */
const NOTES = `
  actor Resident "住民"
  external MunicipalSystem "市区町村のシステム"
  readmodel FeeTable "手数料の一覧"
  aggregate Certificate "証明書"
  command IssueCertificate "証明書を発行する（マルチコピー機で、暗証番号を入力してから、内容と部数と手数料を確かめたうえで）" {
    actor Resident
    reads FeeTable
    target Certificate
    emits CertificateIssuedAtMultiCopier
  }
  command CreateCertificateData "証明書データを作る" {
    actor MunicipalSystem
    emits CertificateDataCreated
  }
  policy IssueAfterPayment "手数料が払われたら発行する" {
    on FeePaid
    issues IssueCertificate
  }
`;
const stagesWithNotes = STAGES.replace(/\n\s*stage Preparation /, `\n${NOTES}  stage Preparation `);

async function stormingGraph(): Promise<LaidOutGraph> {
    const service = createViewService({
        root: '/workspace',
        engine,
        workspace: { readSources: async () => [{ path: 'stages.dtes', text: stagesWithNotes }] },
        layoutStore: { load: async () => new Map(), save: async () => {} },
        git: {
            resolveCommit: (ref) => Promise.reject(new Error(`no git: ${ref}`)),
            sourcesAt: async () => [],
            listRefs: async () => ({ branches: [], tags: [], commits: [] }),
            gitDirs: async () => undefined,
        },
    });
    const { stormings } = await service.refresh();
    return stormings[0]!.views['design-level|@Issuance']!.graph;
}

const shop: ViewPayload = (await viewPayloads(await exampleSources()))[0]!;
const scene = (graph: LaidOutGraph): Scene => buildScene(graph, { diff: shop.diff, diagnostics: shop.diagnostics, mode: 'label', lang: 'ja' });
const draw = (graph: LaidOutGraph, extra: { heading?: string; legend?: boolean } = {}) =>
    portableSvg({
        scene: scene(graph),
        bounds: exportBounds(graph),
        heading: extra.heading,
        legend: extra.legend
            ? { title: MESSAGES.ja.legend, content: legendContent('storming', MESSAGES.ja), kindNames: legendKindNames(MESSAGES.ja) }
            : undefined,
        palette,
        fonts,
        measure,
    });

/** Whether `svg` is well-formed XML: every tag closed in order, attributes quoted, only the five entities. */
function wellFormed(svg: string): boolean {
    const body = svg.replace(/^<\?xml[^?]*\?>\s*/, '');
    const stack: string[] = [];
    const tokens = body.match(/<[^>]*>|[^<]+/g) ?? [];
    for (const token of tokens) {
        if (!token.startsWith('<')) {
            if (/&(?!(amp|lt|gt|quot|apos);)/.test(token)) return false;
            continue;
        }
        const m = /^<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>$/.exec(token);
        if (!m) return false;
        const [, close, name, attrs, self] = m;
        if (/&(?!(amp|lt|gt|quot|apos);)/.test(attrs!)) return false;
        if (close) {
            if (stack.pop() !== name) return false;
        } else if (!self) stack.push(name!);
    }
    return stack.length === 0;
}

describe('the portable SVG', async () => {
    const graphs: Record<string, LaidOutGraph> = {
        'the stages of a storming': await stormingGraph(),
        'the Context Map': shop.contextMap!,
        'the Structure View': shop.structure!,
        'the Structure View, overview': shop.overview!,
        'a state view': Object.values(shop.states).find((g) => g.both.nodes.some((n) => n.kind === 'state'))!.both,
    };

    for (const [name, graph] of Object.entries(graphs)) {
        test(`${name}: plain, well-formed SVG, every head a defined marker`, () => {
            const { svg, width, height } = draw(graph);
            expect(wellFormed(svg)).toBe(true);
            expect(svg).not.toContain('foreignObject');
            expect(svg).not.toContain('class=');
            expect(svg).not.toContain('var(');
            expect(svg).toContain(`width="${width}" height="${height}"`);
            const used = new Set([...svg.matchAll(/marker-(?:end|start)="url\(#([\w-]+)\)"/g)].map((m) => m[1]));
            const defined = new Set([...svg.matchAll(/<marker id="([\w-]+)"/g)].map((m) => m[1]));
            expect(used.size).toBeGreaterThan(0);
            expect([...used].every((id) => defined.has(id))).toBe(true);
            // every box's name is there, escaped
            for (const n of scene(graph).nodes) if (n.props.label && !NOTE_KINDS.has(n.props.kind)) expect(svg).toContain(`>${xml(n.props.label)}</tspan>`);
        });
    }

    test('a sticky note: its label wrapped, shrunk and cut short as the canvas fits it', () => {
        const graph = graphs['the stages of a storming']!;
        const notes = scene(graph).nodes.filter((n) => NOTE_KINDS.has(n.props.kind));
        expect(notes.length).toBeGreaterThan(10);
        const { svg } = draw(graph);
        for (const n of notes) {
            const width = n.props.w - 3 - 20;
            const room = n.props.h - 3 - 10 - (n.props.stereotype ? 14 * n.props.scale : 0);
            const at = (size: number) => (s: string) => measure.width(s, { family: fonts.sans, size, weight: 700 });
            const expected = fitLabel((size, lineHeight) => wrapLines(n.props.label, width, at(size)).length * lineHeight, room, n.props.scale);
            const { fit, lines } = noteText(n.props, fonts.sans, measure);
            expect(fit).toEqual(expected);
            if (fit.clamp === undefined) {
                expect(lines).toEqual(wrapLines(n.props.label, width, at(fit.fontSize)));
                expect(lines.length * fit.lineHeight).toBeLessThanOrEqual(room + 0.5);
            } else {
                expect(lines.length).toBe(fit.clamp);
                expect(lines[lines.length - 1]!.endsWith('…')).toBe(true);
            }
            for (const line of lines) {
                expect(at(fit.fontSize)(line)).toBeLessThanOrEqual(width + 0.01);
                expect(svg).toContain(`>${xml(line)}</tspan>`);
            }
        }
        // the stage's frame and its caption, and a note's stereotype
        expect(svg).toContain('>コンビニでの発行</tspan>');
        expect(svg).toContain('«');
    });

    test('the heading above the diagram and the legend under it, when asked', () => {
        const graph = graphs['the stages of a storming']!;
        const plain = draw(graph);
        const full = draw(graph, { heading: 'ws › イベントストーミング › 住民票', legend: true });
        expect(full.svg).toContain('>ws › イベントストーミング › 住民票</tspan>');
        expect(full.svg).toContain(`>${MESSAGES.ja.legend}</tspan>`);
        expect(full.svg).toContain(`>${MESSAGES.ja.esKinds.event}</tspan>`);
        expect(full.svg).toContain(`>${MESSAGES.ja.stormingArrowNote}</tspan>`);
        expect(full.height).toBeGreaterThan(plain.height + 100);
        expect(plain.svg).not.toContain(MESSAGES.ja.stormingArrowNote);
        expect(wellFormed(full.svg)).toBe(true);
    });

    test('a resolved hotspot: its toned paper, edge and text, its check, and its quieter `on`; none of it without one', () => {
        // examples/shop's order-to-cash: one resolved hotspot (MixedCurrencies) among open ones
        const graph = shop.stormings.find((s) => s.id === 'OrderToCash')!.views['design-level|']!.graph;
        const full = scene(graph);
        const resolved = full.nodes.filter((n) => n.props.resolution !== undefined);
        expect(resolved.map((n) => n.elementId)).toEqual(['es/OrderToCash/MixedCurrencies']);
        expect(full.nodes.some((n) => n.props.kind === 'esHotspot' && n.props.resolution === undefined)).toBe(true);
        const open: Scene = {
            ...full,
            nodes: full.nodes.map(({ props: { resolution: _, ...props }, ...n }) => ({ ...n, props })),
            edges: full.edges.map(({ props: { resolved: _, ...props }, ...e }) => ({ ...e, props })),
        };
        const svgOf = (s: Scene): string => portableSvg({ scene: s, bounds: exportBounds(graph), palette, fonts, measure }).svg;
        const [withResolved, without] = [svgOf(full), svgOf(open)];
        const count = (svg: string, attr: string, v: keyof Palette): number => svg.split(`${attr}="${palette[v].hex}"`).length - 1;
        expect(count(withResolved, 'fill', '--es-hotspot-resolved')).toBe(1);
        expect(count(withResolved, 'stroke', '--es-hotspot-resolved-border')).toBe(1);
        expect(count(withResolved, 'fill', '--es-hotspot-resolved-text')).toBeGreaterThan(0);
        expect(count(withResolved, 'fill', '--es-resolved-mark')).toBe(1);
        expect(count(withResolved, 'stroke', '--es-resolved-mark-ink')).toBe(1);
        expect(count(withResolved, 'stroke', '--es-hotspot-resolved-edge')).toBe(full.edges.filter((e) => e.props.resolved).length);
        expect(full.edges.filter((e) => e.props.resolved).length).toBeGreaterThan(0);
        for (const v of ['--es-hotspot-resolved', '--es-hotspot-resolved-border', '--es-resolved-mark', '--es-hotspot-resolved-edge'] as const)
            expect(without).not.toContain(`"${palette[v].hex}"`);
        expect(wellFormed(withResolved)).toBe(true);
        // the legend's key names it, with its check
        const legend = portableSvg({
            scene: open,
            bounds: exportBounds(graph),
            legend: { title: MESSAGES.ja.legend, content: legendContent('storming', MESSAGES.ja), kindNames: legendKindNames(MESSAGES.ja) },
            palette,
            fonts,
            measure,
        }).svg;
        expect(legend).toContain(`>${MESSAGES.ja.resolvedHotspot}</tspan>`);
        expect(count(legend, 'fill', '--es-resolved-mark')).toBe(1);
    });
});

describe('breaking a label into lines', () => {
    const at = (size: number) => (s: string) => measure.width(s, { family: 'x', size } satisfies Font);

    test('a wide character may break anywhere, but not before closing punctuation', () => {
        expect(breakUnits('住民票（写し）を、取る')).toEqual(['住', '民', '票', '（写', 'し）', 'を、', '取', 'る']);
        expect(wrapLines('あいうえおかきくけこ', 50, at(10))).toEqual(['あいうえお', 'かきくけこ']);
        expect(wrapLines('あいうえ。かきくけこ', 40, at(10))).toEqual(['あいう', 'え。かき', 'くけこ']);
    });

    test('words break at spaces, a space at the end hangs, and a word longer than a line breaks where it is full', () => {
        expect(wrapLines('Order placed by customer', 70, at(10))).toEqual(['Order placed', 'by customer']);
        expect(wrapLines('Supercalifragilistic', 55, at(10))).toEqual(['Supercalif', 'ragilistic']);
        expect(wrapLines('', 55, at(10))).toEqual(['']);
    });

    test('a clamped line ends with «…» within the width', () => {
        const line = ellipsize('あいうえおかきくけこ', 50, at(10));
        expect(line).toBe('あいうえ…');
        expect(at(10)(line)).toBeLessThanOrEqual(50);
    });
});
