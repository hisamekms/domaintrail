import type { DisplayMode } from '../src/graph/ir';
import { PRIMITIVE_LABELS, typeText } from '../src/graph/build';
import type { CommandModel, DomainModel, ElementKind, ElementModel, StateModel, TypeExpr } from '../src/model/model';
import { ownerElement } from './render';

export type Select = (id: string) => void;

export const KIND_LABEL: Record<string, string> = {
    id: 'ID',
    primitive: 'Domain Primitive',
    enum: 'Enum',
    valueObject: 'Value Object',
    union: 'Union',
    entity: 'Entity',
    aggregate: 'Aggregate',
    event: 'Event',
    error: 'Error',
    state: 'State',
    command: 'Command',
    context: 'Context',
};

/** Order of element kinds in lists and the explorer (group titles: `kindGroups` in i18n). */
export const KIND_ORDER: ElementKind[] = ['aggregate', 'entity', 'valueObject', 'union', 'primitive', 'id', 'enum', 'event', 'error'];

export const shortName = (q: string): string => q.slice(q.lastIndexOf('.') + 1);

/** `確定済み (Confirmed)` when a label exists, otherwise the name. */
export const withLabel = (x: { name: string; label?: string }): string => (x.label ? `${x.label} (${x.name})` : x.name);

/** A name in the given display mode. */
export const nameIn = (mode: DisplayMode, name: string, label?: string): string =>
    mode === 'name' || !label ? name : mode === 'label' ? label : `${label} (${name})`;

export type Resolved =
    | { kind: 'context'; name: string; label?: string; shared: boolean }
    | { kind: 'element'; el: ElementModel }
    | { kind: 'state'; agg: ElementModel; state: StateModel }
    | { kind: 'command'; agg: ElementModel; command: CommandModel };

/** Resolves a context, element, state (`Agg#State`) or command (`Agg:cmd`) ID. */
export function resolve(model: DomainModel, id: string): Resolved | undefined {
    if (model.contexts.includes(id)) {
        return { kind: 'context', name: id, label: model.contextLabels[id], shared: model.sharedContexts.includes(id) };
    }
    const el = model.elements[id];
    if (el) return { kind: 'element', el };
    const agg = model.elements[ownerElement(id)];
    const state = agg?.states?.find((s) => s.id === id);
    if (agg && state) return { kind: 'state', agg, state };
    const command = agg?.commands?.find((c) => c.id === id);
    if (agg && command) return { kind: 'command', agg, command };
    return undefined;
}

export function transitionText(agg: ElementModel, c: CommandModel): string {
    if (!agg.states?.length) return c.factory ? 'new' : '';
    return `${c.factory ? 'new' : c.from.join(' | ')} → ${c.to.join(' | ')}`;
}

/** Kinds that are drawn in the Structure View. */
export const inStructure = (kind: string): boolean => kind === 'aggregate' || kind === 'entity' || kind === 'valueObject' || kind === 'union';

/** Kinds shown in the Primitives catalog. */
export const inCatalog = (kind: string): boolean => kind === 'primitive' || kind === 'id' || kind === 'enum';

/** Contexts with shared ones first. */
export function orderedContexts(model: DomainModel): string[] {
    const shared = new Set(model.sharedContexts);
    return [...model.contexts].sort((a, b) => Number(shared.has(b)) - Number(shared.has(a)) || a.localeCompare(b));
}

/** Display names for the current mode, used throughout the inspector and lists. */
export interface Namer {
    mode: DisplayMode;
    /** Any named item (element, state, command, invariant, enum value…). */
    of(x: { name: string; label?: string }): string;
    /** A field or parameter: its resolved label (inline, term or type). */
    field(f: { name: string; label?: string }): string;
    /** A type as written in `ctx`; in `label` mode built-in types and labelled elements use their labels. */
    type(t: TypeExpr, ctx: string): string;
    /** A built-in type name (e.g. the base of a domain primitive). */
    primitive(name: string): string;
    /** A state of an aggregate, by name. */
    state(agg: ElementModel, name: string): string;
    /** `Draft | Confirmed → Cancelled` with display names. */
    transition(agg: ElementModel, c: CommandModel): string;
    /** An element, state or command by ID. */
    id(id: string): string;
}

export function namer(mode: DisplayMode, model: DomainModel | null): Namer {
    const of = (x: { name: string; label?: string }) => nameIn(mode, x.name, x.label);
    const state = (agg: ElementModel, name: string) => {
        const s = agg.states?.find((x) => x.name === name);
        return s ? of(s) : name;
    };
    return {
        mode,
        of,
        field: of,
        type(t, ctx) {
            const byName = typeText(t, ctx, model?.sharedContexts ?? []);
            if (mode !== 'label') return byName;
            return t.kind === 'primitive' ? PRIMITIVE_LABELS[t.name] : (model?.elements[t.ref]?.label ?? byName);
        },
        primitive: (name) => (mode === 'label' ? (PRIMITIVE_LABELS[name] ?? name) : name),
        state,
        transition(agg, c) {
            if (!agg.states?.length) return c.factory ? 'new' : '';
            return `${c.factory ? 'new' : c.from.map((n) => state(agg, n)).join(' | ')} → ${c.to.map((n) => state(agg, n)).join(' | ')}`;
        },
        id(id) {
            const r = model ? resolve(model, id) : undefined;
            if (!r) return id;
            if (r.kind === 'context') return nameIn(mode, r.name, r.label);
            if (r.kind === 'element') return of(r.el);
            if (r.kind === 'state') return `${of(r.agg)}.${of(r.state)}`;
            return `${of(r.agg)}.${of(r.command)}`;
        },
    };
}
