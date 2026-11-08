// What a running run is doing (ADR 0026, amendment): the four phases and the subjects a page may show.
import { describe, expect, test } from 'bun:test';
import { MAX_ACTIVITY_SUBJECT, readActivity, sameActivity } from './activity.js';

describe("a run's activity", () => {
    test('one of the four phases, with or without a subject', () => {
        expect(readActivity('reading', 'model/order.dt')).toEqual({ phase: 'reading', subject: 'model/order.dt' });
        expect(readActivity('checking', 'dt check')).toEqual({ phase: 'checking', subject: 'dt check' });
        expect(readActivity('finishing', undefined)).toEqual({ phase: 'finishing' });
        expect(readActivity('thinking', undefined)).toBeUndefined();
        expect(readActivity(1, undefined)).toBeUndefined();
    });

    test('a subject is one short line without control or bidirectional characters', () => {
        expect(readActivity('editing', '')).toBeUndefined();
        expect(readActivity('editing', '  ')).toBeUndefined();
        expect(readActivity('editing', 'a\nb.dt')).toBeUndefined();
        expect(readActivity('editing', 'a‮b.dt')).toBeUndefined();
        expect(readActivity('editing', 'x'.repeat(MAX_ACTIVITY_SUBJECT))).toBeDefined();
        expect(readActivity('editing', 'x'.repeat(MAX_ACTIVITY_SUBJECT + 1))).toBeUndefined();
        expect(readActivity('editing', 42)).toBeUndefined();
    });

    test('two activities are the same when their phase and subject are', () => {
        expect(sameActivity({ phase: 'reading', subject: 'a.dt' }, { phase: 'reading', subject: 'a.dt' })).toBe(true);
        expect(sameActivity({ phase: 'reading', subject: 'a.dt' }, { phase: 'reading', subject: 'b.dt' })).toBe(false);
        expect(sameActivity({ phase: 'reading' }, { phase: 'editing' })).toBe(false);
        expect(sameActivity(undefined, { phase: 'reading' })).toBe(false);
    });
});
