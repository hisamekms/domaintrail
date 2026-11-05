/**
 * The Design Level elements of a view drawn along Event Storming's grammar (ADR 0024, amendment of 2026-11-05), read
 * left to right: read model and actor → command → aggregate → event → policy → command → … Shared by both projections
 * (`render.ts`, `stage-view.ts`); only the drawing changes: the `.dtes`, the semantic graph and the edges' semantic keys
 * do not.
 *
 * - **Copies per use**: an actor or external system (the issuer of a command), a read model (what a command `reads`) and
 *   an aggregate (a command's `target`) get a note beside each command note that uses them, `n:<element>@<command
 *   note>`; an element no command of the view uses is drawn once, `n:<element>`.
 * - **The aggregate decides**: a command with a `target` reaches its events through its aggregate's note: the `target`
 *   edge runs from the command to the aggregate's copy, each `emits` from that copy to the event (with the `emits`
 *   edge's semantic key). A command without a `target` keeps its `emits` from itself.
 * - **Copies per step** (spec §7.3, §10.2: drawing-only splits): the projection says at which *slot* (a step of a
 *   timeline, or one slot for the whole view) each event note stands. A command whose events stand at several slots
 *   gets a note per slot, `n:<command>#<k>` (with its own actor, read model and aggregate); a policy on events at
 *   several slots a note after each, `n:<policy>#<k>`; a hotspot on an event drawn at several slots a note on each,
 *   `n:<hotspot>#<k>`. `k` counts from 1 in slot order. A policy's note issues the command's note at the nearest slot
 *   after its own (every note of the command when none is after it). With a single slot, nothing is copied.
 */
import type { NodeElement, NodeElementKind, SemanticEdge } from '@domaintrail/storming';
import { semanticEdgeKey } from '@domaintrail/storming';
import type { RenderEdge, RenderElementNode } from './ir.js';
import { compare } from './trie.js';

/** An event note of the view, and where it stands: its slot, and the slot's place in time (to order copies). */
export interface EventPlace {
    /** The event note's render node ID. */
    id: string;
    eventId: string;
    slot: string;
    position: number;
}

/** The elements of a view (not events) drawn along the grammar, their semantic edges, and the slot of each anchored note. */
export interface Chains {
    nodes: RenderElementNode[];
    edges: RenderEdge[];
    /** The slot a note of a command, policy or hotspot stands at (none for a note of no event in view). */
    slots: Map<string, string>;
}

/** The use a semantic edge stands for: `actor` and `reads` from the element, `target` to it; none for the other kinds. */
function useOf(e: SemanticEdge): { elementId: string; commandId: string } | undefined {
    if (e.kind === 'actor' || e.kind === 'reads') return { elementId: e.sourceId, commandId: e.targetId };
    if (e.kind === 'target') return { elementId: e.targetId, commandId: e.sourceId };
    return undefined;
}

/** The commands that use each element (an actor, external system, read model or aggregate) among `edges`, in edge order. */
export function usersOf(edges: readonly SemanticEdge[]): Map<string, string[]> {
    const users = new Map<string, string[]>();
    for (const e of edges) {
        const use = useOf(e);
        if (use) users.set(use.elementId, [...(users.get(use.elementId) ?? []), use.commandId]);
    }
    return users;
}

/** The render node ID of an element's copy beside a command's note (`command`: that note's ID without `n:`). */
export const useNodeId = (elementId: string, command: string): string => `n:${elementId}@${command}`;

type ElementOfView = NodeElement & { kind: Exclude<NodeElementKind, 'event'> };

/** A note of an anchored element (a command, policy or hotspot): its ID without `n:`, and its slot. */
interface Note {
    key: string;
    slot?: string;
    position?: number;
}

/**
 * Draws `elements` (shown at this level, never events) with the semantic edges `drawn`, around the event notes `events`.
 */
