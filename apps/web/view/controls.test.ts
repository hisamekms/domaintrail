import { describe, expect, test } from 'bun:test';
import { MESSAGES } from '../i18n';
import { legendRows } from '../legend';
import { canvasShortcut, controlsStorageKey, EXPANDED, formatZoom, parseControls, toggleCollapsed } from './controls';

const key = (k: Partial<Parameters<typeof canvasShortcut>[0]>): Parameters<typeof canvasShortcut>[0] => ({
    key: '',
    code: '',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    repeat: false,
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

    test('U collapses or brings back the controls; H stays the hand tool', () => {
        expect(canvasShortcut(key({ key: 'u', code: 'KeyU' }), false)).toBe('toggleControls');
        expect(canvasShortcut(key({ key: 'U', code: 'KeyU', shiftKey: true }), false)).toBe('toggleControls');
        expect(canvasShortcut(key({ key: 'u', code: 'KeyU', repeat: true }), false)).toBeNull();
        expect(canvasShortcut(key({ key: 'h', code: 'KeyH' }), false)).toBeNull();
    });

    test('no key while typing, composing or with a modifier', () => {
        expect(canvasShortcut(key({ key: 'u', code: 'KeyU' }), true)).toBeNull();
        expect(canvasShortcut(key({ key: 'u', code: 'KeyU', isComposing: true }), false)).toBeNull();
        expect(canvasShortcut(key({ key: 'u', code: 'KeyU', metaKey: true }), false)).toBeNull();
        expect(canvasShortcut(key({ key: '!', code: 'Digit1', shiftKey: true, ctrlKey: true }), false)).toBeNull();
    });

    test('«, » and U toggle one state: collapsed or expanded', () => {
        expect(toggleCollapsed(EXPANDED)).toEqual({ collapsed: true });
        expect(toggleCollapsed(toggleCollapsed(EXPANDED))).toEqual(EXPANDED);
    });

    test('the saved state, or expanded; the former choice of what to show is collapsed only when both were hidden', () => {
        expect(parseControls(JSON.stringify({ collapsed: true }))).toEqual({ collapsed: true });
        expect(parseControls(JSON.stringify({ zoom: false, legend: false }))).toEqual({ collapsed: true });
        expect(parseControls(JSON.stringify({ zoom: false, legend: true }))).toEqual(EXPANDED);
        expect(parseControls(JSON.stringify({ zoom: true, legend: false }))).toEqual(EXPANDED);
        expect(parseControls(null)).toEqual(EXPANDED);
        expect(parseControls('{"zoom":1}')).toEqual(EXPANDED);
        expect(parseControls('not json')).toEqual(EXPANDED);
    });

    test('each canvas has a separate persisted setting', () => {
        expect(controlsStorageKey('workspace:structure')).toBe('domaintrail.canvas.controls.workspace%3Astructure');
        expect(controlsStorageKey('states:Sales.Order')).toBe('domaintrail.canvas.controls.states%3ASales.Order');
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
