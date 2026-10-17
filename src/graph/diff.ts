import type { DomainModel, ElementModel } from '../model/model.js';

export interface ModelDiff {
    added: string[];
    changed: string[];
    removed: string[];
}

export const EMPTY_DIFF: ModelDiff = { added: [], changed: [], removed: [] };

/**
 * Fingerprints of every addressable item (elements, states, commands) by stable ID.
 * Source locations are excluded so that moving code around is not a change.
 */
export function fingerprints(model: DomainModel): Map<string, string> {
    const out = new Map<string, string>();
    for (const el of Object.values(model.elements)) {
        out.set(el.id, JSON.stringify(strip(el)));
        for (const s of el.states ?? []) out.set(s.id, JSON.stringify({ ...s, location: undefined }));
        for (const c of el.commands ?? []) out.set(c.id, JSON.stringify({ ...c, location: undefined }));
    }
    return out;
}

function strip(el: ElementModel): unknown {
    return {
        ...el,
        location: undefined,
        states: el.states?.map((s) => ({ ...s, location: undefined })),
        commands: el.commands?.map((c) => ({ ...c, location: undefined })),
    };
}

/** Additions, changes and removals between the previous valid model and the current one. */
export function diffModels(prev: DomainModel | undefined, next: DomainModel): ModelDiff {
    if (!prev) return EMPTY_DIFF;
    const a = fingerprints(prev);
    const b = fingerprints(next);
    const diff: ModelDiff = { added: [], changed: [], removed: [] };
    for (const [id, fp] of b) {
        const old = a.get(id);
        if (old === undefined) diff.added.push(id);
        else if (old !== fp) diff.changed.push(id);
    }
    for (const id of a.keys()) if (!b.has(id)) diff.removed.push(id);
    return diff;
}

export const isEmptyDiff = (d: ModelDiff): boolean => !d.added.length && !d.changed.length && !d.removed.length;
