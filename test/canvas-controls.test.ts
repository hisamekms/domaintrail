import { describe, expect, test } from 'bun:test';
import { MESSAGES } from '@domaintrail/web/i18n';
import { legendRows } from '@domaintrail/web/legend';
import {
    ALL_SHOWN,
    canvasShortcut,
    choose,
    formatZoom,
    parseChosen,
    shownControls,
    toggleTemporarily,
    type ControlsState,
} from '@domaintrail/web/view/controls';

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

    test('U hides or shows the controls; H stays the hand tool', () => {
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

    test('the key hides what is shown for now, and brings the choice back when pressed again', () => {
        const s: ControlsState = { chosen: { zoom: true, legend: false }, override: null };
        const hidden = toggleTemporarily(s);
        expect(shownControls(hidden)).toEqual({ zoom: false, legend: false });
        expect(hidden.chosen).toEqual(s.chosen);
        expect(shownControls(toggleTemporarily(hidden))).toEqual({ zoom: true, legend: false });
    });

    test('with nothing chosen, the key shows everything for now', () => {
        const s: ControlsState = { chosen: { zoom: false, legend: false }, override: null };
        expect(shownControls(toggleTemporarily(s))).toEqual(ALL_SHOWN);
        expect(shownControls(toggleTemporarily(toggleTemporarily(s)))).toEqual({ zoom: false, legend: false });
    });

    test('a choice from the menu starts from what is shown and ends what the key did', () => {
        const hidden = toggleTemporarily({ chosen: ALL_SHOWN, override: null });
        expect(choose(hidden, 'legend', true)).toEqual({ chosen: { zoom: false, legend: true }, override: null });
        expect(choose({ chosen: ALL_SHOWN, override: null }, 'zoom', false).chosen).toEqual({ zoom: false, legend: true });
    });

    test('the saved choice, or everything shown', () => {
        expect(parseChosen(JSON.stringify({ zoom: false, legend: true }))).toEqual({ zoom: false, legend: true });
        expect(parseChosen(null)).toEqual(ALL_SHOWN);
        expect(parseChosen('{"zoom":1}')).toEqual(ALL_SHOWN);
        expect(parseChosen('not json')).toEqual(ALL_SHOWN);
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
