import type { Diagnostic } from '@domaintrail/kernel';
import { allTimelines, nodeElements, type Storming } from '@domaintrail/storming';

/** Optional exploration prompts for an AI working toward Design Level. These are not validation rules. */
export function designLevelAdvice(stormings: readonly Storming[], scope: { storming?: string; timeline?: string } = {}): Diagnostic[] {
    const out: Diagnostic[] = [];
    const seen = new Set<string>();
    for (const storming of stormings) {
        if (scope.storming && storming.id !== scope.storming) continue;
        const nodes = nodeElements(storming);
        const events = new Map(nodes.filter((n) => n.kind === 'event').map((n) => [n.id, n]));
        const commands = nodes.filter((n) => n.kind === 'command');
        const relation = (id: string, keyword: string, target: string): boolean =>
            nodes.some((n) => n.id === id && n.clauses.some((c) => c.type === 'relation' && c.keyword === keyword && c.target === target));
        const hasOrigin = (id: string): boolean =>
            commands.some((command) => relation(command.id, 'emits', id)) ||
            nodes.some((n) => n.id === id && n.clauses.some((c) => c.type === 'relation' && c.keyword === 'from'));
        for (const timeline of allTimelines(storming)) {
            if (scope.timeline && timeline.id !== scope.timeline) continue;
            for (let i = 1; i < timeline.steps.length; i++) {
                const previous = timeline.steps[i - 1]!;
                const current = timeline.steps[i]!;
                // Groups have no order within a step. One prompt per adjacent step pair keeps the output bounded.
                const before = previous.type === 'event' ? [previous.eventId] : previous.events.map((e) => e.eventId);
                const after = current.type === 'event' ? [current.eventId] : current.events.map((e) => e.eventId);
                if (!before.length || !after.length) continue;
                // The later facts already have a stated origin. Their adjacency to the preceding step need not
                // itself have a causal explanation. A hotspot on either event may ask an unrelated question.
                if (after.every(hasOrigin)) continue;
                const next = events.get(after[0]!);
                if (!next) continue;
                const from = before.join(', ');
                const to = after.join(', ');
                const pair = `${storming.id}\u0000${from}\u0000${to}`;
                if (seen.has(pair)) continue;
                seen.add(pair);
                out.push({
                    file: next.nameRange.file,
                    start: next.nameRange.start,
                    end: next.nameRange.end,
                    severity: 'info',
                    code: 'S034',
                    elementId: `es/${storming.id}/${next.id}`,
                    message: `${storming.id}/${timeline.id}: examine what leads from ${from} to ${to} at Design Level. Timeline order alone does not establish causality.`,
                    hint: 'Consider a human decision (actor + command), a business rule (policy + command), an external fact (event from), or only temporal order. Ask people and make a small provisional edit; keep uncertainty visible with a hotspot.',
                });
            }
        }
    }
    return out;
}
