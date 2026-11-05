/**
 * What a storming means, independent of how it is drawn (docs/dtes-v0.1.md, ADR 0024, ADR 0032; spec §7.1, §7.2, §9.1):
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
    isRemovedKeyword,
    nodeElements,
    type NodeElement,
    type NodeElementKind,
    RELATION_RULES,
    type RelationKeyword,
    type Stage,
    type Storming,
    type Timeline,
} from './ir.js';

// ---- Semantic graph (spec §7.1, §9.1) ----

/**
 * The kind of a semantic edge (ADR 0032): a relation clause's keyword, and for the clauses whose meaning depends on their
 * owner the owner's kind too: `hotspot-on` is a hotspot's `on` (not causal; a policy's `on` is `on`), `readmodel-from`
 * an event feeding a read model, `event-from` an event arriving from an external system. `on`, `issues`, `handledBy`,
 * `emits` and `event-from` are type-level causal candidates; `by`, `reads` and `readmodel-from` relate.
 */
export type SemanticEdgeKind = 'by' | 'reads' | 'handledBy' | 'emits' | 'on' | 'issues' | 'readmodel-from' | 'event-from' | 'hotspot-on';

/**
 * A valid relation, directed as Event Storming reads it: `Actor → Command` (`by`), `Read Model → Command` (`reads`),
 * `Command → Aggregate` (`handledBy`), `Command → Event` (`emits`; the drawing starts it at the handler), `Event →
 * Policy` (`on`), `Policy → Command` (`issues`), `Event → Read Model` and `External → Event` (`from`), `Hotspot → Sticky`.
 */
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
        /** A command's handler and a hotspot's subject: only the first counts (a second is S004). */
        let single = false;
        for (const clause of owner.clauses) {
            if (clause.type !== 'relation') continue;
            const keyword = clause.keyword;
            if (isRemovedKeyword(keyword)) continue; // S023
            const allowed = rules[keyword];
            const target = byId.get(clause.target);
            if (!allowed || !target || target.kind === 'timeline' || target.kind === 'group' || target.kind === 'stage' || !allowed.includes(target.kind))
                continue;
            const kind = edgeKind(owner.kind, keyword);
            if (kind === 'handledBy' || kind === 'hotspot-on') {
                if (single) continue;
                single = true;
            }
            // Actor → Command, Read Model → Command, Event → Policy, Event → Read Model, External → Event; every other
            // relation from its owner
            const toOwner = kind === 'by' || kind === 'reads' || kind === 'on' || kind === 'readmodel-from' || kind === 'event-from';
            const edge: SemanticEdge = toOwner ? { sourceId: target.id, targetId: owner.id, kind } : { sourceId: owner.id, targetId: target.id, kind };
            const key = semanticEdgeKey(edge);
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push(edge);
        }
    }
    return { stormingId: storming.id, nodes, edges };
}

/** The kind of the edge of a valid relation clause of `owner`. */
function edgeKind(owner: NodeElementKind, keyword: RelationKeyword): SemanticEdgeKind {
    if (owner === 'hotspot') return 'hotspot-on';
    if (keyword === 'from') return owner === 'readmodel' ? 'readmodel-from' : 'event-from';
    return keyword;
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
