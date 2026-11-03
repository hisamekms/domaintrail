import { describe, expect, test } from 'bun:test';
import { dragPane, pressedOutside, type PressRoot } from './layout';

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

describe('a size within its limits', () => {
    test('whole px between min and max; min wins when there is less room', async () => {
        const { clampSize } = await import('./layout');
        expect(clampSize(250.6, 180, 480)).toBe(251);
        expect(clampSize(100, 180, 480)).toBe(180);
        expect(clampSize(900, 180, 480)).toBe(480);
        expect(clampSize(300, 180, 120)).toBe(180);
    });
});

describe('the keyboard on a resizer', () => {
    test('the arrows along its axis step it, Shift in larger steps; Home and End go to the limits; other keys are not taken', async () => {
        const { keyedSize, KEY_STEP, KEY_STEP_LARGE } = await import('./layout');
        const x = { direction: 'x' as const, min: 200, max: 500 };
        expect(keyedSize('ArrowRight', false, 300, x)).toBe(300 + KEY_STEP);
        expect(keyedSize('ArrowLeft', true, 300, x)).toBe(300 - KEY_STEP_LARGE);
        expect(keyedSize('ArrowUp', false, 300, x)).toBeUndefined();
        expect(keyedSize('Home', false, 300, x)).toBe(200);
        expect(keyedSize('End', false, 300, x)).toBe(500);
        expect(keyedSize('ArrowLeft', true, 210, x)).toBe(200);
        expect(keyedSize('Enter', false, 300, x)).toBeUndefined();
    });

    test('a pane at the bottom or the right end grows with the arrow pointing away from it (↑ for the detail, ← for the chat)', async () => {
        const { keyedSize, KEY_STEP } = await import('./layout');
        const detail = { direction: 'y' as const, invert: true, min: 140, max: 600 };
        expect(keyedSize('ArrowUp', false, 300, detail)).toBe(300 + KEY_STEP);
        expect(keyedSize('ArrowDown', false, 300, detail)).toBe(300 - KEY_STEP);
        expect(keyedSize('ArrowLeft', false, 300, detail)).toBeUndefined();
        expect(keyedSize('ArrowLeft', false, 380, { direction: 'x', invert: true, min: 300, max: 700 })).toBe(380 + KEY_STEP);
    });
});

describe('the sizes remembered per browser', () => {
    const memory = (): Map<string, string> & { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } => {
        const map = new Map<string, string>();
        return Object.assign(map, { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) });
    };

    test('stored as JSON and read back; null (the default size) too', async () => {
        const { readStored, writeStored } = await import('./layout');
        const storage = memory();
        writeStored('domaintrail.layout.detailHeight', 320, storage);
        expect(storage.get('domaintrail.layout.detailHeight')).toBe('320');
        expect(readStored<number | null>('domaintrail.layout.detailHeight', null, storage)).toBe(320);
        writeStored('domaintrail.layout.detailHeight', null, storage);
        expect(readStored<number | null>('domaintrail.layout.detailHeight', 7, storage)).toBeNull();
        expect(readStored('domaintrail.layout.other', 260, storage)).toBe(260);
    });

    test('a storage that throws or a value that does not parse gives the initial value, and writing never throws', async () => {
        const { readStored, writeStored } = await import('./layout');
        const failing = {
            getItem: (): string | null => {
                throw new Error('denied');
            },
            setItem: (): void => {
                throw new Error('quota');
            },
        };
        expect(readStored('k', 260, failing)).toBe(260);
        expect(() => writeStored('k', 300, failing)).not.toThrow();
        const storage = memory();
        storage.set('k', '{not json');
        expect(readStored('k', 260, storage)).toBe(260);
        expect(readStored('k', 260, undefined)).toBe(260);
    });
});

describe("the left column's split", () => {
    test('the detail takes its share of the column until dragged; each part keeps its minimum', async () => {
        const { DETAIL_MIN, DETAIL_SHARE, NAVIGATOR_MIN, detailMax, detailSize } = await import('../app/panes');
        expect(detailSize(null, 800)).toBe(Math.round(800 * DETAIL_SHARE));
        expect(detailSize(300, 800)).toBe(300);
        // dragged too low or too high: within the detail's minimum and the room the navigator leaves
        expect(detailSize(50, 800)).toBe(DETAIL_MIN);
        expect(detailSize(790, 800)).toBe(800 - NAVIGATOR_MIN);
        expect(detailMax(800)).toBe(800 - NAVIGATOR_MIN);
        // a column not laid out yet, or too short for both: the detail keeps its minimum
        expect(detailSize(null, 0)).toBe(DETAIL_MIN);
        expect(detailSize(400, 200)).toBe(DETAIL_MIN);
    });
});

describe('a press outside a popover', () => {
    // a stand-in for the DOM: a node is inside a root when the root is the node or one of its ancestors
    type Fake = { nodeType: number; parent?: Fake };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stand-in for a DOM node
    const node = (parent?: Fake): EventTarget & Fake => ({ nodeType: 1, parent }) as unknown as EventTarget & Fake;
    const root = (self: Fake): PressRoot => ({
        contains: (other) => {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stand-in passed as the target
            for (let n = other as unknown as Fake | undefined; n; n = n.parent) if (n === self) return true;
            return false;
        },
    });

    test('a press inside the popover or on its trigger is not outside it; one elsewhere (the canvas) is', () => {
        const menu = node();
        const item = node(menu);
        const trigger = node();
        const canvas = node();
        const roots = [root(menu), root(trigger)];
        expect(pressedOutside(item, roots)).toBe(false);
        expect(pressedOutside(menu, roots)).toBe(false);
        expect(pressedOutside(trigger, roots)).toBe(false);
        expect(pressedOutside(canvas, roots)).toBe(true);
    });

    test('a root not mounted yet does not count, and a target that is not a node is outside', () => {
        const menu = node();
        expect(pressedOutside(node(menu), [null, undefined, root(menu)])).toBe(false);
        expect(pressedOutside(node(), [null])).toBe(true);
        expect(pressedOutside(null, [root(menu)])).toBe(true);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the window as a target
        expect(pressedOutside({} as EventTarget, [root(menu)])).toBe(true);
    });
});
