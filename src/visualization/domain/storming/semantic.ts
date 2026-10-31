/**
 * The semantic graph of a storming (spec §7.1, §9.1): its valid elements and relations, independent of timelines.
 * Invalid input (reported by the validator) is left out rather than guessed: of two declarations with one ID only the
 * first counts, and a relation to a missing element or one of the wrong kind is dropped.
 */
import { RELATION_RULES, declarations, type AnyDeclaration, type NodeElement, type Storming, type Timeline } from '../../../dtes/ir.js';
import { semanticEdgeKey, type SemanticEdge, type SemanticEdgeKind, type SemanticGraph } from './ir.js';

/** The declaration that owns each ID: the first one, as the validator reports the others (S001). */
export function firstDeclarations(storming: Storming): Map<string, AnyDeclaration> {
    const byId = new Map<string, AnyDeclaration>();
    for (const d of declarations(storming)) if (!byId.has(d.id)) byId.set(d.id, d);
    return byId;
}

/** The timelines that own their ID, in source order. */
export function stormingTimelines(storming: Storming): Timeline[] {
    const byId = firstDeclarations(storming);
    return storming.elements.filter((el): el is Timeline => el.kind === 'timeline' && byId.get(el.id) === el);
}

export function buildSemanticGraph(storming: Storming): SemanticGraph {
    const byId = firstDeclarations(storming);
    const nodes = storming.elements.filter((el): el is NodeElement => el.kind !== 'timeline' && byId.get(el.id) === el);
    const edges: SemanticEdge[] = [];
    const seen = new Set<string>();
    for (const owner of nodes) {
        const rules = RELATION_RULES[owner.kind] ?? {};
        for (const clause of owner.clauses) {
            if (clause.type !== 'relation') continue;
            const allowed = rules[clause.keyword];
            const target = byId.get(clause.target);
            if (!allowed || !target || target.kind === 'timeline' || target.kind === 'group' || !allowed.includes(target.kind)) continue;
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
