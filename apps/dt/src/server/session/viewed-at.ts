// The names a view sent with a message may use (`resolveViewedAt`), from the view the server last computed: the
// contexts and aggregates of the model, and the stormings with their timelines and stages.
import type { KnownViewNames } from '@domaintrail/collaboration';
import { contextNames } from '@domaintrail/modeling';
import type { ViewPayload } from '@domaintrail/visualization/protocol';

/** The names of the view the server shows now. */
export function knownViewNames(payload: Pick<ViewPayload, 'model' | 'stormings'>): KnownViewNames {
    const model = payload.model;
    return {
        contexts: new Set(model ? contextNames(model) : []),
        aggregates: new Set(model ? model.elements.filter((e) => e.kind === 'aggregate').map((e) => e.id) : []),
        stormings: new Map(
            payload.stormings.map((s) => [s.id, { timelines: new Set(s.timelines.map((t) => t.id)), stages: new Set((s.stages ?? []).map((t) => t.id)) }]),
        ),
    };
}
