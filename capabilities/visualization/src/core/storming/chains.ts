/**
 * The Design Level elements of a view drawn along Event Storming's grammar (ADR 0024, amendment of 2026-11-05; ADR 0032),
 * read left to right: read model → issuer (actor or external system) → command → handler (aggregate or external system)
 * → event → policy → command → … Shared by both projections (`render.ts`, `stage-view.ts`); only the drawing changes:
 * the `.dtes`, the semantic graph and the edges' semantic keys do not.
 *
 * - **Copies per use**: the issuers of a command (`by`), its read models (`reads`) and its handler (`handledBy`) get a
 *   note beside each command note, `n:<element>@<command note>`; so do a policy's read models and the actor applying it
 *   by hand, beside each policy note; an external system that an event comes `from` gets a
 *   note beside each note of that event, `n:<element>@<event note>`. An element no note of the view uses is drawn
 *   once, `n:<element>`.
 * - **The handler decides**: a command with a `handledBy` reaches its events through its handler's note: the
 *   `handledBy` edge runs from the command to the handler's copy, each `emits` from that copy to the event (with the
 *   `emits` edge's semantic key). A command without one keeps its `emits` from itself.
 * - **Whoever decides looks** (ADR 0032 §9): a command's `reads` edge runs from the read model to the issuers' copies of
 *   the command note (`by`); a policy's, to the copy of the actor applying it by hand (`by`), else to the policy's
 *   note. A command without `by` has no `reads` (S030): one there is left out, with nobody to look. An event feeding a
 *   read model (`readmodel-from`) runs to each copy of it, from the event's note at the nearest slot before the copy
 *   (every note with a single slot). When a policy's read model is fed by the event the policy is `on`, the line through
 *   the read model says the trigger: the policy's `on` line from that event note is not drawn (the others are).
 * - **The issuer reacts** (ADR 0032 §14): a command's `on` (`command-on`) runs from the event to the copy of each actor
 *   issuing it beside the command's note, from the event's note at the nearest slot at or before the note (as
 *   `readmodel-from` does): event → actor → command, as read model → actor → command. When that event feeds a read
 *   model the actor looks at for the command, the line through the read model says it, and this one is not drawn.
 * - **Copies per step** (spec §7.3, §10.2: drawing-only splits): the projection says at which *slot* (a step of a
 *   timeline, or one slot for the whole view) each event note stands, and at which position in time. A command whose
 *   events stand at several positions gets a note per position, `n:<command>#<k>` (with its own issuer, read model and
 *   handler); a policy on events at several positions a note after each, `n:<policy>#<k>`. Slots at one position (the
 *   lanes of alternatives at the same step: an exception beside its main flow) share the note, which stands at the slot
 *   of the topmost lane and joins the event notes of each (ADR 0032 §13). A hotspot gets a note on each note of its
 *   sticky: of an event, one per slot, `n:<hotspot>#<k>`; of any other sticky, one per note of it, `n:<hotspot>#<k>` in
 *   the order of those notes. `k` counts from 1. A policy's note issues the command's note at the nearest position after
 *   its own (every note of the command when none is after it). With a single position, nothing is copied per step.
 */
import type { Gap, NodeElement, NodeElementKind, SemanticEdge } from '@domaintrail/storming';
import { semanticEdgeKey } from '@domaintrail/storming';
import type { RenderEdge, RenderElementNode, RenderGapNode } from './ir.js';
import { compare } from './trie.js';

/** An event note of the view, and where it stands: its slot, and the slot's place in time (to order copies). */
export interface EventPlace {
    /** The event note's render node ID. */
    id: string;
    eventId: string;
    slot: string;
    position: number;
    /** The row of its lane, when the view has lanes: a note shared by the slots at one position stands at the topmost. */
    lane?: number;
    /** The note the graph draws it as, when the graph draws several event nodes as one (the integrated canvas: `e:<event>`). */
    drawnAs?: string;
}

/** The elements of a view (not events) drawn along the grammar, their semantic edges, and the slot of each anchored note. */
export interface Chains {
    nodes: RenderElementNode[];
    /** The empty slots of the commands' gaps an open hotspot keeps open, beside each command note. */
    gaps: RenderGapNode[];
    edges: RenderEdge[];
    /** The slot each note stands at, when it stands at one (a note of no event in view stands at none). */
    slots: Map<string, string>;
}

/**
 * The use a semantic edge stands for: a command's issuer, read model or handler, or a policy's actor or read model
 * (`commandId` is then the policy's); none for the other kinds.
 */
