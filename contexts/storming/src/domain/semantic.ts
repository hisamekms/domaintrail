/**
 * What a storming means, independent of how it is drawn (docs/dtes-v0.1.md, ADR 0024; spec §7.1, §7.2, §9.1):
 *
 * - the **semantic graph** (`SemanticGraph`): its valid elements and relations, independent of timelines. Invalid input
 *   (reported by the validator) is left out rather than guessed: of two declarations with one ID only the first counts,
 *   and a relation to a missing element or one of the wrong kind is dropped;
 * - the **occurrences** of events in timelines (`EventOccurrence`).
 *
 * How the Live View draws them (the prefix trie, the render graph) is visualization's.
 */
import {
    allTimelines,
    type AnyDeclaration,
    declarations,
    nodeElements,
    type NodeElement,
    RELATION_RULES,
    type Stage,
    type Storming,
    type Timeline,
} from './ir.js';

// ---- Semantic graph (spec §7.1, §9.1) ----

/**
 * The kind of a semantic edge. `hotspot-on` is a hotspot's `on`, which is not causal; a policy's `on` is `on`.
 * `actor`, `reads` and `target` relate, `on`, `issues` and `emits` are type-level causal candidates.
 */
export type SemanticEdgeKind = 'on' | 'issues' | 'emits' | 'target' | 'actor' | 'reads' | 'hotspot-on';

/** A valid relation, directed as in spec §9.1 (`Event → Policy`, `Actor → Command`, `Read Model → Command`, the others from the owner). */
export interface SemanticEdge {
    /** Local IDs. */
    sourceId: string;
    targetId: string;
    kind: SemanticEdgeKind;
}

export interface SemanticGraph {
    stormingId: string;
    /** The node elements of the storming (not timelines or groups), in source order. */
    nodes: NodeElement[];
    /** Each valid relation clause once, in source order, never inferred ones (no Event → Command across a policy). */
    edges: SemanticEdge[];
}

/** Identity of a semantic edge, for render edges to point back to it. */
export const semanticEdgeKey = (e: SemanticEdge): string => `${e.kind}:${e.sourceId}->${e.targetId}`;

/** The declaration that owns each ID: the first one, as the validator reports the others (S001). */
export function firstDeclarations(storming: Storming): Map<string, AnyDeclaration> {
    const byId = new Map<string, AnyDeclaration>();
    for (const d of declarations(storming)) if (!byId.has(d.id)) byId.set(d.id, d);
    return byId;
}

/** The timelines that own their ID, in source order: the top-level ones and those of the stages. */
export function stormingTimelines(storming: Storming): Timeline[] {
    const byId = firstDeclarations(storming);
    return allTimelines(storming).filter((t) => byId.get(t.id) === t);
}

/** The stages that own their ID, in source order (spec §3.7). */
export function stormingStages(storming: Storming): Stage[] {
    const byId = firstDeclarations(storming);
    return storming.elements.filter((el): el is Stage => el.kind === 'stage' && byId.get(el.id) === el);
}

export function buildSemanticGraph(storming: Storming): SemanticGraph {
    const byId = firstDeclarations(storming);
    const nodes = nodeElements(storming).filter((el) => byId.get(el.id) === el);
    const edges: SemanticEdge[] = [];
    const seen = new Set<string>();
    for (const owner of nodes) {
        const rules = RELATION_RULES[owner.kind] ?? {};
        for (const clause of owner.clauses) {
            if (clause.type !== 'relation') continue;
            const allowed = rules[clause.keyword];
            const target = byId.get(clause.target);
            if (!allowed || !target || target.kind === 'timeline' || target.kind === 'group' || target.kind === 'stage' || !allowed.includes(target.kind))
                continue;
            const kind: SemanticEdgeKind = owner.kind === 'hotspot' ? 'hotspot-on' : clause.keyword;
            // §9.1: Event → Policy, Actor → Command and Read Model → Command; every other relation from its owner
            const toOwner = clause.keyword === 'actor' || clause.keyword === 'reads' || kind === 'on';
            const edge: SemanticEdge = toOwner ? { sourceId: target.id, targetId: owner.id, kind } : { sourceId: owner.id, targetId: target.id, kind };
            const key = semanticEdgeKey(edge);
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push(edge);
        }
    }
    return { stormingId: storming.id, nodes, edges };
}

// ---- Timelines and occurrences (spec §7.2, §8.3) ----

/**
 * One appearance of an event in a timeline. Not persistent: `stepPath` changes when a step is inserted before it.
 * Occurrences of the same event in two timelines are never taken to be the same happening.
 */
export interface EventOccurrence {
    timelineId: string;
    /** `[step]` for an event step, `[step, index]` for the index-th event of a group step (source order). */
    stepPath: number[];
    eventId: string;
}

/** Every reference of a timeline to an event, in source order, with its step path. */
export function timelineOccurrences(timeline: Timeline): EventOccurrence[] {
    return timeline.steps.flatMap((step, i): EventOccurrence[] =>
        step.type === 'event'
            ? [{ timelineId: timeline.id, stepPath: [i], eventId: step.eventId }]
            : step.events.map((e, j) => ({ timelineId: timeline.id, stepPath: [i, j], eventId: e.eventId })),
    );
}
