// The page's messages over the WebSocket, as the server takes them (client-messages.ts): the camera a page shows, which
// another page following it fits (ADR 0026, "Following someone").
import { describe, expect, test } from 'bun:test';
import { parseClientMessage } from './client-messages';

const location = { kind: 'dtes', stormingId: 'Ordering', level: 'big-picture', layoutKey: 'storming:Ordering#1' } as const;
const update = (extra: Record<string, unknown>): string => JSON.stringify({ type: 'presence.update', location, ...extra });

describe('the camera of a presence update', () => {
    test('is taken as the part of the page shown: a corner and a size', () => {
        expect(parseClientMessage(update({ camera: { x: -120.5, y: 40, w: 1600, h: 900.2 } }))).toEqual({
            type: 'presence.update',
            location,
            camera: { x: -120.5, y: 40, w: 1600, h: 900.2 },
        });
    });

    test('is optional: a page before it sends none', () => {
        expect(parseClientMessage(update({}))).toEqual({ type: 'presence.update', location });
        expect(parseClientMessage(update({ camera: null }))).toEqual({ type: 'presence.update', location });
    });

    test('drops the whole message when the camera is not one: a size of zero or less, out of reach, not a number, other keys', () => {
        for (const camera of [
            { x: 0, y: 0, w: 0, h: 600 },
            { x: 0, y: 0, w: 800, h: -1 },
            { x: 1e8, y: 0, w: 800, h: 600 },
            { x: 0, y: 0, w: 1e8, h: 600 },
            { x: '0', y: 0, w: 800, h: 600 },
            { x: 0, y: 0, w: 800 },
            { x: 0, y: 0, w: 800, h: 600, z: 1 },
            [0, 0, 800, 600],
            'everything',
        ])
            expect(parseClientMessage(update({ camera }))).toBeUndefined();
        // JSON has no NaN nor Infinity: they come as null, which is no camera
        expect(parseClientMessage(update({ camera: { x: Number.NaN, y: 0, w: 800, h: 600 } }))).toBeUndefined();
    });

    test('travels with the cursor and the selection', () => {
        expect(parseClientMessage(update({ cursor: { x: 1, y: 2 }, camera: { x: 0, y: 0, w: 10, h: 10 } }))).toEqual({
            type: 'presence.update',
            location,
            cursor: { x: 1, y: 2 },
            camera: { x: 0, y: 0, w: 10, h: 10 },
        });
    });
});

describe('the location of a storming', () => {
    const at = (extra: Record<string, unknown>): unknown =>
        parseClientMessage(JSON.stringify({ type: 'presence.update', location: { ...location, ...extra } }));

    test('its main flow and its exceptions’ layer excluded', () => {
        expect(at({ timelineId: 'Normal', exceptions: false })).toEqual({
            type: 'presence.update',
            location: { ...location, timelineId: 'Normal', exceptions: false },
        });
    });

    test('drops the message for exceptions other than excluded, or another key (a stage)', () => {
        expect(at({ exceptions: true })).toBeUndefined();
        expect(at({ exceptions: 'no' })).toBeUndefined();
        expect(at({ stageId: 'Issuance' })).toBeUndefined();
    });
});