function useOf(e: SemanticEdge): { elementId: string; commandId: string } | undefined {
    if (e.kind === 'by' || e.kind === 'reads') return { elementId: e.sourceId, commandId: e.targetId };
    if (e.kind === 'handledBy') return { elementId: e.targetId, commandId: e.sourceId };
    return undefined;
}

/** The commands that use each element (an issuer, read model or handler) among `edges`, in edge order. */
export function usersOf(edges: readonly SemanticEdge[]): Map<string, string[]> {
    const users = new Map<string, string[]>();
    for (const e of edges) {
        const use = useOf(e);
        if (use) users.set(use.elementId, [...(users.get(use.elementId) ?? []), use.commandId]);
    }
    return users;
}

/**
 * The hotspots on a sticky of Design Level only (a command, policy, actor, external system, aggregate or read model):
 * Big Picture, which draws events and hotspots, leaves them out with their sticky.
 */
export function hotspotsOnDesignLevel(edges: readonly SemanticEdge[], kinds: ReadonlyMap<string, NodeElementKind>): Set<string> {
    return new Set(edges.filter((e) => e.kind === 'hotspot-on' && kinds.get(e.targetId) !== 'event').map((e) => e.sourceId));
}

/** The render node ID of an element's copy beside a note (a command note's ID without `n:`, or an event note's ID). */
export const useNodeId = (elementId: string, note: string): string => `n:${elementId}@${note}`;

type ElementOfView = NodeElement & { kind: Exclude<NodeElementKind, 'event'> };

/** A note of an element: its ID without `n:`, the slot it stands at, and every slot it stands for (the same position). */
interface Note {
    key: string;
    slot?: string;
    slots?: string[];
    position?: number;
}

/**
 * Draws `elements` (shown at this level, never events) with the semantic edges `semantic`, around the event notes `events`.
 */
