/**
 * The elements drawn once per use (spec §6, ADR 0024): an actor or external system (the issuer of a command), a read
 * model (what a command `reads`) and an aggregate (a command's `target`) get a note beside each command that uses them,
 * so that their lines stay short. Each copy is a render node of its own with the element's ID; an element no command of
 * the view uses is drawn once, as any other.
 */
import type { SemanticEdge } from '@domaintrail/storming';

/** A use of an element by a command: the semantic edge between them, and which of its ends is the element. */
export interface Use {
    elementId: string;
    commandId: string;
    end: 'sourceId' | 'targetId';
}

/** The use a semantic edge stands for: `actor` and `reads` from the element, `target` to it; none for the other kinds. */
export function useOf(e: SemanticEdge): Use | undefined {
    if (e.kind === 'actor' || e.kind === 'reads') return { elementId: e.sourceId, commandId: e.targetId, end: 'sourceId' };
    if (e.kind === 'target') return { elementId: e.targetId, commandId: e.sourceId, end: 'targetId' };
    return undefined;
}

/** The render node ID of an element's copy beside a command: `n:<element>@<command>`. */
export const useNodeId = (elementId: string, commandId: string): string => `n:${elementId}@${commandId}`;

/** The commands that use each element among `edges` (`drawn`: whether the command's note is in the view), in edge order. */
export function usesOf(edges: readonly SemanticEdge[], drawn: (commandId: string) => boolean): Map<string, string[]> {
    const uses = new Map<string, string[]>();
    for (const e of edges) {
        const use = useOf(e);
        if (!use || !drawn(use.commandId)) continue;
        const list = uses.get(use.elementId) ?? [];
        if (!list.includes(use.commandId)) uses.set(use.elementId, [...list, use.commandId]);
    }
    return uses;
}

/**
 * The render nodes a semantic edge's end is drawn at: the copy beside its command for an element's end of a use (when
 * there is one), else whatever `nodesOf` draws the element at.
 */
export function useEnds(e: SemanticEdge, end: 'sourceId' | 'targetId', has: (id: string) => boolean, nodesOf: (id: string) => string[]): string[] {
    const use = useOf(e);
    if (use?.end === end) {
        const copy = useNodeId(use.elementId, use.commandId);
        if (has(copy)) return [copy];
    }
    return nodesOf(e[end]);
}
