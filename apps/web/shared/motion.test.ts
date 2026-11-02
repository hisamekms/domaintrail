import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHold, paneMotion, parseDuration, type HoldClock } from './motion';
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

/** A clock whose time only moves with `advance`, running the timers that are due on the way. */
function fakeClock(): HoldClock & { advance(ms: number): void; pending(): number } {
    let now = 0;
    let next = 0;
    const timers = new Map<number, { at: number; run: () => void }>();
    return {
        now: () => now,
        after(ms, run) {
            const id = ++next;
            timers.set(id, { at: now + ms, run });
            return () => void timers.delete(id);
        },
        advance(ms) {
            const end = now + ms;
            for (;;) {
                const due = [...timers].filter(([, t]) => t.at <= end).sort(([, a], [, b]) => a.at - b.at)[0];
                if (!due) break;
                timers.delete(due[0]);
                now = due[1].at;
                due[1].run();
            }
            now = end;
        },
        pending: () => timers.size,
    };
}

describe('a value held on screen', () => {
    const setup = (initial?: string) => {
        const clock = fakeClock();
        const shown: (string | undefined)[] = [];
        const hold = createHold<string>(initial, 1200, (v) => shown.push(v), Object.is, clock);
        return { clock, shown, hold };
    };

    test('the first value is shown at once, and so is a change after the hold', () => {
        const { clock, shown, hold } = setup();
        hold.set('a');
        expect(shown).toEqual(['a']);
        clock.advance(1500);
        hold.set('b');
        expect(shown).toEqual(['a', 'b']);
    });

    test('a change during the hold waits for its end', () => {
        const { clock, shown, hold } = setup('a');
        clock.advance(400);
        hold.set('b');
        expect(shown).toEqual([]);
        clock.advance(799);
        expect(shown).toEqual([]);
        clock.advance(1);
        expect(shown).toEqual(['b']);
        // and b is held in its turn, from when it was shown
        hold.set('c');
        clock.advance(1199);
        expect(shown).toEqual(['b']);
        clock.advance(1);
        expect(shown).toEqual(['b', 'c']);
    });

    test('the changes during a hold come down to the latest one, nothing replayed', () => {
        const { clock, shown, hold } = setup('a');
        hold.set('b');
        clock.advance(300);
        hold.set('c');
        clock.advance(300);
        hold.set('d');
        clock.advance(600);
        expect(shown).toEqual(['d']);
        clock.advance(5000);
        expect(shown).toEqual(['d']);
    });

    test('back to the value shown before the hold ends: nothing changes', () => {
        const { clock, shown, hold } = setup('a');
        hold.set('b');
        hold.set('a');
        clock.advance(2000);
        expect(shown).toEqual([]);
    });

    test('the same value again (by `same`) changes nothing', () => {
        const clock = fakeClock();
        const shown: ({ id: number } | undefined)[] = [];
        const hold = createHold<{ id: number }>(
            { id: 1 },
            1200,
            (v) => shown.push(v),
            (a, b) => a.id === b.id,
            clock,
        );
        hold.set({ id: 1 });
        clock.advance(2000);
        expect(shown).toEqual([]);
    });

    test('nothing to show, or something after nothing, is shown at once', () => {
        const { clock, shown, hold } = setup('a');
        hold.set('b');
        hold.set(undefined);
        expect(shown).toEqual([undefined]);
        expect(clock.pending()).toBe(0);
        hold.set('c');
        expect(shown).toEqual([undefined, 'c']);
    });

    test('cancelling drops what waits (the line leaving the page)', () => {
        const { clock, shown, hold } = setup('a');
        hold.set('b');
        hold.cancel();
        expect(clock.pending()).toBe(0);
        clock.advance(2000);
        expect(shown).toEqual([]);
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