export function drawChains(
    elements: readonly ElementOfView[],
    semantic: readonly SemanticEdge[],
    events: readonly EventPlace[],
    openGaps: readonly Gap[] = [],
): Chains {
    const shown = new Map(elements.map((n) => [n.id, n]));
    const eventsOf = new Map<string, EventPlace[]>();
    for (const e of events) eventsOf.set(e.eventId, [...(eventsOf.get(e.eventId) ?? []), e]);
    const kindOf = (id: string): NodeElementKind | undefined => shown.get(id)?.kind ?? (eventsOf.has(id) ? 'event' : undefined);
    // a command's `reads` goes to its issuers: without one (a policy's command, S030), nobody looks
    const withIssuer = new Set(semantic.filter((e) => e.kind === 'by' && kindOf(e.sourceId)).map((e) => e.targetId));
    const drawn = semantic.filter((e) => e.kind !== 'reads' || kindOf(e.targetId) !== 'command' || withIssuer.has(e.targetId));
    const edgesOf = (kind: SemanticEdge['kind']): SemanticEdge[] => drawn.filter((e) => e.kind === kind && kindOf(e.sourceId) && kindOf(e.targetId));

    /**
     * The notes of an anchored element: one per position of the events it is anchored at when those are several, at the
     * slot of the topmost lane there and standing for every slot there; one per slot when `perSlot` (a hotspot on an
     * event, which stands on each note of it).
     */
    const notesAt = (id: string, places: EventPlace[], perSlot: boolean = false): Note[] => {
        const bySlot = new Map<string, { position: number; lane: number }>();
        for (const p of places) {
            const seen = bySlot.get(p.slot);
            bySlot.set(p.slot, { position: Math.min(seen?.position ?? Infinity, p.position), lane: Math.min(seen?.lane ?? Infinity, p.lane ?? 0) });
        }
        const ordered = [...bySlot].sort(([a, pa], [b, pb]) => pa.position - pb.position || pa.lane - pb.lane || compare(a, b));
        const times: { slots: string[]; position: number }[] = [];
        for (const [slot, { position }] of ordered) {
            const last = times.at(-1);
            if (!perSlot && last?.position === position) last.slots.push(slot);
            else times.push({ slots: [slot], position });
        }
        const noteOf = (key: string, time: { slots: string[]; position: number }): Note => ({
            key,
            slot: time.slots[0]!,
            ...(time.slots.length > 1 && { slots: time.slots }),
            position: time.position,
        });
        if (times.length <= 1) return [times.length ? noteOf(id, times[0]!) : { key: id }];
        return times.map((time, i) => noteOf(`${id}#${i + 1}`, time));
    };
    const placesOf = (kind: SemanticEdge['kind'], end: 'sourceId' | 'targetId', id: string): EventPlace[] =>
        edgesOf(kind)
            .filter((e) => e[end === 'sourceId' ? 'targetId' : 'sourceId'] === id)
            .flatMap((e) => eventsOf.get(e[end]) ?? []);
    const at = (note: Note): Pick<Note, 'slot' | 'position'> => (note.slot !== undefined ? { slot: note.slot, position: note.position } : {});

    /** The notes of each element drawn. */
    const notes = new Map<string, Note[]>();
    const nodes = new Map<string, RenderElementNode>();
    const slots = new Map<string, string>();
    const addNote = (n: ElementOfView, note: Note, use?: string, commands?: string[]): void => {
        const id = `n:${note.key}`;
        nodes.set(id, { type: 'element', id, elementId: n.id, kind: n.kind, ...(use !== undefined && { use }), ...(commands && { commands }) });
        if (note.slot !== undefined) slots.set(id, note.slot);
        notes.set(n.id, [...(notes.get(n.id) ?? []), note]);
    };
    for (const n of elements) {
        if (n.kind === 'command') for (const note of notesAt(n.id, placesOf('emits', 'targetId', n.id))) addNote(n, note);
        if (n.kind === 'policy') for (const note of notesAt(n.id, placesOf('on', 'sourceId', n.id))) addNote(n, note);
    }
    /** The event notes of `eventId` at the slots a note stands for (every one when the note has none). */
    const eventsAt = (eventId: string, note: Note): EventPlace[] =>
        (eventsOf.get(eventId) ?? []).filter((p) => note.slot === undefined || (note.slots ?? [note.slot]).includes(p.slot));
    // one handler for the chains that converge on one event note: the command notes handled by the same element that
    // emit it, at its slot (`n:<handler>@*<event note>`); a command note keeps a copy of its own for the rest
    const handlerOfCommand = new Map<string, string>();
    for (const e of edgesOf('handledBy')) if (!handlerOfCommand.has(e.sourceId)) handlerOfCommand.set(e.sourceId, e.targetId);
    const converging = new Map<string, { handler: string; places: EventPlace[]; notes: string[] }>();
    for (const e of edgesOf('emits')) {
        const handler = handlerOfCommand.get(e.sourceId);
        if (handler === undefined) continue;
        for (const note of notes.get(e.sourceId) ?? []) {
            for (const place of eventsAt(e.targetId, note)) {
                const key = `${handler}@*${place.drawnAs ?? place.id}`;
                const c = converging.get(key) ?? { handler, places: [], notes: [] };
                if (!c.notes.includes(note.key)) c.notes.push(note.key);
                if (!c.places.includes(place)) c.places.push(place);
                converging.set(key, c);
            }
        }
    }
    const merged = new Map([...converging].filter(([, c]) => c.notes.length > 1));
    /** The merged handler a command note's chain into an event note goes through (`<note>|<event note>`). */
    const mergedAt = new Map<string, string>();
    for (const [key, c] of merged) for (const note of c.notes) for (const p of c.places) mergedAt.set(`${note}|${p.id}`, `n:${key}`);
    const ownHandler = (note: Note, command: string): boolean => {
        const places = edgesOf('emits')
            .filter((e) => e.sourceId === command)
            .flatMap((e) => eventsAt(e.targetId, note));
        return !places.length || places.some((p) => !mergedAt.has(`${note.key}|${p.id}`));
    };
    // an issuer, read model or handler beside each note of each command that uses it (a handler: unless merged)
    const copies = new Map<string, Note[]>();
    const addCopies = (element: string, list: Note[]): void => {
        const all = [...(copies.get(element) ?? []), ...list];
        copies.set(element, [...new Map(all.map((note) => [note.key, note])).values()]);
    };
    for (const [element, commands] of usersOf(edgesOf('by').concat(edgesOf('reads'))))
        addCopies(
            element,
            commands.flatMap((c) => notes.get(c) ?? []),
        );
    for (const [command, handler] of handlerOfCommand)
        addCopies(
            handler,
            (notes.get(command) ?? []).filter((note) => ownHandler(note, command)),
        );
    // an external system beside each note of an event that comes from it
    const sources = new Map<string, EventPlace[]>();
    for (const e of edgesOf('event-from')) sources.set(e.sourceId, [...(sources.get(e.sourceId) ?? []), ...(eventsOf.get(e.targetId) ?? [])]);
    for (const n of elements) {
        if (n.kind === 'command' || n.kind === 'policy' || n.kind === 'hotspot') continue;
        const uses = copies.get(n.id) ?? [];
        const places = sources.get(n.id) ?? [];
        const shared = [...merged].filter(([, c]) => c.handler === n.id);
        if (!uses.length && !places.length && !shared.length) addNote(n, { key: n.id });
        for (const use of uses) addNote(n, { key: `${n.id}@${use.key}`, ...at(use) }, use.key);
        for (const p of places) addNote(n, { key: `${n.id}@${p.id}`, slot: p.slot, position: p.position }, p.id);
        for (const [key, c] of shared) addNote(n, { key, slot: c.places[0]!.slot, position: c.places[0]!.position }, undefined, [...c.notes].sort(compare));
    }
    // a hotspot on each note of its sticky
    const subjectOf = new Map(edgesOf('hotspot-on').map((e) => [e.sourceId, e.targetId]));
    for (const n of elements) {
        if (n.kind !== 'hotspot') continue;
        const subject = subjectOf.get(n.id);
        if (subject === undefined || kindOf(subject) === 'event') {
            for (const note of notesAt(n.id, subject === undefined ? [] : (eventsOf.get(subject) ?? []), true)) addNote(n, note);
            continue;
        }
        const on = notes.get(subject) ?? [];
        if (on.length <= 1) addNote(n, { key: n.id, ...(on[0] && at(on[0])) });
        else on.forEach((note, i) => addNote(n, { key: `${n.id}#${i + 1}`, ...at(note) }));
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
    const notesOf = (id: string): Note[] => notes.get(id) ?? [];
    /** The `emits` drawn from a merged handler to an event note: one edge for the commands' `emits` it stands for. */
    const fromMerged = new Map<string, { source: string; target: string; keys: string[] }>();
    /** The copy of an element beside a command's note, when it is drawn. */
    const copyAt = (elementId: string, note: Note): string | undefined => {
        const id = useNodeId(elementId, note.key);
        return nodes.has(id) ? id : undefined;
    };
    const handlerOf = new Map<string, string>();
    for (const e of edgesOf('handledBy')) for (const note of notesOf(e.sourceId)) handlerOf.set(note.key, e.targetId);
    const issuersOf = new Map<string, string[]>();
    for (const e of edgesOf('by')) issuersOf.set(e.targetId, [...(issuersOf.get(e.targetId) ?? []), e.sourceId]);
    for (const e of drawn) {
        switch (e.kind) {
            case 'emits':
                for (const note of notesOf(e.sourceId)) {
                    const handler = handlerOf.get(note.key);
                    const source = (handler !== undefined && copyAt(handler, note)) || `n:${note.key}`;
                    for (const p of eventsAt(e.targetId, note)) {
                        const m = mergedAt.get(`${note.key}|${p.id}`);
                        if (m === undefined) {
                            add(e, source, p.id);
                            continue;
                        }
                        const id = `${m}->${p.id}`;
                        const f = fromMerged.get(id) ?? { source: m, target: p.id, keys: [] };
                        f.keys.push(semanticEdgeKey(e));
                        fromMerged.set(id, f);
                    }
                }
                break;
            case 'by':
                for (const note of notesOf(e.targetId)) {
                    const copy = copyAt(e.sourceId, note);
                    if (copy) add(e, copy, `n:${note.key}`);
                }
                break;
            case 'handledBy':
                for (const note of notesOf(e.sourceId)) {
                    const copy = copyAt(e.targetId, note);
                    if (copy) add(e, `n:${note.key}`, copy);
                    for (const [key, c] of merged) if (c.handler === e.targetId && c.notes.includes(note.key)) add(e, `n:${note.key}`, `n:${key}`);
                }
                break;
            case 'reads':
                for (const note of notesOf(e.targetId)) {
                    const copy = copyAt(e.sourceId, note);
                    if (!copy) continue;
                    // a command's issuers look at it, and so does the actor applying a policy by hand; a policy without
                    // one looks at it itself
                    const issuers = (issuersOf.get(e.targetId) ?? []).flatMap((i) => copyAt(i, note) ?? []);
                    if (!issuers.length && kindOf(e.targetId) === 'policy') add(e, copy, `n:${note.key}`);
                    else for (const issuer of issuers) add(e, copy, issuer);
                }
                break;
            case 'readmodel-from':
                for (const note of notesOf(e.targetId)) for (const p of feeding(eventsOf.get(e.sourceId) ?? [], note)) add(e, p.id, `n:${note.key}`);
                break;
            case 'event-from':
                for (const p of eventsOf.get(e.targetId) ?? []) {
                    const copy = useNodeId(e.sourceId, p.id);
                    add(e, nodes.has(copy) ? copy : `n:${e.sourceId}`, p.id);
                }
                break;
            case 'on':
                for (const note of notesOf(e.targetId)) for (const p of eventsAt(e.sourceId, note)) add(e, p.id, `n:${note.key}`);
                break;
            case 'command-on':
                // into the actors issuing the command, beside its note: they notice the event and issue it
                for (const note of notesOf(e.targetId)) {
                    const actors = (issuersOf.get(e.targetId) ?? []).filter((i) => kindOf(i) === 'actor').flatMap((i) => copyAt(i, note) ?? []);
                    for (const p of feeding(eventsOf.get(e.sourceId) ?? [], note)) for (const actor of actors) add(e, p.id, actor);
                }
                break;
            case 'hotspot-on':
                if (kindOf(e.targetId) === 'event') {
                    for (const note of notesOf(e.sourceId)) for (const p of eventsAt(e.targetId, note)) add(e, `n:${note.key}`, p.id);
                } else {
                    const on = notesOf(e.targetId);
                    notesOf(e.sourceId).forEach((note, i) => {
                        const subject = on[i];
                        if (subject) add(e, `n:${note.key}`, `n:${subject.key}`);
                    });
                }
                break;
            case 'issues':
                for (const note of notesOf(e.sourceId)) for (const c of issued(note, notesOf(e.targetId))) add(e, `n:${note.key}`, `n:${c.key}`);
                break;
        }
    }
    for (const f of fromMerged.values()) {
        const keys = [...new Set(f.keys)].sort(compare);
        const id = `${keys[0]}@${f.source}->${f.target}`;
        edges.set(id, {
            type: 'semantic',
            id,
            kind: 'emits',
            source: f.source,
            target: f.target,
            semantic: keys[0]!,
            ...(keys.length > 1 && { merged: keys }),
        });
    }
    // a trigger already drawn through the read model looked at (event → read model → policy, or → the actor applying
    // it → policy; event → read model → the actor issuing a command, ADR 0032 §14): its own `on` line from that event
    // note (a policy's, or a command's into the actor's copy) is left out
    const lines = new Set([...edges.values()].flatMap((e) => (e.type === 'semantic' ? [`${e.kind}:${e.source}->${e.target}`] : [])));
    const looks = (reader: string, target: string): boolean => reader === target || lines.has(`by:${reader}->${target}`);
    for (const [id, e] of edges) {
        if (e.type !== 'semantic' || (e.kind !== 'on' && e.kind !== 'command-on')) continue;
        const through = [...edges.values()].some(
            (r) => r.type === 'semantic' && r.kind === 'reads' && looks(r.target, e.target) && lines.has(`readmodel-from:${e.source}->${r.source}`),
        );
        if (through) edges.delete(id);
    }
    // the empty slot of an issuer or a handler an open hotspot keeps undecided, beside each note of its command
    const gaps: RenderGapNode[] = [];
    for (const g of openGaps) {
        if (g.kind !== 'command' || g.question === undefined) continue;
        for (const missing of (['by', 'handledBy'] as const).filter((m) => g.missing.includes(m))) {
            for (const note of notesOf(g.elementId)) {
                const id = `n:?${missing}@${note.key}`;
                gaps.push({ type: 'gap', id, commandId: g.elementId, hotspotId: g.question, missing, use: note.key });
                if (note.slot !== undefined) slots.set(id, note.slot);
            }
        }
    }
    return { nodes: [...nodes.values()], edges: [...edges.values()], slots, gaps };
}

/** The notes of a command a policy's note issues: the one at the nearest slot after the policy's, else every one. */
function issued(policy: Note, commands: Note[]): Note[] {
    if (commands.length <= 1 || policy.position === undefined) return commands;
    const after = commands.filter((c) => c.position !== undefined && c.position > policy.position!);
    if (!after.length) return commands;
    const nearest = Math.min(...after.map((c) => c.position!));
    return after.filter((c) => c.position === nearest);
}

/**
 * The notes of an event that feed a read model's note (or that the issuer of a command's note reacts to, `command-on`):
 * those at the nearest slot at or before it, else at the first
 * slot after it; every one when the note has no slot or the event stands at a single place in time.
 */
function feeding(places: readonly EventPlace[], note: Note): EventPlace[] {
    const positions = [...new Set(places.map((p) => p.position))];
    if (note.position === undefined || positions.length <= 1) return [...places];
    const before = positions.filter((p) => p <= note.position!);
    const time = before.length ? Math.max(...before) : Math.min(...positions);
    return places.filter((p) => p.position === time);
}
