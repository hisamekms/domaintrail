// What a unit of work changed in the model's words (ADR 0026, amendment "changes in the model's words"): the elements
// two analyses differ by, `.dt` and `.dtes` together. `.dt`: Modeling's diff of the two models — elements, states and
// commands by stable ID; a field, a parameter or an invariant is a part of the element it is in. `.dtes`: every
// declaration of a storming by its storming and local ID, compared without its source ranges. Decided without I/O.
import { commandsOf, diffModels, elementOf, statesOf, type DomainModel, type ElementId, type ElementKind, type ElementModel } from '@domaintrail/modeling';
import { firstDeclarations, type AnyDeclaration, type Storming, type StormingElementKind } from '@domaintrail/storming';
import type { TargetScope } from './targets.js';

export type ElementChangeKind = 'added' | 'changed' | 'removed';

/** A name as written and its label, if it has one. */
export interface ChangedName {
    readonly name: string;
    readonly label?: string;
}

/** An element of the model that a unit added, changed or removed. */
export type ElementChange = ChangedName & {
    readonly change: ElementChangeKind;
    /** A changed element's name and label before, when they read differently now (a sticky renamed, a label rewritten). */
    readonly was?: ChangedName;
    /** What it is in: the aggregate of a state or a command, the storming of a storming's element; none for a `.dt` element. */
    readonly owner?: ChangedName;
} & (
        | {
              readonly language: 'Dt';
              /** Its model ID: `Sales.Order`, `Sales.Order#Shipped`, `Sales.Order:confirm`. */
              readonly element: string;
              readonly kind: ElementKind | 'state' | 'command';
          }
        | {
              readonly language: 'Dtes';
              readonly storming: string;
              /** Its local ID in the storming. */
              readonly local: string;
              readonly kind: StormingElementKind;
          }
    );

/** The element changes between two analyses; `complete` is false when a side's sources did not all parse. */
export interface ElementChanges {
    readonly changes: readonly ElementChange[];
    readonly complete: boolean;
}

const ORDER: Record<ElementChangeKind, number> = { added: 0, changed: 1, removed: 2 };

const named = (x: { readonly name: string; readonly label?: string }): ChangedName =>
    x.label === undefined ? { name: x.name } : { name: x.name, label: x.label };

/** `{ was }` when the name or the label before differs from the one now; nothing when they read the same. */
const wasOf = (before: ChangedName, now: ChangedName): { was?: ChangedName } =>
    before.name === now.name && before.label === now.label ? {} : { was: named(before) };

/** An item of a `.dt` model by its stable ID: an element, or a state or command with its aggregate. */
function dtItem(model: DomainModel, id: ElementId): Omit<Extract<ElementChange, { language: 'Dt' }>, 'change'> | undefined {
    const el = elementOf(model, id);
    if (el) return { language: 'Dt', element: id, kind: el.kind, ...named(el) };
    for (const owner of model.elements) {
        const state = statesOf(owner).find((s) => s.id === id);
        if (state) return { language: 'Dt', element: id, kind: 'state', ...named(state), owner: named(owner) };
        const command = commandsOf(owner).find((c) => c.id === id);
        if (command) return { language: 'Dt', element: id, kind: 'command', ...named(command), owner: named(owner) };
    }
    return undefined;
}

/** An aggregate without its states and commands and without where it is written: what it says of itself. */
const ownPart = (el: ElementModel): string => JSON.stringify({ ...el, location: undefined, states: undefined, commands: undefined });

/** The `.dt` changes: Modeling's diff, but for an aggregate changed only through its states or commands. */
function dtChanges(before: DomainModel, after: DomainModel): ElementChange[] {
    const diff = diffModels(before, after);
    const out: ElementChange[] = [];
    const push = (model: DomainModel, change: ElementChangeKind, id: ElementId, was?: DomainModel): void => {
        const item = dtItem(model, id);
        const before = was && dtItem(was, id);
        if (item) out.push({ ...item, change, ...(before && wasOf(before, item)) });
    };
    for (const id of diff.added) push(after, 'added', id);
    for (const id of diff.changed) {
        const was = elementOf(before, id);
        const is = elementOf(after, id);
        // its states or commands are listed themselves
        if (was?.kind === 'aggregate' && is?.kind === 'aggregate' && ownPart(was) === ownPart(is)) continue;
        push(after, 'changed', id, before);
    }
    for (const id of diff.removed) push(before, 'removed', id);
    return out;
}

