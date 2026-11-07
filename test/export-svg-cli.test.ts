// dt export svg through the CLI: the convenience store's stages drawn whole, one stage with its exceptions, one
// timeline, at Big Picture and Design Level, without the exceptions; the domain model's views of examples/shop; the
// options' errors; the same bytes every time. The drawing itself is the Live View's (its tests:
// apps/web/view/portable-svg.test.ts); what is checked here is that the CLI draws the view asked for, in the
// stylesheet's colours, and says what it cannot draw.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps, runCli } from '@domaintrail/dt';
import { tempCopyOfExamples } from './helpers.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const STAGES = await readFile(path.join(import.meta.dir, 'fixtures', 'stages', 'convenience-store-stages.dtes'), 'utf8');
/** A few notes of Design Level in the stage Issuance: an actor, an external system handling commands, two commands and a policy. */
const NOTES = `
  actor Resident "住民"
  external MultiCopier "マルチコピー機"
  command PayFee "手数料を払う" {
    by Resident
    handledBy MultiCopier
    emits FeePaid
  }
  command IssueCertificate "証明書を発行する" {
    handledBy MultiCopier
    emits CertificateIssuedAtMultiCopier
  }
  policy IssueAfterPayment "手数料が払われたら発行する" {
    on FeePaid
    issues IssueCertificate
  }
`;

/** A workspace of the convenience store's stages (with a few notes of Design Level), in a directory of its own. */
async function convenienceStore(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-svg-'));
    dirs.push(dir);
    const root = path.join(dir, 'convenience-store');
    await Bun.write(path.join(root, 'stages.dtes'), STAGES.replace(/\n\s*stage Preparation /, `\n${NOTES}  stage Preparation `));
    return root;
}

async function run(...args: string[]): Promise<{ code: number; out: string[]; err: string[]; bytes: Uint8Array[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const bytes: Uint8Array[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), bytes: async (b: Uint8Array) => void bytes.push(b) };
    const code = await runCli(args, io, cliDeps());
    return { code, out, err, bytes };
}

/** The SVG `dt -r <root> export svg <args> -o -` writes to stdout. */
async function svg(root: string, ...args: string[]): Promise<string> {
    const r = await run('-r', root, 'export', 'svg', ...args, '-o', '-');
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: [] });
    return Buffer.concat(r.bytes).toString('utf8');
}

/** The lines of text an SVG shows, in order. */
const texts = (s: string): string[] => [...s.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>|<text[^>]*>([^<]+)<\/text>/g)].map((m) => m[1] ?? m[2]!);
/** The stereotypes of the notes drawn (`«イベント»`), counted. */
const stereotypes = (s: string): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const t of texts(s).filter((x) => /^«.+»$/.test(x))) counts[t] = (counts[t] ?? 0) + 1;
    return counts;
};
/** The outline of a drawing: its size, its shapes by kind and its text, for a snapshot that reads. */
const outline = (s: string): object => ({
    size: /<svg[^>]* width="(\d+)" height="(\d+)"/.exec(s)!.slice(1).map(Number),
    shapes: Object.fromEntries(['rect', 'path', 'text', 'marker', 'circle'].map((tag) => [tag, s.split(`<${tag} `).length - 1])),
    texts: texts(s),
});

