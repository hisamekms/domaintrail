import type { ModelDiff } from '../generated/Modeling.js';
import { commandsOf, statesOf, type DomainModel, type ElementId, type ElementModel } from './model.js';

export type { ModelDiff } from '../generated/Modeling.js';

export const EMPTY_DIFF: ModelDiff = { added: [], changed: [], removed: [] };

/**
 * Fingerprints of every addressable item (elements, states, commands) by stable ID.
 * Source locations are excluded so that moving code around is not a change.
 */
export function fingerprints(model: DomainModel): Map<ElementId, string> {
    const out = new Map<ElementId, string>();
    for (const el of model.elements) {
        out.set(el.id, JSON.stringify(strip(el)));
        for (const s of statesOf(el)) out.set(s.id, JSON.stringify({ ...s, location: undefined }));
        for (const c of commandsOf(el)) out.set(c.id, JSON.stringify({ ...c, location: undefined }));
    }
    return out;
}

function strip(el: ElementModel): unknown {
    if (el.kind !== 'aggregate') return { ...el, location: undefined };
    return {
        ...el,
        location: undefined,
        states: el.states.map((s) => ({ ...s, location: undefined })),
        commands: el.commands.map((c) => ({ ...c, location: undefined })),
    };
}

/** Additions, changes and removals between the previous valid model and the current one. */
export function diffModels(prev: DomainModel | undefined, next: DomainModel): ModelDiff {
    if (!prev) return EMPTY_DIFF;
    const a = fingerprints(prev);
    const b = fingerprints(next);
    const added: ElementId[] = [];
    const changed: ElementId[] = [];
    for (const [id, fp] of b) {
        const old = a.get(id);
        if (old === undefined) added.push(id);
        else if (old !== fp) changed.push(id);
    }
    return { added, changed, removed: [...a.keys()].filter((id) => !b.has(id)) };
}

export const isEmptyDiff = (d: ModelDiff): boolean => !d.added.length && !d.changed.length && !d.removed.length;
