// The left column's split on the first frame (app/panes.ts): the tree over the detail.
import { describe, expect, test } from 'bun:test';
import { drawnTreeHeight, treeSize } from './panes';

describe('the tree’s height as drawn', () => {
    test('none until its column is measured, so that the first frame is drawn at the measured split', () => {
        // before the layout effect measured the column (0): no height, not the minimum a transition would start from
        expect(drawnTreeHeight(null, 0)).toBeUndefined();
        expect(drawnTreeHeight(300, 0)).toBeUndefined();
        // measured: the default share or the dragged height, as the splitter has it
        expect(drawnTreeHeight(null, 720)).toBe(treeSize(null, 720));
        expect(drawnTreeHeight(null, 720)).toBe(324);
        expect(drawnTreeHeight(300, 720)).toBe(300);
    });
});
