// The commands of a knowledge item (ADR 0031, section 3): an update rewrites in place within the session that made the
// item, a new source may raise `said` to `agreed`, a conflict needs a source on both sides.
import { describe, expect, test } from 'bun:test';
import type { Knowledge } from '../generated/index.js';
import { knowledgeItemCommands as commands } from './items.js';
import { at, content, extraction, itemId, later, liveItem, source, stickyRef, userName, version } from '../test-helpers.js';

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
    return r.value;
};
const error = <E>(r: { ok: true } | { ok: false; error: E }): E => {
    if (r.ok) throw new Error('expected an error');
    return r.error;
};

describe('add', () => {
    test('makes version 1 in the extraction’s session, with its sources', () => {
        const by = extraction('s1', 1);
        const { aggregate, events } = value(
            commands.add({ id: itemId('kn_00000001'), content: content('a rule'), sources: [source('s1', 'm1')], by, at }),
        ).Live;
        expect(aggregate).toMatchObject({ state: 'Live', version: 1, createdIn: 's1', conflictsWith: [], createdAt: at, updatedAt: at });
        expect(events.KnowledgeItemAdded).toEqual({ type: 'KnowledgeItemAdded', itemId: aggregate.id, version: aggregate.version, conflictsWith: [], by, at });
    });

    test('refuses the same message twice among its sources', () => {
        const r = commands.add({
            id: itemId('kn_00000001'),
            content: content('a rule'),
            sources: [source('s1', 'm1'), source('s1', 'm1', 'again')],
            by: extraction('s1', 1),
            at,
        });
        expect(error(r)).toEqual({ type: 'Knowledge.DuplicateSource' });
    });
});

describe('update', () => {
    test('a rewording of an item of this session, resting on a message it already has, is rewritten in place', () => {
        const item = liveItem('kn_00000001', { createdIn: 's1' });
        const { aggregate, events } = value(
            commands.update(item, {
                revised: content('more precise'),
                newSources: [source('s1', 'm-kn_00000001')],
                base: version(1),
                by: extraction('s1', 3),
                at: later,
            }),
        ).Live;
        expect(aggregate).toMatchObject({ version: 1, content: content('more precise'), sources: item.sources, updatedAt: later });
        expect(Object.keys(events)).toEqual(['KnowledgeItemRewritten']);
    });

    test('an update that adds a source makes a new version even of an item of this session, the source appended once', () => {
        const item = liveItem('kn_00000001', { createdIn: 's1' });
        const correction = source('s1', 'm-correction', '14日は間違いで、正しくは30日');
        const { aggregate, events } = value(
            commands.update(item, {
                revised: content('返品は30日まで'),
                newSources: [correction, source('s1', 'm-kn_00000001'), correction],
                base: version(1),
                by: extraction('s1', 3),
                at: later,
            }),
        ).Live;
        expect(aggregate.version).toBe(version(2));
        expect(aggregate.sources).toEqual([...item.sources, correction]);
        expect(Object.keys(events)).toEqual(['KnowledgeItemRevised']);
    });

    test('makes a new version of an item of an earlier session, or written by hand', () => {
        for (const item of [liveItem('kn_00000001', { createdIn: 's0' }), liveItem('kn_00000002')]) {
            const { aggregate, events } = value(
                commands.update(item, {
                    revised: content('more precise'),
                    newSources: [source('s1', 'm-new')],
                    base: version(1),
                    by: extraction('s1', 3),
                    at: later,
                }),
            ).Live;
            expect(aggregate.version).toBe(version(2));
            expect(events).toEqual({
                KnowledgeItemRevised: { type: 'KnowledgeItemRevised', itemId: item.id, version: version(2), by: extraction('s1', 3), at: later },
            });
        }
    });

    test('makes a new version of an item of this session that a person corrected: the correction is never overwritten', () => {
        const item = liveItem('kn_00000001', { createdIn: 's1', version: 2 });
        const { aggregate, events } = value(
            commands.update(item, {
                revised: content('more precise'),
                newSources: [source('s1', 'm-new')],
                base: version(2),
                by: extraction('s1', 3),
                at: later,
            }),
        ).Live;
        expect(aggregate.version).toBe(version(3));
        expect(events.KnowledgeItemRevised).toBeDefined();
    });

    test('refuses an item that changed since the extraction saw it', () => {
        const item = liveItem('kn_00000001', { createdIn: 's1', version: 2 });
        expect(
            error(
                commands.update(item, { revised: content('more precise'), newSources: [source('s1', 'm-new')], base: version(1), by: extraction('s1', 3), at }),
            ),
        ).toEqual({
            type: 'Knowledge.StaleOperation',
        });
    });
});

