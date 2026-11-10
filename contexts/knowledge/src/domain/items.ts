// The commands of a knowledge item (ADR 0031, sections 2, 3 and 7), each a pure decision made with the runtime's
// `decide`. The requirements are checked with the generated `check…Requires`, so their expressions are the DSL's; what
// is written here is which error each returns and what each outcome sets. IDs and times are parameters: the extraction
// names its new items (`Operation`), the application gives the time.
//
// - add / addConflicting: a new item, version 1, made in the extraction's session;
// - addSource: one more source; `agreed` raises `said` to `agreed` and leaves the other origins (what the AI found or
//   guessed does not become a person's word by being said again);
// - update: the messages it rests on join the sources (those already there once); one that adds a source always makes
//   a new version, the store keeping the item it replaced, so that a correction can be followed to its message (ADR
//   0031, section 3, as amended); a rewording that adds no source is rewritten in place, without a new version, while
//   the item is the one its session made (created in that session and still version 1: a person's correction, or an
//   update with a source, makes version 2, which is never overwritten), else a new version too;
// - linkConflict: the older side of a conflict, linked to the new one; both sides must have a source;
// - unlinkConflict: a person decides two linked items do not conflict (食い違いではない): the link goes, the content and
//   the version stay (the store unlinks both sides);
// - handOverToHotspot: a conflict a person made a hotspot is handed over to the hotspot the AI added: the hotspot joins
//   `about` and the link goes, in one decision; the text, the labels and the version stay (the store does both sides);
// - correct: a person's edit, always a new version;
// - retire / unretire: a person retires an item (廃止する), with a reason or none, or undoes it; the text, the sources
//   and the versions stay, the item is only hidden by default and kept from the AI (see `domain/retirement.ts`);
// - delete / restore: a person hides the item at once, and may undo it until the store's sweep removes it.
import { decide, err, Knowledge, ok } from '../generated/index.js';

/** The first version of an item. */
export const FIRST_VERSION = knownVersion(1);

/** A version known to be one (a positive integer); anything else is a programming error, never input. */
function knownVersion(v: number): Knowledge.ItemVersion {
    const made = Knowledge.makeItemVersion(v);
    if (!made.ok) throw new Error(`Not a version: ${v}`);
    return made.value;
}

/** The version after this one. */
export const nextVersion = (v: Knowledge.ItemVersion): Knowledge.ItemVersion => knownVersion(v + 1);

/** The sources not yet among the item's (by session and message), each once. */
export function newSourcesOf(item: Pick<Knowledge.KnowledgeItemCommon, 'sources'>, sources: readonly Knowledge.Source[]): Knowledge.Source[] {
    const key = (s: Knowledge.Source): string => `${s.session}\u0000${s.message}`;
    const seen = new Set(item.sources.map(key));
    return sources.filter((s) => {
        if (seen.has(key(s))) return false;
        seen.add(key(s));
        return true;
    });
}

/**
 * Whether an update of the extraction `by` with `sources` rewrites the item in place: it adds no source (a rewording),
 * the item was made in that session and nobody has made another version of it since (ADR 0031, section 3: an update
 * that adds a source keeps a version, so that the correction can be followed to its message).
 */
export const rewritesInPlace = (item: Knowledge.KnowledgeItemCommon, by: Knowledge.ExtractionRef, sources: readonly Knowledge.Source[] = []): boolean =>
    newSourcesOf(item, sources).length === 0 && item.createdIn === by.session && item.version === FIRST_VERSION;

/** The labels after one more source: `said` becomes `agreed` when the talk agreed; other origins stay. */
export function raisedOrigin(labels: Knowledge.Labels, agreed: boolean): Knowledge.Labels {
    return agreed && labels.origin === 'said' ? { ...labels, origin: 'agreed' } : labels;
}

/**
 * The item as it is read: its conflicts with live items only. A conflict whose other side was deleted — hidden at once,
 * then removed by the sweep — has nothing left to show, so the item shows no conflict; the link itself stays in the
 * store, so 元に戻す brings the conflict back.
 */
export function withLiveConflicts(item: Knowledge.LiveKnowledgeItem, isLive: (id: Knowledge.KnowledgeItemId) => boolean): Knowledge.LiveKnowledgeItem {
    const conflictsWith = item.conflictsWith.filter(isLive);
    return conflictsWith.length === item.conflictsWith.length ? item : { ...item, conflictsWith };
}

