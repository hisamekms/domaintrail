import type { SemanticEdge } from '@domaintrail/storming';

/**
 * The semantic edges of a timeline filter (§9.3): each 1-hop path Event → Policy → Command → Event whose two events are
 * in the timeline (`events`), the actors, read models and target of its command, and the hotspots on an event of the
 * timeline. No path is followed further, so a cycle is no different from any other path (R10, R16).
 */
export function filterEdges(edges: readonly SemanticEdge[], events: ReadonlySet<string>): SemanticEdge[] {
    const from = (id: string, kind: SemanticEdge['kind']) => edges.filter((e) => e.sourceId === id && e.kind === kind);
    const kept = new Set<SemanticEdge>();
    for (const on of edges) {
        if (on.kind !== 'on' || !events.has(on.sourceId)) continue;
        for (const issues of from(on.targetId, 'issues')) {
            const emits = from(issues.targetId, 'emits').filter((e) => events.has(e.targetId));
            if (emits.length === 0) continue;
            const command = issues.targetId;
            const related = edges.filter((e) => (e.kind === 'actor' || e.kind === 'reads') && e.targetId === command);
            for (const e of [on, issues, ...emits, ...related, ...from(command, 'target')]) kept.add(e);
        }
    }
    for (const e of edges) if (e.kind === 'hotspot-on' && events.has(e.targetId)) kept.add(e);
    return edges.filter((e) => kept.has(e));
}
