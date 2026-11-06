import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
    BADGE,
    badgeWidth,
    DIAG_RADIUS,
    edgeClassName,
    EdgeMarks,
    edgeOutlinePath,
    NodeContent,
    nodeClassName,
    nodeOutlinePath,
    roundRectPath,
    type SettledState,
    settledMarkRight,
} from './diagram-items';
import { I18nProvider } from './i18n';
import type { EdgeProps, NodeProps } from './scene';

/** The corners of a path's straight segments (`L x,y`). */
const corners = (d: string): [number, number][] => [...d.matchAll(/L(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);

describe('the outline of a hovered or selected item', () => {
    const plain = { w: 200, h: 100, kind: 'entity', badge: '', diag: 'none' as const };

    test('is a rounded rectangle around a node without marks', () => {
        expect(nodeOutlinePath(plain, 1)).toBe(roundRectPath(200, 100, 8));
        expect(roundRectPath(200, 100, 8)).toBe('M8,0 H192 A8,8 0 0 1 200,8 V92 A8,8 0 0 1 192,100 H8 A8,8 0 0 1 0,92 V8 A8,8 0 0 1 8,0 Z');
    });

    test('steps out around the change badge on the top edge, at its size for the zoom', () => {
        const badge = '変更';
        for (const k of [1, 2]) {
            const top = BADGE.bottom - BADGE.height * k - 2;
            const right = BADGE.left + badgeWidth(badge) * k + 2;
            expect(corners(nodeOutlinePath({ ...plain, badge }, k)).slice(0, 4)).toEqual([
                [BADGE.left - 2, 0],
                [BADGE.left - 2, top],
                [right, top],
                [right, 0],
            ]);
        }
    });

    test('steps out around the diagnostic mark at the top-right corner', () => {
        const m = DIAG_RADIUS * 1.5 + 2;
        expect(corners(nodeOutlinePath({ ...plain, diag: 'error' }, 1.5)).slice(0, 5)).toEqual([
            [200 - m, 0],
            [200 - m, -m],
            [200 + m, -m],
            [200 + m, m],
            [200, m],
        ]);
    });

    test('of the initial state is its box', () => {
        expect(nodeOutlinePath({ ...plain, kind: 'initial', badge: '追加' }, 1)).toBe(roundRectPath(200, 100, 8));
    });

    test('of an edge follows its route', () => {
        expect(
            edgeOutlinePath([
                { x: 0, y: 0 },
                { x: 0, y: 40 },
                { x: 30, y: 40 },
            ]),
        ).toBe('M0,0 L0,40 L30,40');
    });
});

describe('the classes of a node', () => {
    const p: NodeProps = {
        w: 10,
        h: 10,
        kind: 'esActor',
        label: '',
        stereotype: '',
        scale: 1,
        rows: [],
        compartment: 0,
        change: 'none',
        badge: '',
        diag: 'none',
    };

    test('ring the selected note, and dash the other notes of its element', () => {
        expect(nodeClassName(p, true)).toContain(' dn-selected');
        expect(nodeClassName(p, false, true)).toContain(' dn-same');
        expect(nodeClassName(p, true, true)).not.toContain('dn-same');
        expect(nodeClassName(p, false)).not.toMatch(/dn-(selected|same)/);
    });
});

describe('a resolved hotspot', () => {
    const hotspot: NodeProps = {
        w: 150,
        h: 150,
        kind: 'esHotspot',
        label: '通貨は混在する？',
        stereotype: '«ホットスポット»',
        scale: 1,
        rows: [],
        compartment: 0,
        change: 'none',
        badge: '',
        diag: 'none',
    };
    const resolved: NodeProps = { ...hotspot, resolution: '一つの注文は一つの通貨' };
    const html = (p: NodeProps): string =>
        renderToStaticMarkup(createElement(NodeContent, { p, Marks: ({ badge, diag }) => createElement(EdgeMarks, { badge, diag, scale: 1 }) }));

    test('is toned down and checked, and tells its resolution on hover; an open one is neither', () => {
        expect(nodeClassName(resolved, false)).toContain(' dn-resolved');
        expect(nodeClassName(hotspot, false)).not.toContain('dn-resolved');
        expect(html(resolved)).toContain('class="dn-resolved-mark"');
        expect(html(resolved)).toContain('data-tooltip="解決済み: 一つの注文は一つの通貨"');
        expect(html(hotspot)).not.toContain('dn-resolved-mark');
        expect(html(hotspot)).not.toContain('data-tooltip');
        // resolved without a resolution (an S009 error): still checked
        expect(html({ ...hotspot, resolution: '' })).toContain('data-tooltip="解決済み"');
    });

    test('has its `on` drawn quieter', () => {
        const edge: EdgeProps = { points: [], kind: 'esHotspot', label: '', sub: '', faded: false, scale: 1, lx: 0, ly: 0, lw: 0, lh: 0, tone: 'normal' };
        expect(edgeClassName({ ...edge, resolved: true })).toContain(' de-resolved');
        expect(edgeClassName(edge)).not.toContain('de-resolved');
    });
});

describe('the check of the hidden resolved hotspots on a sticky (ADR 0032 §10)', () => {
    const event: NodeProps = {
        w: 150,
        h: 150,
        kind: 'esEvent',
        label: '配車を組んだ',
        stereotype: '«イベント»',
        scale: 1,
        rows: [],
        compartment: 0,
        change: 'none',
        badge: '',
        diag: 'none',
        settled: [{ item: 'n:H', label: '運転手は誰が選ぶ？', resolution: '配車計画が選ぶ' }],
    };
    const html = (p: NodeProps, settled?: SettledState, copy?: string): string =>
        renderToStaticMarkup(
            createElement(I18nProvider, {
                lang: 'ja',
                children: createElement(NodeContent, { p, Marks: () => null, ...(settled && { settled }), ...(copy && { copy }) }),
            }),
        );

    test('in its corner, saying what was agreed; left of its 「k/n」 when it has one; marked while its hotspot is selected', () => {
        const out = html(event);
        expect(out).toContain('dn-resolved-mark dn-settled-mark');
        expect(out).toContain('data-tooltip="解決済み: 配車計画が選ぶ"');
        expect(out).not.toContain('style="right');
        expect(html(event, undefined, '1/2')).toContain(`style="right:${settledMarkRight('1/2')}px"`);
        expect(settledMarkRight('1/2')!).toBeGreaterThan(14 + 30);
        const picked: string[] = [];
        const pressable = html(event, { chosen: new Set(['n:H']), pick: (item) => picked.push(item) });
        expect(pressable).toContain('dn-settled-chosen');
        expect(pressable).toContain('role="button"');
        expect(html({ ...event, settled: undefined })).not.toContain('dn-settled-mark');
    });
});
