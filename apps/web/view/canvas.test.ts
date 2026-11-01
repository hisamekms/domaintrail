import { describe, expect, test } from 'bun:test';
import { cameraMove } from './canvas';

describe('the camera of the Event Storming view', () => {
    test('fits the whole graph whenever another storming, level or timeline is shown, even one shown before', () => {
        expect(cameraMove({ switched: true, storming: true, saved: false })).toBe('fitAll');
        expect(cameraMove({ switched: true, storming: true, saved: true })).toBe('fitAll');
    });

    test('keeps the camera when a live reload redraws the same graph', () => {
        expect(cameraMove({ switched: false, storming: true, saved: true })).toBe('keep');
        expect(cameraMove({ switched: false, storming: true, saved: false })).toBe('keep');
    });

    test('leaves the other canvases as they were: their own camera back, fitted readably the first time', () => {
        expect(cameraMove({ switched: true, storming: false, saved: true })).toBe('restore');
        expect(cameraMove({ switched: true, storming: false, saved: false })).toBe('fitReadable');
        expect(cameraMove({ switched: false, storming: false, saved: true })).toBe('keep');
    });
});