/** A value without its source ranges (`range`, `nameRange`, `targetRange`): what it says, wherever it is written. */
function withoutRanges(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutRanges);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
        Object.entries(value).flatMap(([k, v]) => (k === 'range' || k === 'nameRange' || k === 'targetRange' ? [] : [[k, withoutRanges(v)]])),
    );
}

/** A declaration's fingerprint: a timeline names its groups, a stage its timelines (whose own changes are theirs). */
function fingerprint(d: AnyDeclaration): string {
    if (d.kind === 'stage') return JSON.stringify(withoutRanges({ ...d, timelines: d.timelines.map((t) => t.id) }));
    if (d.kind !== 'timeline') return JSON.stringify(withoutRanges(d));
    const steps = d.steps.map((s) => (s.type === 'group' ? { type: 'group', id: s.id } : s));
    return JSON.stringify(withoutRanges({ ...d, steps }));
}

/** A declaration's ID and label, as a changed name. */
const declarationName = (d: AnyDeclaration): ChangedName => (d.label === undefined ? { name: d.id } : { name: d.id, label: d.label });

/** The `.dtes` changes: each storming's declarations by local ID (a storming added or removed: all of its declarations). */
function stormingChanges(before: readonly Storming[], after: readonly Storming[]): ElementChange[] {
    const out: ElementChange[] = [];
    const item = (s: Storming, d: AnyDeclaration, change: ElementChangeKind, was?: AnyDeclaration): ElementChange => ({
        language: 'Dtes',
        storming: s.id,
        local: d.id,
        kind: d.kind,
        change,
        name: d.id,
        ...(d.label !== undefined && { label: d.label }),
        ...(was && wasOf(declarationName(was), declarationName(d))),
        owner: { name: s.id, ...(s.label !== undefined && { label: s.label }) },
    });
    const was = new Map(before.map((s) => [s.id, s]));
    const is = new Map(after.map((s) => [s.id, s]));
    for (const s of after) {
        const old = was.get(s.id);
        const oldDeclarations = old ? firstDeclarations(old) : new Map<string, AnyDeclaration>();
        for (const d of firstDeclarations(s).values()) {
            const o = oldDeclarations.get(d.id);
            if (!o) out.push(item(s, d, 'added'));
            else if (fingerprint(o) !== fingerprint(d)) out.push(item(s, d, 'changed', o));
        }
    }
    for (const s of before) {
        const now = is.get(s.id);
        const declarations = now ? firstDeclarations(now) : new Map<string, AnyDeclaration>();
        for (const d of firstDeclarations(s).values()) if (!declarations.has(d.id)) out.push(item(s, d, 'removed'));
    }
    return out;
}

/** A storming's declaration in an analysis: by storming and local ID, with its kind. */
export interface StormingElement {
    readonly storming: string;
    readonly local: string;
    readonly kind: StormingElementKind;
}

/** The declarations of an analysis's stormings; `complete` is false when its `.dtes` files did not all parse. */
export interface StormingElements {
    readonly elements: readonly StormingElement[];
    readonly complete: boolean;
}

/** Every declaration of the stormings of an analysis, each storming's in source order. */
export function stormingElements(scope: TargetScope): StormingElements {
    const elements = scope.stormings.flatMap((s) => [...firstDeclarations(s).values()].map((d) => ({ storming: s.id, local: d.id, kind: d.kind })));
    return { elements, complete: scope.stormingsComplete };
}

/**
 * The elements two analyses differ by: added, then changed, then removed, `.dt` before `.dtes`, each in source order.
 * A side whose `.dt` sources do not parse gives no `.dt` changes, one whose `.dtes` files do not all parse no storming
 * changes: the list is then incomplete.
 */
export function elementChanges(before: TargetScope, after: TargetScope): ElementChanges {
    const dt = before.model && after.model ? dtChanges(before.model, after.model) : [];
    const stormingsParse = before.stormingsComplete && after.stormingsComplete;
    const es = stormingsParse ? stormingChanges(before.stormings, after.stormings) : [];
    const changes = [...dt, ...es].map((c, i) => ({ c, i })).sort((a, b) => ORDER[a.c.change] - ORDER[b.c.change] || a.i - b.i);
    return { changes: changes.map(({ c }) => c), complete: before.model !== undefined && after.model !== undefined && stormingsParse };
}
