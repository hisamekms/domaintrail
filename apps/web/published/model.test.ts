// The read-only page's state without React: its place in the query, the storming shown, the drawing of a level
// checked for what the canvas reads, the stickies' names across the published stormings, and the date of the drawing.
import { describe, expect, test } from 'bun:test';
import type { PublishedStorming } from '@domaintrail/knowledge';
import { stickyRef } from '@domaintrail/knowledge/protocol';
import { DEFAULT_LEVEL, DrawingError, drawingDate, drawingOf, locationOf, searchOf, shownStorming, stickyNames } from './model';

const graph = { id: 'es-dl', nodes: [{ id: 'n1', elementId: 'es/Ordering/Placed', label: {} }], edges: [], nodeLayout: {}, edgeLayout: {} };
const form = (over: Partial<PublishedStorming> = {}): PublishedStorming => ({
    format: 1,
    storming: 'Ordering',
    version: 'v1',
    drawing: { at: new Date('2026-11-04T10:00:00.000Z'), commit: 'abc1234def' },
    stickies: [{ ref: stickyRef('Ordering.Placed', 'test'), label: '注文した' }, { ref: stickyRef('Ordering.Place', 'test') }],
    views: { 'big-picture': graph, 'design-level': graph },
    ...over,
});
const entry = (storming: string): Parameters<typeof shownStorming>[0][number] => ({
    storming,
    version: 'v1',
    drawing: { at: new Date() },
    publishedAt: new Date(),
});

describe('where the page is', () => {
    test('read from the query and written back, the default level left out', () => {
        expect(locationOf('')).toEqual({ level: DEFAULT_LEVEL });
        expect(locationOf('?project=shop&storming=Ordering&level=big-picture')).toEqual({ project: 'shop', storming: 'Ordering', level: 'big-picture' });
        expect(locationOf('?level=nonsense').level).toBe(DEFAULT_LEVEL);
        expect(searchOf({ project: 'shop', storming: 'Ordering', level: DEFAULT_LEVEL })).toBe('?project=shop&storming=Ordering');
        expect(searchOf({ level: 'big-picture' })).toBe('?level=big-picture');
        expect(searchOf({ level: DEFAULT_LEVEL })).toBe('');
    });

    test('the storming shown: the one asked for when it is published, else the first', () => {
        const entries = [entry('Billing'), entry('Ordering')];
        expect(shownStorming(entries, 'Ordering')).toBe('Ordering');
        expect(shownStorming(entries, 'Gone')).toBe('Billing');
        expect(shownStorming([], undefined)).toBeUndefined();
    });
});

describe('the drawing', () => {
    test('a level of the published form, checked for what the canvas reads', () => {
        expect(drawingOf(form(), 'design-level').id).toBe('es-dl');
        expect(() => drawingOf(form({ views: { 'big-picture': { nodes: 'x' }, 'design-level': graph } }), 'big-picture')).toThrow(DrawingError);
    });

    test('the date of the drawing with its commit, short', () => {
        expect(drawingDate(form().drawing, 'ja')).toBe('2026/11/4 · abc1234');
        expect(drawingDate({ at: new Date('2026-11-04T10:00:00.000Z') }, 'en')).toBe('11/4/2026');
    });
});

test('the stickies’ names as the canvas shows them; a sticky no published storming has keeps its reference', () => {
    const name = stickyNames([form()], 'label');
    expect(name('Ordering.Placed')).toBe('注文した');
    expect(name('Ordering.Place')).toBe('Place');
    expect(name('Billing.Paid')).toBe('Billing.Paid');
    expect(stickyNames([form()], 'name')('Ordering.Placed')).toBe('Placed');
});