describe('addSource', () => {
    const by = extraction('s2', 1);
    const origin = (item: Knowledge.LiveKnowledgeItem, agreed: boolean): Knowledge.Origin =>
        value(commands.addSource(item, { source: source('s2', 'm9'), agreed, base: item.version, by, at: later })).Live.aggregate.content.labels.origin;

    test('keeps one more source, and raises said to agreed when the talk agreed', () => {
        const item = liveItem('kn_00000001', { origin: 'said' });
        const { aggregate, events } = value(commands.addSource(item, { source: source('s2', 'm9'), agreed: true, base: version(1), by, at: later })).Live;
        expect(aggregate.sources).toEqual([...item.sources, source('s2', 'm9')]);
        expect(aggregate.content.labels.origin).toBe('agreed');
        expect(aggregate.version).toBe(item.version);
        expect(events.KnowledgeSourceAdded.agreed).toBe(true);
        expect(origin(item, false)).toBe('said');
    });

    test('leaves the other origins: what the AI found or guessed does not become agreed', () => {
        for (const o of ['agreed', 'investigated', 'inferred'] as const) expect(origin(liveItem('kn_00000001', { origin: o }), true)).toBe(o);
    });

    test('refuses a message already among the sources', () => {
        const item = liveItem('kn_00000001', { sources: [source('s2', 'm9')] });
        expect(error(commands.addSource(item, { source: source('s2', 'm9', 'other words'), agreed: false, base: version(1), by, at }))).toEqual({
            type: 'Knowledge.DuplicateSource',
        });
    });
});

describe('a conflict', () => {
    const by = extraction('s2', 1);

    test('links the older item to the new one, both kept', () => {
        const older = liveItem('kn_00000001');
        const added = value(
            commands.addConflicting({ id: itemId('kn_00000002'), content: content('the opposite'), sources: [source('s2', 'm1')], other: older.id, by, at }),
        ).Live.aggregate;
        const linked = value(commands.linkConflict(older, { other: added.id, base: version(1), by, at })).Live.aggregate;
        expect(added.conflictsWith).toEqual([older.id]);
        expect(linked.conflictsWith).toEqual([added.id]);
        expect(linked.content).toEqual(older.content);
        // linking again keeps one link
        expect(value(commands.linkConflict(linked, { other: added.id, base: version(1), by, at })).Live.aggregate.conflictsWith).toEqual([added.id]);
    });

    test('needs a source on the older side, and is not with the item itself', () => {
        const unsourced = liveItem('kn_00000001', { sources: [] });
        expect(error(commands.linkConflict(unsourced, { other: itemId('kn_00000002'), base: version(1), by, at }))).toEqual({
            type: 'Knowledge.ConflictWithoutSource',
        });
        const older = liveItem('kn_00000001');
        expect(error(commands.linkConflict(older, { other: older.id, base: version(1), by, at }))).toEqual({ type: 'Knowledge.ConflictWithItself' });
    });
});

