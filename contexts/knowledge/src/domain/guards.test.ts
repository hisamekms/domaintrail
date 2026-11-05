// The guards of an extraction (ADR 0031, section 3): add and addSource at once; update and conflict held until a later
// extraction makes the same call, or the topic stays quiet; dropped when a later call differs, or when the session ends
// with them still held.
import { describe, expect, test } from 'bun:test';
import type { Knowledge } from '../generated/index.js';
import { droppedOutcome, guardExtraction, type HeldKind, type HeldOperation, nextSettleAt, sameCall, settleHeld } from './guards.js';
import { content, itemId, source, version } from '../test-helpers.js';

const SETTLE = 120_000;
const t = (s: number): Date => new Date(Date.UTC(2026, 10, 5, 9, 0, s));

const update = (item: string, over: { kind?: Knowledge.KnowledgeKind; when?: Knowledge.When; about?: string[]; text?: string } = {}): HeldKind => {
    const c = content(over.text ?? 'more precise', 'said', over.about ?? ['Ordering.CreateSpecification']);
    return {
        kind: 'Update',
        item: itemId(item),
        base: version(1),
        revised: { ...c, labels: { ...c.labels, kind: over.kind ?? 'rule', when: over.when ?? 'as_is' } },
    };
};
const conflict = (item: string, id = 'kn_00000099'): HeldKind => ({
    kind: 'Conflict',
    id: itemId(id),
    content: content('the other way round'),
    sources: [source('s1', 'm9')],
    item: itemId(item),
    base: version(1),
});
const add: Knowledge.Operation = { kind: 'Add', id: itemId('kn_00000050'), content: content('a new rule'), sources: [source('s1', 'm1')] };
const held = (operation: HeldKind, heldIn: number, heldAt: Date): HeldOperation => ({ operation, heldIn, heldAt });
const guard = (proposed: readonly Knowledge.Operation[], earlier: readonly HeldOperation[], over: { number?: number; now?: Date; ended?: boolean } = {}) =>
    guardExtraction({ proposed, held: earlier, number: over.number ?? 2, talkAt: t(30), now: over.now ?? t(40), settleMs: SETTLE, ended: over.ended ?? false });

describe('the same call', () => {
    test('the same kind of operation on the same item, the same kind and time of finding, a sticky in common', () => {
        expect(sameCall(update('kn_00000001'), update('kn_00000001', { text: 'worded otherwise' }))).toBe(true);
        expect(sameCall(update('kn_00000001', { about: ['A.x', 'A.y'] }), update('kn_00000001', { about: ['A.y'] }))).toBe(true);
        expect(sameCall(update('kn_00000001', { about: [] }), update('kn_00000001', { about: [] }))).toBe(true);
    });

    test('not the same: another item, another operation, another kind or time, no sticky in common', () => {
        expect(sameCall(update('kn_00000001'), update('kn_00000002'))).toBe(false);
        expect(sameCall(update('kn_00000001'), conflict('kn_00000001'))).toBe(false);
        expect(sameCall(update('kn_00000001'), update('kn_00000001', { kind: 'flow' }))).toBe(false);
        expect(sameCall(update('kn_00000001'), update('kn_00000001', { when: 'to_be' }))).toBe(false);
        expect(sameCall(update('kn_00000001', { about: ['A.x'] }), update('kn_00000001', { about: ['A.y'] }))).toBe(false);
        expect(sameCall(update('kn_00000001', { about: [] }), update('kn_00000001', { about: ['A.y'] }))).toBe(false);
    });
});

