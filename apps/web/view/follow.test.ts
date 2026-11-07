// Following (view/follow.ts): whom the page follows, how it changes, and the one place that tells the reader's own moves
// from a followee's.
import { describe, expect, test } from 'bun:test';
import type { DiagramCanvas } from './diagram';
import {
    AI_FOLLOWEE,
    isFollowing,
    nextFollowee,
    readerCanvas,
    readerNavigation,
    readerSettings,
    type Followee,
    type NavigationMoves,
    type SettingsMoves,
} from './follow';

const sato: Followee = { kind: 'person', participant: 'dev:sato' };
const tanaka: Followee = { kind: 'person', participant: 'dev:tanaka' };

describe('whom the page follows', () => {
    test('the reader chooses someone, or no one; one at a time: the AI or a person, the last chosen', () => {
        expect(nextFollowee(null, { kind: 'choose', followee: AI_FOLLOWEE })).toEqual(AI_FOLLOWEE);
        expect(nextFollowee(AI_FOLLOWEE, { kind: 'choose', followee: sato })).toEqual(sato);
        expect(nextFollowee(sato, { kind: 'choose', followee: tanaka })).toEqual(tanaka);
        expect(nextFollowee(sato, { kind: 'choose', followee: AI_FOLLOWEE })).toEqual(AI_FOLLOWEE);
        expect(nextFollowee(AI_FOLLOWEE, { kind: 'choose', followee: null })).toBeNull();
    });

    test("the reader's own move stops following, whoever it was (no question asked)", () => {
        expect(nextFollowee(AI_FOLLOWEE, { kind: 'mine' })).toBeNull();
        expect(nextFollowee(sato, { kind: 'mine' })).toBeNull();
        expect(nextFollowee(null, { kind: 'mine' })).toBeNull();
    });

    test('a request the reader sends to the AI starts following it, instead of a person followed', () => {
        expect(nextFollowee(null, { kind: 'asked' })).toEqual(AI_FOLLOWEE);
        expect(nextFollowee(sato, { kind: 'asked' })).toEqual(AI_FOLLOWEE);
    });

    test('a participant who left the session is no longer followed; the AI and those still here are', () => {
        const here = new Set(['dev:tanaka']);
        expect(nextFollowee(sato, { kind: 'present', participants: here })).toBeNull();
        expect(nextFollowee(tanaka, { kind: 'present', participants: here })).toEqual(tanaka);
        expect(nextFollowee(AI_FOLLOWEE, { kind: 'present', participants: new Set() })).toEqual(AI_FOLLOWEE);
    });

    test('whether it is the AI, or a given participant', () => {
        expect(isFollowing(AI_FOLLOWEE, 'ai')).toBe(true);
        expect(isFollowing(sato, 'ai')).toBe(false);
        expect(isFollowing(sato, { participant: 'dev:sato' })).toBe(true);
        expect(isFollowing(sato, { participant: 'dev:tanaka' })).toBe(false);
        expect(isFollowing(null, 'ai')).toBe(false);
    });
});

/** A canvas recording its calls, in order. */
function recording(calls: string[]): DiagramCanvas {
    const record = (name: string) => (): void => {
        calls.push(name);
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the moves and a getter, all a reader's canvas wraps or passes on
    return {
        setCamera: record('setCamera'),
        zoomIn: record('zoomIn'),
        zoomOut: record('zoomOut'),
        resetZoom: record('resetZoom'),
        fitContent: record('fitContent'),
        fitBounds: record('fitBounds'),
        fitSelection: record('fitSelection'),
        centerOn: record('centerOn'),
        select: record('select'),
        selectNone: record('selectNone'),
        getZoom: () => {
            calls.push('getZoom');
            return 1;
        },
    } as unknown as DiagramCanvas;
}

describe("the reader's own moves (one place)", () => {
    test("every camera move and selection asked through the reader's canvas stops following first; reading it does not", () => {
        const calls: string[] = [];
        const c = readerCanvas(recording(calls), () => calls.push('mine'));
        c.setCamera({ x: 0, y: 0, z: 1 });
        c.zoomIn();
        c.zoomOut();
        c.resetZoom();
        c.fitContent();
        c.fitBounds({ x: 0, y: 0, w: 1, h: 1 }, {});
        c.fitSelection();
        c.centerOn({ x: 0, y: 0 });
        c.select([]);
        c.selectNone();
        c.getZoom();
        const moves = ['setCamera', 'zoomIn', 'zoomOut', 'resetZoom', 'fitContent', 'fitBounds', 'fitSelection', 'centerOn', 'select', 'selectNone'];
        expect(calls).toEqual([...moves.flatMap((m) => ['mine', m]), 'getZoom']);
    });

    test('showing a view, selecting, going back and revealing are the reader’s own; the current navigation is used', () => {
        const calls: string[] = [];
        const nav = (n: string): NavigationMoves => ({
            setView: () => calls.push(`${n}.setView`),
            select: () => calls.push(`${n}.select`),
            goBack: () => calls.push(`${n}.goBack`),
            reveal: () => calls.push(`${n}.reveal`),
        });
        let current = nav('a');
        const reader = readerNavigation(
            () => current,
            () => calls.push('mine'),
        );
        reader.setView({ kind: 'storming' });
        current = nav('b');
        reader.select('es/S/x');
        reader.goBack();
        reader.reveal('structure', 'Sales.Order');
        expect(calls).toEqual(['mine', 'a.setView', 'mine', 'b.select', 'mine', 'b.goBack', 'mine', 'b.reveal']);
    });

    test('every change of what a view draws is the reader’s own: a level, a storming, its place or its flow, the contexts, 詰めて表示', () => {
        const calls: string[] = [];
        const set = (name: string) => (): void => {
            calls.push(name);
        };
        const settings: SettingsMoves = {
            setStructureLevel: set('level'),
            setStructureContexts: set('contexts'),
            setHiddenContexts: set('hidden'),
            setMapAll: set('mapAll'),
            setStormingChoice: set('storming'),
            setCompact: set('compact'),
        };
        const reader = readerSettings(
            () => settings,
            () => calls.push('mine'),
        );
        reader.setStructureLevel('overview');
        reader.setStructureContexts(null);
        reader.setHiddenContexts([]);
        reader.setMapAll(true);
        reader.setStormingChoice({ stormingId: 'S', level: 'big-picture', timelines: {} });
        // the flow switch (主な流れ, 例外も, 例外 ▾) changes the choice through the same setter
        reader.setStormingChoice({ stormingId: 'S', level: 'big-picture', timelines: {}, flow: { exception: 'Failed' } });
        reader.setCompact(true);
        expect(calls).toEqual(['level', 'contexts', 'hidden', 'mapAll', 'storming', 'storming', 'compact'].flatMap((m) => ['mine', m]));
    });
});
