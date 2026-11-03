import { describe, expect, test } from 'bun:test';
import { BADGE, badgeWidth, DIAG_RADIUS, edgeOutlinePath, nodeOutlinePath, roundRectPath } from './diagram-items';

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