describe('dt export svg: an Event Storming', () => {
    test('the whole storming: every stage, as the plain SVG the Live View exports', async () => {
        const root = await convenienceStore();
        const all = await svg(root, '--storming', 'ConvenienceStoreIssuance');
        expect(all.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
        expect(all).not.toMatch(/foreignObject|class=|<image|href=/);
        // the stages' frames, captioned with their labels
        for (const stage of ['依頼・準備', 'コンビニでの発行', '提出']) expect(texts(all)).toContain(stage);
        // Big Picture by default: events only
        expect(Object.keys(stereotypes(all))).toEqual(['«イベント»']);
        // light: on white, the events in the stylesheet's orange
        expect(all).toContain('<rect width="');
        expect(all).toMatch(/<rect width="\d+" height="\d+" fill="#ffffff"\/>/);
    });

    test('one stage with its exceptions, its heading and its legend', async () => {
        const root = await convenienceStore();
        const stage = await svg(root, '--storming', 'ConvenienceStoreIssuance', '--stage', 'Issuance', '--heading', '--legend');
        const lines = texts(stage);
        expect(lines[0]).toBe(
            'convenience-store › イベントストーミング › 住民票などのコンビニ交付（ビッグピクチャ） › コンビニでの発行 · ビッグピクチャー · 例外を含む',
        );
        // the exceptions' captions; their arrows in the one colour of every line (ADR 0032: no red for exceptions)
        expect(lines).toContain('暗証番号を忘れた');
        expect(stage).not.toContain('dt-arrow-es-exception');
        expect(lines).toEqual(expect.arrayContaining(['問い（ホットスポットとその対象）']));
        expect(lines).toContain('凡例');
        expect(lines).not.toContain('依頼・準備');
        expect(outline(stage)).toMatchSnapshot();
    });

    test('without the exceptions (--exceptions hide)', async () => {
        const root = await convenienceStore();
        const without = await svg(root, '--storming', 'ConvenienceStoreIssuance', '--stage', 'Issuance', '--exceptions', 'hide', '--heading');
        expect(texts(without)[0]).toEndWith(' · 例外を除く');
        expect(texts(without)).not.toContain('暗証番号を忘れた');
        expect(without).not.toContain('dt-arrow-es-exception');
    });

    test('one timeline, in English', async () => {
        const root = await convenienceStore();
        const timeline = await svg(root, '--storming', 'ConvenienceStoreIssuance', '--timeline', 'PinForgottenBranch', '--heading', '--lang', 'en');
        expect(texts(timeline)[0]).toBe(
            'convenience-store › Event Storming › 住民票などのコンビニ交付（ビッグピクチャ） › コンビニでの発行 / Exception: 暗証番号を忘れた · Big Picture',
        );
        // the stereotypes in English, the labels as written; the timeline's events only, wrapped in their notes
        expect(stereotypes(timeline)).toEqual({ '«event»': 3 });
        expect(texts(timeline).slice(1).join('')).toBe(
            '«event»マイナンバーカードが読み取られた«event»暗証番号を忘れた«event»市役所で暗証番号を初期化・再設定した',
        );
    });

    test('Design Level draws the commands, the policies and the actors; names by ID with --names name', async () => {
        const root = await convenienceStore();
        const design = await svg(root, '--storming', 'ConvenienceStoreIssuance', '--stage', 'Issuance', '--level', 'design');
        expect(stereotypes(design)).toMatchObject({ '«コマンド»': 2, '«ポリシー»': 1, '«アクター»': 1, '«外部システム»': 2 });
        const named = await svg(root, '--storming', 'ConvenienceStoreIssuance', '--stage', 'Issuance', '--level', 'design', '--names', 'name');
        expect(texts(named).join('')).toContain('«コマンド»PayFee«アクター»Resident');
        expect(texts(named).join('')).toContain('«コマンド»IssueCertificate');
        expect(texts(named).join('')).not.toContain('✕');
    });

    test('dark: on the dark canvas, in the dark theme’s colours', async () => {
        const root = await convenienceStore();
        const [light, dark] = await Promise.all(['light', 'dark'].map((theme) => svg(root, '--storming', 'ConvenienceStoreIssuance', '--theme', theme)));
        expect(dark).not.toMatch(/<rect width="\d+" height="\d+" fill="#ffffff"\/>/);
        expect(dark).toMatch(/<rect width="\d+" height="\d+" fill="#10/);
        // the same layout, other colours
        expect(texts(dark)).toEqual(texts(light));
        expect(dark).not.toBe(light);
    });

    test('the same sources give the same bytes, written to a file with -o', async () => {
        const root = await convenienceStore();
        const file = path.join(path.dirname(root), 'stage.svg');
        const args = ['-r', root, 'export', 'svg', '--storming', 'ConvenienceStoreIssuance', '--stage', 'Issuance', '--legend', '--heading', '-o', file];
        const first = await run(...args);
        expect(first.code).toBe(0);
        expect(first.out).toEqual([`written to ${file}`]);
        const bytes = await readFile(file);
        await writeFile(file, '');
        expect((await run(...args)).code).toBe(0);
        expect((await readFile(file)).equals(bytes)).toBe(true);
        expect(Buffer.from(await svg(root, '--storming', 'ConvenienceStoreIssuance', '--stage', 'Issuance', '--legend', '--heading')).equals(bytes)).toBe(true);
    });
});

describe('dt export svg: the resolved hotspots', () => {
    test('drawn (default), or not drawn as the 絞り込み hides them (--resolved-hotspots hide), every other note where it was, in any view', async () => {
        const copy = await tempCopyOfExamples();
        dirs.push(copy);
        // examples/shop's order-to-cash: MixedCurrencies, resolved, on ItemAdded
        const shown = await svg(copy, '--storming', 'OrderToCash', '--level', 'design');
        expect(shown).toContain('>明細の通貨が');
        const hidden = await svg(copy, '--storming', 'OrderToCash', '--level', 'design', '--resolved-hotspots', 'hide');
        expect(hidden).not.toContain('>明細の通貨が');
        expect(hidden).toContain('>支払の失敗を');
        const notes = (s: string): string[] => [...s.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="148.5" height="148.5"/g)].map((m) => m[0]);
        expect(notes(hidden).every((r) => notes(shown).includes(r))).toBe(true);
        expect(notes(shown).length - notes(hidden).length).toBe(1);
        const timeline = await svg(copy, '--storming', 'OrderToCash', '--timeline', 'Normal', '--level', 'design', '--resolved-hotspots', 'hide');
        expect(timeline).not.toContain('>明細の通貨が');
    });
});

describe('dt export svg: the domain model', () => {
    test('the Context Map, the Structure View and one context focused', async () => {
        const copy = await tempCopyOfExamples();
        dirs.push(copy);
        const map = await svg(copy, '--model', '--view', 'map', '--heading', '--legend');
        expect(texts(map)[0]).toBe(`${path.basename(copy)} › ドメインモデル › コンテキストマップ`);
        const structure = await svg(copy, '--model', '--level', 'overview');
        expect(texts(structure)).toEqual(expect.arrayContaining(['販売', '請求', '注文 集約']));
        const focused = await svg(copy, '--model', '--context', 'Billing', '--heading');
        expect(texts(focused)[0]).toStartWith(`${path.basename(copy)} › ドメインモデル › 構造図 › `);
        const unknown = await run('-r', copy, 'export', 'svg', '--model', '--context', 'Nowhere', '-o', '-');
        expect(unknown.code).toBe(1);
        expect(unknown.err[0]).toStartWith("Unknown context 'Nowhere'. Contexts: ");
    });
});

describe('dt export svg: errors', () => {
    test('an unknown storming, stage or timeline names the choices (exit 1)', async () => {
        const root = await convenienceStore();
        const cases: [string[], string][] = [
            [['--storming', 'Nope'], "Unknown storming 'Nope'. Stormings: ConvenienceStoreIssuance"],
            [
                ['--storming', 'ConvenienceStoreIssuance', '--stage', 'Nope'],
                "Unknown stage 'Nope' of ConvenienceStoreIssuance. Stages: Preparation, Issuance, Submission",
            ],
        ];
        for (const [args, message] of cases) {
            const r = await run('-r', root, 'export', 'svg', ...args, '-o', '-');
            expect({ code: r.code, err: r.err, bytes: r.bytes.length }).toEqual({ code: 1, err: [message], bytes: 0 });
        }
        const timeline = await run('-r', root, 'export', 'svg', '--storming', 'ConvenienceStoreIssuance', '--timeline', 'Nope', '-o', '-');
        expect(timeline.code).toBe(1);
        expect(timeline.err[0]).toStartWith("Unknown timeline 'Nope' of ConvenienceStoreIssuance. Timelines: PreparationFlow, ");
    });

    test('options that do not go together (exit 2), before the workspace is read', async () => {
        const cases: [string[], string][] = [
            [[], 'Give the diagram to draw: --storming <ID> (an Event Storming) or --model (the domain model).'],
            [['--storming', 'S', '--model'], 'Give --storming <ID> or --model, not both.'],
            [['--storming', 'S', '--stage', 'A', '--timeline', 'B'], 'Give --stage or --timeline, not both.'],
            [['--storming', 'S', '--timeline', 'B', '--exceptions', 'hide'], '--exceptions applies to the whole storming or a stage, not to one timeline.'],
            [['--storming', 'S', '--level', 'detail'], "Unknown level 'detail' of a storming. Choose: big-picture, design"],
            [['--model', '--stage', 'A'], '--stage, --timeline, --exceptions and --resolved-hotspots are options of --storming.'],
            [['--model', '--resolved-hotspots', 'hide'], '--stage, --timeline, --exceptions and --resolved-hotspots are options of --storming.'],
            [['--model', '--view', 'map', '--context', 'Sales'], '--context and --level are options of --view structure.'],
        ];
        for (const [args, message] of cases) {
            const r = await run('-r', '/nonexistent-root', 'export', 'svg', ...args, '-o', '-');
            expect({ args, code: r.code, err: r.err }).toEqual({ args, code: 2, err: [message] });
        }
    });

    test('-o is required; a workspace without sources is exit 1', async () => {
        const root = await convenienceStore();
        const missing = await run('-r', root, 'export', 'svg', '--storming', 'ConvenienceStoreIssuance');
        expect(missing.code).toBe(1);
        expect(missing.err.join('\n')).toContain("required option '-o, --out <file>' not specified");
        const empty = await mkdtemp(path.join(tmpdir(), 'domaintrail-svg-empty-'));
        dirs.push(empty);
        const none = await run('-r', empty, 'export', 'svg', '--storming', 'S', '-o', '-');
        expect(none.code).toBe(1);
        expect(none.err[0]).toStartWith('No .dt or .dtes files found under ');
    });
});
