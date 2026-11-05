// The commands of a knowledge item (ADR 0031, sections 2, 3 and 7), each a pure decision made with the runtime's
// `decide`. The requirements are checked with the generated `check…Requires`, so their expressions are the DSL's; what
// is written here is which error each returns and what each outcome sets. IDs and times are parameters: the extraction
// names its new items (`Operation`), the application gives the time.
//
// - add / addConflicting: a new item, version 1, made in the extraction's session;
// - addSource: one more source; `agreed` raises `said` to `agreed` and leaves the other origins (what the AI found or
//   guessed does not become a person's word by being said again);
// - update: rewritten in place, without a new version, while the item is the one its session made (created in that
//   session and still version 1: a person's correction makes version 2, which is never overwritten); otherwise a new
//   version, the store keeping the item it replaced;
// - linkConflict: the older side of a conflict, linked to the new one; both sides must have a source;
// - unlinkConflict: a person decides two linked items do not conflict (食い違いではない): the link goes, the content and
//   the version stay (the store unlinks both sides);
// - correct: a person's edit, always a new version;
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

/**
 * Whether an update of the extraction `by` rewrites the item in place: the item was made in that session and nobody
 * has made another version of it since (ADR 0031, section 3: versions are kept only for items of earlier sessions).
 */
export const rewritesInPlace = (item: Knowledge.KnowledgeItemCommon, by: Knowledge.ExtractionRef): boolean =>
    item.createdIn === by.session && item.version === FIRST_VERSION;

/** The labels after one more source: `said` becomes `agreed` when the talk agreed; other origins stay. */
export function raisedOrigin(labels: Knowledge.Labels, agreed: boolean): Knowledge.Labels {
    return agreed && labels.origin === 'said' ? { ...labels, origin: 'agreed' } : labels;
}

export const knowledgeItemCommands: Knowledge.KnowledgeItemCommands = {
    add: decide<Knowledge.AddKnowledgeItemDecision>(Knowledge.KnowledgeItemShape, (params) => {
        if (Knowledge.checkAddKnowledgeItemRequires(params) === 'distinctSources') return err({ type: 'DuplicateSource' });
        const { id, content, sources, by, reason, at } = params;
        return ok({
            Live: {
                set: { id, content, sources, version: FIRST_VERSION, conflictsWith: [], createdIn: by.session, createdAt: at, updatedAt: at },
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
                set: { id, content, sources, version: FIRST_VERSION, conflictsWith: [other], createdIn: by.session, createdAt: at, updatedAt: at },
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
            const { revised, by, reason, at } = params;
            const why = reason && { reason };
            if (rewritesInPlace(item, by))
                return ok({
                    Live: {
                        set: { content: revised, version: item.version, updatedAt: at },
                        events: { KnowledgeItemRewritten: { type: 'KnowledgeItemRewritten', itemId: item.id, version: item.version, by, ...why, at } },
                    },
                });
            const version = nextVersion(item.version);
            return ok({
                Live: {
                    set: { content: revised, version, updatedAt: at },
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

    delete: decide<Knowledge.DeleteKnowledgeItemDecision>(Knowledge.KnowledgeItemShape, {
        Live: (item, { by, at }) =>
            ok({
                Deleted: {
                    set: { deletedBy: by, deletedAt: at },
                    events: { KnowledgeItemDeleted: { type: 'KnowledgeItemDeleted', itemId: item.id, version: item.version, by, at } },
                },
            }),
    }),

    restore: decide<Knowledge.RestoreKnowledgeItemDecision>(Knowledge.KnowledgeItemShape, {
        Deleted: (item, { by, at }) =>
            ok({ Live: { set: {}, events: { KnowledgeItemRestored: { type: 'KnowledgeItemRestored', itemId: item.id, version: item.version, by, at } } } }),
    }),
};