describe('guarding an extraction', () => {
    test('add and addSource apply at once; update and conflict are held, with the extraction and the time of its talk', () => {
        const addSource: Knowledge.Operation = { kind: 'AddSource', item: itemId('kn_00000003'), base: version(1), source: source('s1', 'm2'), agreed: false };
        const d = guard([add, update('kn_00000001'), addSource, conflict('kn_00000002')], []);
        expect(d.apply).toEqual([add, addSource]);
        expect(d.hold).toEqual([held(update('kn_00000001'), 2, t(30)), held(conflict('kn_00000002'), 2, t(30))]);
        expect(d.released).toEqual([]);
    });

    test('a later extraction making the same call applies its own operation (its wording and base) and ends the held one', () => {
        const earlier = held(update('kn_00000001', { text: 'first wording' }), 1, t(0));
        const later = update('kn_00000001', { text: 'second wording' });
        const d = guard([later], [earlier]);
        expect(d.apply).toEqual([later]);
        expect(d.hold).toEqual([]);
        expect(d.released).toEqual([{ held: earlier, outcome: 'confirmed' }]);
    });

    test('a later extraction making another call on the item drops the held one and holds the new', () => {
        const earlier = held(update('kn_00000001'), 1, t(0));
        const other = update('kn_00000001', { kind: 'example' });
        const d = guard([other], [earlier]);
        expect(d.apply).toEqual([]);
        expect(d.hold).toEqual([held(other, 2, t(30))]);
        expect(d.released).toEqual([{ held: earlier, outcome: 'superseded' }]);
    });

    test('an operation held by this very extraction is not confirmed by it', () => {
        const d = guard([update('kn_00000001')], [held(update('kn_00000001'), 2, t(0))]);
        expect(d.apply).toEqual([]);
        expect(d.released.map((r) => r.outcome)).toEqual(['superseded']);
    });

    test('a second call on the same item in one extraction is dropped', () => {
        const d = guard([update('kn_00000001'), conflict('kn_00000001')], []);
        expect(d.hold.map((h) => h.operation.kind)).toEqual(['Update']);
        expect(d.duplicates.map((o) => o.kind)).toEqual(['Conflict']);
    });

    test('a held operation the extraction made no call on applies once its topic was quiet long enough, else stays held', () => {
        const settledOne = held(update('kn_00000001'), 1, t(0));
        const fresh = held(update('kn_00000002'), 1, t(30));
        const d = guard([], [settledOne, fresh], { now: new Date(t(0).getTime() + SETTLE) });
        expect(d.apply).toEqual([settledOne.operation]);
        expect(d.hold).toEqual([fresh]);
        expect(d.released).toEqual([{ held: settledOne, outcome: 'settled' }]);
    });

    test('at the session end what is still held is dropped, and so are the updates and conflicts of the last extraction', () => {
        const earlier = held(update('kn_00000001'), 1, t(29));
        const d = guard([conflict('kn_00000002'), add], [earlier], { ended: true });
        expect(d.apply).toEqual([add]);
        expect(d.hold).toEqual([]);
        expect(d.released).toEqual([{ held: earlier, outcome: 'ended' }]);
        expect(d.endDropped).toEqual([conflict('kn_00000002')]);
        expect(droppedOutcome('ended')).toBe(true);
    });

    test('at the session end a held one the last extraction confirms, or one already settled, still applies', () => {
        const confirmed = held(update('kn_00000001'), 1, t(29));
        const quiet = held(update('kn_00000002'), 1, t(0));
        const d = guard([update('kn_00000001')], [confirmed, quiet], { ended: true, now: new Date(t(0).getTime() + SETTLE) });
        expect(d.apply).toEqual([update('kn_00000001'), quiet.operation]);
        expect(d.released).toEqual([
            { held: confirmed, outcome: 'confirmed' },
            { held: quiet, outcome: 'settled' },
        ]);
        expect(d.endDropped).toEqual([]);
    });

    test('settling without an extraction, and when the first held settles', () => {
        const a = held(update('kn_00000001'), 1, t(0));
        const b = held(update('kn_00000002'), 1, t(50));
        expect(nextSettleAt([], SETTLE)).toBeUndefined();
        expect(nextSettleAt([b, a], SETTLE)).toEqual(new Date(t(0).getTime() + SETTLE));
        const d = settleHeld([a, b], new Date(t(0).getTime() + SETTLE), SETTLE);
        expect(d.apply).toEqual([a.operation]);
        expect(d.hold).toEqual([b]);
        // the session ends: nothing settled yet is dropped
        const end = settleHeld([a, b], t(1), SETTLE, true);
        expect(end.apply).toEqual([]);
        expect(end.hold).toEqual([]);
        expect(end.released.map((r) => r.outcome)).toEqual(['ended', 'ended']);
    });
});
