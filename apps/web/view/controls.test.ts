import { describe, expect, test } from 'bun:test';
import { MESSAGES } from '../i18n';
import { legendRows } from '../legend';
import { canvasShortcut, formatZoom } from './controls';

const key = (k: Partial<Parameters<typeof canvasShortcut>[0]>): Parameters<typeof canvasShortcut>[0] => ({
    key: '',
    code: '',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    ...k,
});

describe("the canvas's bottom-left controls", () => {
    test('the zoom level in percent, rounded', () => {
        expect(formatZoom(1)).toBe('100%');
        expect(formatZoom(0.854)).toBe('85%');
        expect(formatZoom(2)).toBe('200%');
    });

    test('Shift+1 fits everything, Shift+2 the selection, whatever the layout types with them', () => {
        expect(canvasShortcut(key({ key: '!', code: 'Digit1', shiftKey: true }), false)).toBe('fitAll');
        expect(canvasShortcut(key({ key: '"', code: 'Digit2', shiftKey: true }), false)).toBe('fitSelection');
        expect(canvasShortcut(key({ key: '1', code: 'Digit1' }), false)).toBeNull();
    });

    test('U and H have no toolbar action', () => {
        expect(canvasShortcut(key({ key: 'u', code: 'KeyU' }), false)).toBeNull();
        expect(canvasShortcut(key({ key: 'U', code: 'KeyU', shiftKey: true }), false)).toBeNull();
        expect(canvasShortcut(key({ key: 'h', code: 'KeyH' }), false)).toBeNull();
    });

    test('no key while typing, composing or with a modifier', () => {
        expect(canvasShortcut(key({ key: '!', code: 'Digit1', shiftKey: true }), true)).toBeNull();
        expect(canvasShortcut(key({ key: '!', code: 'Digit1', shiftKey: true, isComposing: true }), false)).toBeNull();
        expect(canvasShortcut(key({ key: '!', code: 'Digit1', shiftKey: true, metaKey: true }), false)).toBeNull();
        expect(canvasShortcut(key({ key: '!', code: 'Digit1', shiftKey: true, ctrlKey: true }), false)).toBeNull();
    });
});

describe("the edges' hover hints", () => {
    test("say what the view's legend says for the edge's kind", () => {
        const words = MESSAGES.ja.legendRows;
        expect(legendRows('structure', words).find((r) => r.kind === 'references')?.text).toBe('参照（ID で別の集約へ）');
        expect(legendRows('contextMap', words).find((r) => r.kind === 'references')?.text).toBe(words.mapReferences);
        expect(legendRows('states', words).map((r) => r.kind)).toEqual(['transition']);
        expect(legendRows('storming', words).find((r) => r.kind === 'owns')).toBeUndefined();
    });
});
