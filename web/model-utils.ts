import type { DisplayMode } from '../src/graph/ir';
import { PRIMITIVE_LABELS, typeText } from '../src/graph/build';
import { type CommandModel, type DomainModel, type ElementKind, type ElementModel, type StateModel, type TypeExpr } from '../src/model/model';
import { ownerElement } from './render';

export type Select = (id: string) => void;

/** Order of element kinds in lists and the explorer (their names: `kinds` in i18n). */
export const KIND_ORDER: ElementKind[] = ['aggregate', 'entity', 'valueObject', 'union', 'primitive', 'verified', 'id', 'enum', 'fieldSet', 'event', 'error', 'policy'];

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
    return c.transitions.map((t) => `${c.factory ? 'new' : t.from.join(' | ')} → ${t.to.join(' | ')}`).join('; ');
}

/** Selection ID of a .dt file: files are selected like model items and shown in the inspector. */
export const fileSelection = (path: string): string => `file:${path}`;

/** The file a selection ID stands for, if it is one. */
export const selectedFile = (id: string | undefined): string | undefined => (id?.startsWith('file:') ? id.slice('file:'.length) : undefined);

/** Kinds that are drawn in the Structure View. */
export const inStructure = (kind: string): boolean => kind === 'aggregate' || kind === 'entity' || kind === 'valueObject' || kind === 'union';

export type CatalogSectionKey = 'aggregates' | 'entities' | 'values' | 'primitives' | 'fieldSets' | 'events' | 'errors' | 'policies';

/** Sections of the catalog, in order, and the kinds of element each holds (in the order of its cards). */
export const CATALOG_SECTIONS: { key: CatalogSectionKey; kinds: ElementKind[] }[] = [
    { key: 'aggregates', kinds: ['aggregate'] },
    { key: 'entities', kinds: ['entity'] },
    { key: 'values', kinds: ['valueObject', 'union'] },
    { key: 'primitives', kinds: ['primitive', 'verified', 'id', 'enum'] },
    { key: 'fieldSets', kinds: ['fieldSet'] },
    { key: 'events', kinds: ['event'] },
    { key: 'errors', kinds: ['error'] },
    { key: 'policies', kinds: ['policy'] },
];

/** Kinds shown in the catalog. */
export const inCatalog = (kind: string): boolean => CATALOG_SECTIONS.some((s) => (s.kinds as readonly string[]).includes(kind));

export interface CatalogSection {
    key: CatalogSectionKey;
    kinds: ElementKind[];
    /** Contexts with elements of the section, shared ones first. */
    groups: { context: string; items: ElementModel[] }[];
    count: number;
}

/** The catalog's sections with their elements per context, sorted by kind and then name. */
export function catalogSections(model: DomainModel): CatalogSection[] {
    const contexts = orderedContexts(model);
    return CATALOG_SECTIONS.map(({ key, kinds }) => {
        const groups = contexts
            .map((context) => ({
                context,
                items: Object.values(model.elements)
                    .filter((e) => e.context === context && kinds.includes(e.kind))
                    .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.name.localeCompare(b.name)),
            }))
            .filter((g) => g.items.length > 0);
        return { key, kinds, groups, count: groups.reduce((n, g) => n + g.items.length, 0) };
    });
}

/** What the catalog is narrowed to; an empty query, no sections and no contexts (null) each mean all. */
export interface CatalogFilter {
    query: string;
    sections: CatalogSectionKey[];
    contexts: string[] | null;
}

export const isCatalogFiltered = (f: CatalogFilter): boolean => f.query.trim() !== '' || f.sections.length > 0 || f.contexts !== null;

/** The element's label, name or description contains the query, ignoring case. */
export function matchesQuery(el: ElementModel, query: string): boolean {
    const q = query.trim().toLowerCase();
    return !q || [el.label, el.name, el.doc].some((s) => s?.toLowerCase().includes(q));
}

/**
 * The sections with only the matching elements, in the same order; `count` stays the section's total and `shown`
 * counts the matches. Sections left out by kind keep no groups.
 */
export function filterCatalog(sections: CatalogSection[], filter: CatalogFilter): (CatalogSection & { shown: number })[] {
    return sections.map((s) => {
        const groups = filter.sections.length && !filter.sections.includes(s.key)
            ? []
            : s.groups
                  .filter((g) => filter.contexts === null || filter.contexts.includes(g.context))
                  .map((g) => ({ ...g, items: g.items.filter((e) => matchesQuery(e, filter.query)) }))
                  .filter((g) => g.items.length > 0);
        return { ...s, groups, shown: groups.reduce((n, g) => n + g.items.length, 0) };
    });
}

export { commandsWithOutcome, fieldSetUsers } from '../src/model/usages';
export { policiesReactingTo, policiesRunning } from '../src/model/model';

/** The command a policy runs (`Agg:command`), with its aggregate, when both resolve. */
export function policyTarget(model: DomainModel, p: ElementModel): { agg: ElementModel; command: CommandModel } | undefined {
    const agg = p.policy && model.elements[p.policy.aggregate];
    const command = agg?.commands?.find((c) => c.name === p.policy!.command);
    return agg && command ? { agg, command } : undefined;
}

/** Contexts with shared ones first. */
export function orderedContexts(model: DomainModel): string[] {
    const shared = new Set(model.sharedContexts);
    return [...model.contexts].sort((a, b) => Number(shared.has(b)) - Number(shared.has(a)) || a.localeCompare(b));
}

/** Display names for the current mode, used throughout the inspector and lists. */
export interface Namer {
    mode: DisplayMode;
    /** Any named item (element, state, command, invariant, enum value…). */
    of: (x: { name: string; label?: string }) => string;
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
    id: (id: string) => string;
    /** A short name of an element by ID: in 両方 its label alone (the name is in a tooltip, or nearby). */
    short(id: string): string;
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
            const states = (names: string[]) => names.map((n) => state(agg, n)).join(' | ');
            return c.transitions.map((t) => `${c.factory ? 'new' : states(t.from)} → ${states(t.to)}`).join('; ');
        },
        short(id) {
            const el = model?.elements[id];
            if (!el) return shortName(id);
            return mode === 'both' ? (el.label ?? el.name) : of(el);
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
