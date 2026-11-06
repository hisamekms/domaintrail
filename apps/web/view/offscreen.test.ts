import { describe, expect, test } from 'bun:test';
import { offscreenPointers, offscreenSide } from './offscreen';

const viewport = { x: 0, y: 0, w: 1000, h: 500 };
const note = (x: number, y: number) => ({ x, y, w: 100, h: 100 });

describe('the side of the canvas a sticky lies beyond', () => {
    test('none while any part of it is in view', () => {
        expect(offscreenSide(note(400, 200), viewport)).toBeUndefined();
        expect(offscreenSide(note(950, 200), viewport)).toBeUndefined();
        expect(offscreenSide(note(-90, -90), viewport)).toBeUndefined();
    });
    test('the side its centre is farthest past, in the viewport’s widths and heights', () => {
        expect(offscreenSide(note(1200, 200), viewport)).toBe('right');
        expect(offscreenSide(note(-300, 200), viewport)).toBe('left');
        expect(offscreenSide(note(400, 700), viewport)).toBe('bottom');
        expect(offscreenSide(note(400, -400), viewport)).toBe('top');
        // far to the right and a little below: on the right
        expect(offscreenSide(note(2500, 600), viewport)).toBe('right');
        // just past the right edge, far below: below
        expect(offscreenSide(note(1010, 2000), viewport)).toBe('bottom');
    });
});

describe('the pointers at the canvas’s edge', () => {
    test('one per side, the nearest first, where it lies along the edge (off the corners)', () => {
        const pointers = offscreenPointers(
            [
                { id: 'far', rect: note(3000, 200) },
                { id: 'near', rect: note(1200, 300) },
                { id: 'left', rect: note(-500, -60) },
                { id: 'seen', rect: note(400, 200) },
            ],
            viewport,
        );
        expect(pointers.map((p) => [p.side, p.ids])).toEqual([
            ['left', ['left']],
            ['right', ['near', 'far']],
        ]);
        expect(pointers[1]!.at).toBeCloseTo(350 / 500);
        // above the top: kept off the corner
        expect(pointers[0]!.at).toBeCloseTo(0.12);
    });
    test('none when everything is in view', () => {
        expect(offscreenPointers([{ id: 'a', rect: note(10, 10) }], viewport)).toEqual([]);
    });
});