export const knowledgeItemCommands: Knowledge.KnowledgeItemCommands = {
    add: decide<Knowledge.AddKnowledgeItemDecision>(Knowledge.KnowledgeItemShape, (params) => {
        if (Knowledge.checkAddKnowledgeItemRequires(params) === 'distinctSources') return err({ type: 'DuplicateSource' });
        const { id, content, sources, by, reason, at } = params;
        return ok({
            Live: {
                set: {
                    id,
                    content,
                    sources,
                    version: FIRST_VERSION,
                    conflictsWith: [],
                    createdIn: by.session,
                    createdAt: at,
                    updatedAt: at,
                    bookmarked: undefined,
                    retirement: undefined,
                },
                events: {
                    KnowledgeItemAdded: {
                        type: 'KnowledgeItemAdded',
                        itemId: id,
                        version: FIRST_VERSION,
                        conflictsWith: [],
                        by,
                        ...(reason && { reason }),
                        at,
                    },
                },
            },
        });
    }),

    addConflicting: decide<Knowledge.AddConflictingKnowledgeItemDecision>(Knowledge.KnowledgeItemShape, (params) => {
        switch (Knowledge.checkAddConflictingKnowledgeItemRequires(params)) {
            case 'distinctSources':
                return err({ type: 'DuplicateSource' });
            case 'notItself':
                return err({ type: 'ConflictWithItself' });
        }
        const { id, content, sources, other, by, reason, at } = params;
        return ok({
            Live: {
                set: {
                    id,
                    content,
                    sources,
                    version: FIRST_VERSION,
                    conflictsWith: [other],
                    createdIn: by.session,
                    createdAt: at,
                    updatedAt: at,
                    bookmarked: undefined,
                    retirement: undefined,
                },
                events: {
                    KnowledgeItemAdded: {
                        type: 'KnowledgeItemAdded',
                        itemId: id,
                        version: FIRST_VERSION,
                        conflictsWith: [other],
                        by,
                        ...(reason && { reason }),
                        at,
                    },
                },
            },
        });
    }),

    addSource: decide<Knowledge.AddSourceKnowledgeItemDecision>(Knowledge.KnowledgeItemShape, {
        Live: (item, params) => {
            switch (Knowledge.checkAddSourceKnowledgeItemRequires(item, params)) {
                case 'current':
                    return err({ type: 'StaleOperation' });
                case 'newSource':
                    return err({ type: 'DuplicateSource' });
            }
            const { source, agreed, by, reason, at } = params;
            const labels = raisedOrigin(item.content.labels, agreed);
            return ok({
                Live: {
                    set: { content: { ...item.content, labels }, sources: [...item.sources, source], updatedAt: at },
                    events: {
                        KnowledgeSourceAdded: {
                            type: 'KnowledgeSourceAdded',
                            itemId: item.id,
                            version: item.version,
                            // whether it raised the origin, for the audit log
                            agreed: labels !== item.content.labels,
                            by,
                            ...(reason && { reason }),
                            at,
                        },
                    },
                },
            });
        },
    }),

    update: decide<Knowledge.UpdateKnowledgeItemDecision>(Knowledge.KnowledgeItemShape, {
        Live: (item, params) => {
            if (Knowledge.checkUpdateKnowledgeItemRequires(item, params) === 'current') return err({ type: 'StaleOperation' });
            const { revised, newSources, by, reason, at } = params;
            const why = reason && { reason };
            const sources = [...item.sources, ...newSourcesOf(item, newSources)];
            if (rewritesInPlace(item, by, newSources))
                return ok({
                    Live: {
                        set: { content: revised, sources, version: item.version, updatedAt: at },
                        events: { KnowledgeItemRewritten: { type: 'KnowledgeItemRewritten', itemId: item.id, version: item.version, by, ...why, at } },
                    },
                });
            const version = nextVersion(item.version);
            return ok({
                Live: {
                    set: { content: revised, sources, version, updatedAt: at },
                    events: { KnowledgeItemRevised: { type: 'KnowledgeItemRevised', itemId: item.id, version, by, ...why, at } },
                },
            });
        },
    }),

    linkConflict: decide<Knowledge.LinkConflictKnowledgeItemDecision>(Knowledge.KnowledgeItemShape, {
        Live: (item, params) => {
            switch (Knowledge.checkLinkConflictKnowledgeItemRequires(item, params)) {
                case 'current':
                    return err({ type: 'StaleOperation' });
                case 'notItself':
                    return err({ type: 'ConflictWithItself' });
                case 'sourced':
                    return err({ type: 'ConflictWithoutSource' });
            }
            const { other, by, reason, at } = params;
            // linking twice keeps one link
            const conflictsWith = item.conflictsWith.includes(other) ? item.conflictsWith : [...item.conflictsWith, other];
            return ok({
                Live: {
                    set: { conflictsWith, updatedAt: at },
                    events: {
                        KnowledgeConflictLinked: {
                            type: 'KnowledgeConflictLinked',
                            itemId: item.id,
                            version: item.version,
                            other,
                            by,
                            ...(reason && { reason }),
                            at,
                        },
                    },
                },
            });
        },
    }),

    unlinkConflict: decide<Knowledge.UnlinkConflictKnowledgeItemDecision>(Knowledge.KnowledgeItemShape, {
        Live: (item, params) => {
            if (Knowledge.checkUnlinkConflictKnowledgeItemRequires(item, params) === 'notItself') return err({ type: 'ConflictWithItself' });
            const { other, by, at } = params;
            // unlinking what is not linked changes nothing but the time (a retry, or the other side unlinked first)
            const conflictsWith = item.conflictsWith.filter((id) => id !== other);
            return ok({
                Live: {
                    set: { conflictsWith, updatedAt: at },
                    events: {
                        KnowledgeConflictUnlinked: { type: 'KnowledgeConflictUnlinked', itemId: item.id, version: item.version, other, by, at },
                    },
                },
            });
        },
    }),

    handOverToHotspot: decide<Knowledge.HandOverToHotspotKnowledgeItemDecision>(Knowledge.KnowledgeItemShape, {
        Live: (item, params) => {
            if (Knowledge.checkHandOverToHotspotKnowledgeItemRequires(item, params) === 'notItself') return err({ type: 'ConflictWithItself' });
            const { hotspot, other, by, at } = params;
            // handing over again changes nothing but the time (a retry after a failure half-way)
            const about = item.content.about.includes(hotspot) ? item.content.about : [...item.content.about, hotspot];
            return ok({
                Live: {
                    set: { content: { ...item.content, about }, conflictsWith: item.conflictsWith.filter((id) => id !== other), updatedAt: at },
                    events: {
                        KnowledgeHandedOverToHotspot: { type: 'KnowledgeHandedOverToHotspot', itemId: item.id, version: item.version, hotspot, other, by, at },
                    },
                },
            });
        },
    }),

    correct: decide<Knowledge.CorrectKnowledgeItemDecision>(Knowledge.KnowledgeItemShape, {
        Live: (item, { corrected, by, at }) => {
            const version = nextVersion(item.version);
            return ok({
                Live: {
                    set: { content: corrected, version, updatedAt: at },
                    events: { KnowledgeItemCorrected: { type: 'KnowledgeItemCorrected', itemId: item.id, version, by, at } },
                },
            });
        },
    }),

    setBookmark: decide<Knowledge.SetBookmarkKnowledgeItemDecision>(Knowledge.KnowledgeItemShape, {
        Live: (item, { bookmarked, by, at }) =>
            ok({
                Live: {
                    set: { bookmarked: bookmarked ? true : undefined, updatedAt: at },
                    events: {
                        KnowledgeBookmarkChanged: {
                            type: 'KnowledgeBookmarkChanged',
                            itemId: item.id,
                            version: item.version,
                            bookmarked,
                            by,
                            at,
                        },
                    },
                },
            }),
    }),

    retire: decide<Knowledge.RetireKnowledgeItemDecision>(Knowledge.KnowledgeItemShape, {
        Live: (item, params) => {
            switch (Knowledge.checkRetireKnowledgeItemRequires(item, params)) {
                case 'notRetired':
                    return err({ type: 'AlreadyRetired' });
                case 'replacementWhenReplaced':
                    return err({ type: 'ReplacementWithoutReason' });
                case 'notReplacedByItself':
                    return err({ type: 'ReplacedByItself' });
            }
            const { reason, replacedBy, proposal, by, at } = params;
            const retirement: Knowledge.Retirement = {
                ...(reason && { reason }),
                ...(replacedBy && { replacedBy }),
                by,
                at,
                ...(proposal && { proposal }),
            };
            return ok({
                Live: {
                    set: { retirement, updatedAt: at },
                    events: {
                        KnowledgeItemRetired: {
                            type: 'KnowledgeItemRetired',
                            itemId: item.id,
                            version: item.version,
                            ...(reason && { reason }),
                            ...(replacedBy && { replacedBy }),
                            ...(proposal && { proposal }),
                            by,
                            at,
                        },
                    },
                },
            });
        },
    }),

    unretire: decide<Knowledge.UnretireKnowledgeItemDecision>(Knowledge.KnowledgeItemShape, {
        Live: (item, params) => {
            if (Knowledge.checkUnretireKnowledgeItemRequires(item, params) === 'retired') return err({ type: 'NotRetired' });
            const { proposal, by, at } = params;
            return ok({
                Live: {
                    set: { retirement: undefined, updatedAt: at },
                    events: {
                        KnowledgeItemUnretired: {
                            type: 'KnowledgeItemUnretired',
                            itemId: item.id,
                            version: item.version,
                            ...(proposal && { proposal }),
                            by,
                            at,
                        },
                    },
                },
            });
        },
    }),

    delete: decide<Knowledge.DeleteKnowledgeItemDecision>(Knowledge.KnowledgeItemShape, {
        Live: (item, { by, at }) =>
            ok({
                Deleted: {
                    set: { deletedBy: by, deletedAt: at, bookmarked: undefined },
                    events: { KnowledgeItemDeleted: { type: 'KnowledgeItemDeleted', itemId: item.id, version: item.version, by, at } },
                },
            }),
    }),

    restore: decide<Knowledge.RestoreKnowledgeItemDecision>(Knowledge.KnowledgeItemShape, {
        Deleted: (item, { by, at }) =>
            ok({ Live: { set: {}, events: { KnowledgeItemRestored: { type: 'KnowledgeItemRestored', itemId: item.id, version: item.version, by, at } } } }),
    }),
};
