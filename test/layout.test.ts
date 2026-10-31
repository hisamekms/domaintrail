import { describe, expect, test } from 'bun:test';
import { dragPane } from '@domaintrail/web/shared/layout';

describe('dragging a pane edge', () => {
    test('follows the pointer within the limits', () => {
        expect(dragPane(250.4, 260, 180, 480)).toEqual({ open: true, size: 250 });
        expect(dragPane(600, 260, 180, 480)).toEqual({ open: true, size: 480 });
    });

    test('stops at the minimum until half of it, then closes and keeps the size from before the drag', () => {
        expect(dragPane(120, 260, 180, 480)).toEqual({ open: true, size: 180 });
        expect(dragPane(90, 260, 180, 480)).toEqual({ open: true, size: 180 });
        expect(dragPane(89, 260, 180, 480)).toEqual({ open: false, size: 260 });
    });

    test('opens a closed pane once dragged past half of the minimum', () => {
        expect(dragPane(28 + 40, 300, 180, 480)).toEqual({ open: false, size: 300 });
        expect(dragPane(28 + 100, 300, 180, 480)).toEqual({ open: true, size: 180 });
        expect(dragPane(28 + 300, 300, 180, 480)).toEqual({ open: true, size: 328 });
    });
});