export function drawChains(elements: readonly ElementOfView[], drawn: readonly SemanticEdge[], events: readonly EventPlace[]): Chains {
    const shown = new Map(elements.map((n) => [n.id, n]));
    const eventsOf = new Map<string, EventPlace[]>();
    for (const e of events) eventsOf.set(e.eventId, [...(eventsOf.get(e.eventId) ?? []), e]);
    const kindOf = (id: string): NodeElementKind | undefined => shown.get(id)?.kind ?? (eventsOf.has(id) ? 'event' : undefined);
    const edgesOf = (kind: SemanticEdge['kind']): SemanticEdge[] => drawn.filter((e) => e.kind === kind && kindOf(e.sourceId) && kindOf(e.targetId));

    /** The notes of an anchored element: one per slot of the events it is anchored at when those are several. */
    const notesAt = (id: string, places: EventPlace[]): Note[] => {
        const bySlot = new Map<string, number>();
        for (const p of places) bySlot.set(p.slot, Math.min(bySlot.get(p.slot) ?? Infinity, p.position));
        const slots = [...bySlot].sort(([a, pa], [b, pb]) => pa - pb || compare(a, b));
        if (slots.length <= 1) return [slots.length ? { key: id, slot: slots[0]![0], position: slots[0]![1] } : { key: id }];
        return slots.map(([slot, position], i) => ({ key: `${id}#${i + 1}`, slot, position }));
    };
    const placesOf = (kind: SemanticEdge['kind'], end: 'sourceId' | 'targetId', id: string): EventPlace[] =>
        edgesOf(kind)
            .filter((e) => e[end === 'sourceId' ? 'targetId' : 'sourceId'] === id)
            .flatMap((e) => eventsOf.get(e[end]) ?? []);

    const notes = new Map<string, Note[]>();
    for (const n of elements) {
        if (n.kind === 'command') notes.set(n.id, notesAt(n.id, placesOf('emits', 'targetId', n.id)));
        else if (n.kind === 'policy') notes.set(n.id, notesAt(n.id, placesOf('on', 'sourceId', n.id)));
        else if (n.kind === 'hotspot') notes.set(n.id, notesAt(n.id, placesOf('hotspot-on', 'targetId', n.id)));
    }
    const nodes = new Map<string, RenderElementNode>();
    const slots = new Map<string, string>();
    for (const [id, list] of notes) {
        const n = shown.get(id)!;
        for (const note of list) {
            nodes.set(`n:${note.key}`, { type: 'element', id: `n:${note.key}`, elementId: id, kind: n.kind });
            if (note.slot !== undefined) slots.set(`n:${note.key}`, note.slot);
        }
    }
    // an actor, external system, read model or aggregate beside each note of each command that uses it
    const users = new Map<string, string[]>();
    for (const [element, commands] of usersOf(edgesOf('actor').concat(edgesOf('reads'), edgesOf('target')))) {
        if (!shown.has(element)) continue;
        const keys = commands.flatMap((c) => (notes.get(c) ?? []).map((note) => note.key));
        users.set(element, [...new Set(keys)]);
    }
    for (const n of elements) {
        if (notes.has(n.id)) continue;
        const list = users.get(n.id);
        if (!list?.length) nodes.set(`n:${n.id}`, { type: 'element', id: `n:${n.id}`, elementId: n.id, kind: n.kind });
        for (const use of list ?? []) nodes.set(useNodeId(n.id, use), { type: 'element', id: useNodeId(n.id, use), elementId: n.id, kind: n.kind, use });
    }

    const edges = new Map<string, RenderEdge>();
    const eventNotes = new Set(events.map((p) => p.id));
    const add = (e: SemanticEdge, source: string, target: string): void => {
        if (!nodes.has(source) && !eventNotes.has(source)) return;
        if (!nodes.has(target) && !eventNotes.has(target)) return;
        const key = semanticEdgeKey(e);
        const id = `${key}@${source}->${target}`;
        edges.set(id, { type: 'semantic', id, kind: e.kind, source, target, semantic: key });
    };
    /** The event notes of `eventId` at a note's slot (every one when the note has none). */
    const eventsAt = (eventId: string, note: Note): EventPlace[] =>
        (eventsOf.get(eventId) ?? []).filter((p) => note.slot === undefined || p.slot === note.slot);
    const targetOf = new Map<string, string>();
    for (const e of edgesOf('target')) for (const note of notes.get(e.sourceId) ?? []) targetOf.set(note.key, useNodeId(e.targetId, note.key));
    for (const e of drawn) {
        switch (e.kind) {
            case 'emits':
                for (const note of notes.get(e.sourceId) ?? []) {
                    const target = targetOf.get(note.key);
                    const source = target !== undefined && nodes.has(target) ? target : `n:${note.key}`;
                    for (const p of eventsAt(e.targetId, note)) add(e, source, p.id);
                }
                break;
            case 'target':
            case 'actor':
            case 'reads': {
                const use = useOf(e)!;
                for (const note of notes.get(use.commandId) ?? []) {
                    const copy = useNodeId(use.elementId, note.key);
                    if (e.kind === 'target') add(e, `n:${note.key}`, copy);
                    else add(e, copy, `n:${note.key}`);
                }
                break;
            }
            case 'on':
                for (const note of notes.get(e.targetId) ?? []) for (const p of eventsAt(e.sourceId, note)) add(e, p.id, `n:${note.key}`);
                break;
            case 'hotspot-on':
                for (const note of notes.get(e.sourceId) ?? []) for (const p of eventsAt(e.targetId, note)) add(e, `n:${note.key}`, p.id);
                break;
            case 'issues':
                for (const note of notes.get(e.sourceId) ?? [])
                    for (const c of issued(note, notes.get(e.targetId) ?? [])) add(e, `n:${note.key}`, `n:${c.key}`);
                break;
        }
    }
    return { nodes: [...nodes.values()], edges: [...edges.values()], slots };
}

/** The notes of a command a policy's note issues: the one at the nearest slot after the policy's, else every one. */
function issued(policy: Note, commands: Note[]): Note[] {
    if (commands.length <= 1 || policy.position === undefined) return commands;
    const after = commands.filter((c) => c.position !== undefined && c.position > policy.position!);
    if (!after.length) return commands;
    const nearest = Math.min(...after.map((c) => c.position!));
    return after.filter((c) => c.position === nearest);
}
