import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paneMotion, parseDuration } from './motion';
import { centeredCamera, isLaidOut } from '../view/center';

const styles = readFileSync(join(import.meta.dir, '..', 'styles.css'), 'utf8');

describe('the motion tokens', () => {
    test('a CSS duration in milliseconds; anything else is no motion', () => {
        expect(parseDuration('120ms')).toBe(120);
        expect(parseDuration(' 0.22s ')).toBe(220);
        expect(parseDuration('0ms')).toBe(0);
        expect(parseDuration('')).toBe(0);
        expect(parseDuration('fast')).toBe(0);
        expect(parseDuration('-10ms')).toBe(0);
    });

    test('every duration token is 0ms when the OS asks for less motion', () => {
        const section = styles.slice(styles.indexOf('/* ---------- motion ---------- */'));
        const tokens = [...section.matchAll(/^\s*(--motion-[a-z-]+):\s*[\d.]+m?s;/gm)].map((m) => m[1]);
        expect(tokens).toContain('--motion-enter');
        const reduced = section.slice(section.indexOf('@media (prefers-reduced-motion: reduce)'));
        const zeroed = new Set([...reduced.matchAll(/(--motion-[a-z-]+):\s*0ms;/g)].map((m) => m[1]));
        for (const token of new Set(tokens)) expect(zeroed.has(token)).toBe(true);
    });
});

describe('the pace of the panes', () => {
    test('opening as soon as one opens, even while another closes (the chat opening collapses the left pane)', () => {
        expect(paneMotion([false, true, false], [false, true, true], 'exit')).toBe('enter');
        expect(paneMotion([true, true, false], [false, true, true], 'exit')).toBe('enter');
    });

    test('closing when they only close; unchanged, the last pace stays', () => {
        expect(paneMotion([true, true, true], [true, false, true], 'enter')).toBe('exit');
        expect(paneMotion([true, false], [true, false], 'exit')).toBe('exit');
        expect(paneMotion([true, false], [true, false], 'enter')).toBe('enter');
    });
});

describe("the canvas's center while it changes size", () => {
    test('half of the change in page units: the point at the center stays at the center', () => {
        const camera = { x: 10, y: -20, z: 2 };
        const before = { w: 800, h: 600 };
        const after = { w: 600, h: 700 };
        const moved = centeredCamera(camera, before, after);
        expect(moved).toEqual({ x: 10 - 50, y: -20 + 25, z: 2 });
        // the page point at the center, before and after (screen = (page + camera) * z)
        const center = (c: typeof camera, s: typeof before) => ({ x: s.w / 2 / c.z - c.x, y: s.h / 2 / c.z - c.y });
        expect(center(moved, after)).toEqual(center(camera, before));
    });

    test('no change, no move', () => {
        expect(centeredCamera({ x: 3, y: 4, z: 0.5 }, { w: 500, h: 400 }, { w: 500, h: 400 })).toEqual({ x: 3, y: 4, z: 0.5 });
    });

    test('a canvas that is not laid out has no center to keep', () => {
        expect(isLaidOut({ w: 0, h: 300 })).toBe(false);
        expect(isLaidOut({ w: 300, h: 0 })).toBe(false);
        expect(isLaidOut({ w: 300, h: 200 })).toBe(true);
    });
});
