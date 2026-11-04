// The left column's split on the first frame (app/panes.ts).
import { describe, expect, test } from 'bun:test';
import { DETAIL_MIN, detailSize, drawnDetailHeight } from './panes';

describe('the detail’s height as drawn', () => {
    test('none until its column is measured, so that the first frame is drawn at the measured split', () => {
        // before the layout effect measured the column (0): no height, not the minimum a transition would start from
        expect(drawnDetailHeight(true, null, 0, 28)).toBeUndefined();
        expect(drawnDetailHeight(true, 300, 0, 28)).toBeUndefined();
        // measured: the default share or the dragged height, as the splitter has it
        expect(drawnDetailHeight(true, null, 720, 28)).toBe(detailSize(null, 720));
        expect(drawnDetailHeight(true, null, 720, 28)).toBe(396);
        expect(drawnDetailHeight(true, 300, 720, 28)).toBe(300);
        expect(drawnDetailHeight(true, 10, 720, 28)).toBe(DETAIL_MIN);
    });

    test('closed: the rail, measured or not', () => {
        expect(drawnDetailHeight(false, null, 0, 28)).toBe(28);
        expect(drawnDetailHeight(false, 300, 720, 28)).toBe(28);
    });
});
