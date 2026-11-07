import type { SemanticEdge } from '@domaintrail/storming';

/**
 * The semantic edges of a timeline filter (§9.3), and of a stage's view: each 1-hop path Event → Policy → Command → Event
 * whose two events are in view (`events`), each command that emits an event in view (its cause, without the policy that
 * issues it unless that is such a path), the issuers, read models and handler of those commands, the events in view
 * their issuers react to (a command's `on`, ADR 0032 §14: the path Event → Actor → Command → Event), the actor and read
 * models of the policies kept, the events in view
 * that feed those read models, the external systems the events in view come from, and the hotspots on an event in view
 * or on an element kept. No path is followed further, so a cycle is no different from any other path (R10, R16).
 */
export function filterEdges(edges: readonly SemanticEdge[], events: ReadonlySet<string>): SemanticEdge[] {
    const from = (id: string, kind: SemanticEdge['kind']): SemanticEdge[] => edges.filter((e) => e.sourceId === id && e.kind === kind);
    const kept = new Set<SemanticEdge>();
    const commands = new Set<string>();
    for (const on of edges) {
        if (on.kind !== 'on' || !events.has(on.sourceId)) continue;
        for (const issues of from(on.targetId, 'issues')) {
            if (!from(issues.targetId, 'emits').some((e) => events.has(e.targetId))) continue;
            kept.add(on).add(issues);
        }
    }
    // the cause of an event in view: each command that emits it (those of the paths above among them)
    for (const e of edges) if (e.kind === 'emits' && events.has(e.targetId)) commands.add(e.sourceId);
    // the policies kept: the actor applying one by hand, and the read models it looks at (ADR 0032 §9)
    const policies = new Set([...kept].filter((e) => e.kind === 'on').map((e) => e.targetId));
    const readModels = new Set<string>();
    for (const e of edges) {
        const keep =
            (e.kind === 'emits' && events.has(e.targetId)) ||
            ((e.kind === 'by' || e.kind === 'reads') && (commands.has(e.targetId) || policies.has(e.targetId))) ||
            (e.kind === 'handledBy' && commands.has(e.sourceId)) ||
            (e.kind === 'command-on' && commands.has(e.targetId) && events.has(e.sourceId)) ||
            (e.kind === 'event-from' && events.has(e.targetId));
        if (!keep) continue;
        kept.add(e);
        if (e.kind === 'reads') readModels.add(e.sourceId);
    }
    for (const e of edges) if (e.kind === 'readmodel-from' && events.has(e.sourceId) && readModels.has(e.targetId)) kept.add(e);
    // a hotspot on an event in view, or on an element the edges kept draw
    const drawn = new Set([...kept].flatMap((e) => [e.sourceId, e.targetId]));
    for (const e of edges) if (e.kind === 'hotspot-on' && (events.has(e.targetId) || drawn.has(e.targetId))) kept.add(e);
    return edges.filter((e) => kept.has(e));
}