describe("a person's edits", () => {
    test('a bookmark changes only the shared marker and records the action time', () => {
        const item = liveItem('kn_00000001');
        const by = userName('alice@example.com');
        const { aggregate, events } = value(commands.setBookmark(item, { bookmarked: true, by, at: later })).Live;
        expect(aggregate).toEqual({ ...item, bookmarked: true });
        expect(events.KnowledgeBookmarkChanged).toEqual({
            type: 'KnowledgeBookmarkChanged',
            itemId: item.id,
            version: item.version,
            bookmarked: true,
            by,
            at: later,
        });
    });

    const person = userName('a@example.com');

    test('a correction is always a new version, even of an item of the running session', () => {
        const item = liveItem('kn_00000001', { createdIn: 's1' });
        const { aggregate, events } = value(commands.correct(item, { corrected: content('as it is'), by: person, at: later })).Live;
        expect(aggregate.version).toBe(version(2));
        expect(events.KnowledgeItemCorrected).toEqual({ type: 'KnowledgeItemCorrected', itemId: item.id, version: version(2), by: person, at: later });
    });

    test('a deletion hides the item; restoring brings it back as it was', () => {
        const item = liveItem('kn_00000001');
        const gone = value(commands.delete(item, { by: person, at: later })).Deleted.aggregate;
        expect(gone).toMatchObject({ state: 'Deleted', deletedBy: person, deletedAt: later });
        const back = value(commands.restore(gone, { by: person, at: later })).Live.aggregate;
        expect(back).toEqual(item);
    });
});

describe('unlinkConflict', () => {
    test('removes the link, keeps the content and the version, and records who', () => {
        const item = liveItem('kn_00000001', { conflictsWith: ['kn_00000002', 'kn_00000003'] });
        const { aggregate, events } = value(commands.unlinkConflict(item, { other: itemId('kn_00000002'), by: userName('alice@example.com'), at: later })).Live;
        expect(aggregate).toMatchObject({ version: 1, content: item.content, conflictsWith: ['kn_00000003'], updatedAt: later });
        expect(events.KnowledgeConflictUnlinked).toEqual({
            type: 'KnowledgeConflictUnlinked',
            itemId: item.id,
            version: item.version,
            other: itemId('kn_00000002'),
            by: userName('alice@example.com'),
            at: later,
        });
    });

    test('refuses the item itself', () => {
        const item = liveItem('kn_00000001');
        expect(error(commands.unlinkConflict(item, { other: item.id, by: userName('alice@example.com'), at: later }))).toEqual({
            type: 'Knowledge.ConflictWithItself',
        });
    });
});

describe('handOverToHotspot', () => {
    const hotspot = stickyRef('Ordering.CutOffUnclear');

    test('adds the hotspot to about and removes the link in one decision, keeping the text, labels and version', () => {
        const item = liveItem('kn_00000001', { conflictsWith: ['kn_00000002', 'kn_00000003'] });
        const { aggregate, events } = value(
            commands.handOverToHotspot(item, { hotspot, other: itemId('kn_00000002'), by: userName('alice@example.com'), at: later }),
        ).Live;
        expect(aggregate).toMatchObject({
            version: 1,
            content: { ...item.content, about: [...item.content.about, hotspot] },
            conflictsWith: ['kn_00000003'],
            updatedAt: later,
        });
        expect(events.KnowledgeHandedOverToHotspot).toEqual({
            type: 'KnowledgeHandedOverToHotspot',
            itemId: item.id,
            version: item.version,
            hotspot,
            other: itemId('kn_00000002'),
            by: userName('alice@example.com'),
            at: later,
        });
    });

    test('a second hand-over changes nothing but the time', () => {
        const item = liveItem('kn_00000001', { conflictsWith: ['kn_00000002'] });
        const once = value(commands.handOverToHotspot(item, { hotspot, other: itemId('kn_00000002'), by: userName('a@example.com'), at })).Live.aggregate;
        const twice = value(commands.handOverToHotspot(once, { hotspot, other: itemId('kn_00000002'), by: userName('a@example.com'), at: later })).Live
            .aggregate;
        expect(twice).toEqual({ ...once, updatedAt: later });
    });

    test('refuses the item itself', () => {
        const item = liveItem('kn_00000001');
        expect(error(commands.handOverToHotspot(item, { hotspot, other: item.id, by: userName('a@example.com'), at: later }))).toEqual({
            type: 'Knowledge.ConflictWithItself',
        });
    });
});
