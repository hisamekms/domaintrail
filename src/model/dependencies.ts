import type { DomainModel, ElementModel, FieldModel } from './model.js';
import { elementList, emittedEvents, ownFields } from './model.js';
import { identityOf } from './usages.js';

/**
 * How one bounded context depends on another:
 *   id    an identifier of the other context (`references`, or a field typed with its ID)
 *   type  any other type of the other context (value object, union, enum, domain primitive, event, field set)
 */
export type DependencyKind = 'id' | 'type';

/** One use of an element of another context. */
export interface Dependency {
    /** Context that uses the element. */
    from: string;
    /** Context that declares it. */
    to: string;
    kind: DependencyKind;
    /** Element that holds the use (aggregate, entity, value object, union, event, error). */
    source: string;
    /**
     * Where in the source: `field`, `State.field`, `VARIANT.field`, `command(param)`, `by`, `with`, `command ⇒ Event`, and
     * `of`, `for`, `⇒ Error` of a verified type.
     */
    path: string;
    /** The element used (qualified name). */
    target: string;
}

/** Every use of an element of another context, in declaration order. */
export function contextDependencies(model: DomainModel): Dependency[] {
    const out: Dependency[] = [];
    for (const el of elementList(model)) {
        const add = (target: string | undefined, path: string, kind?: DependencyKind): void => {
            const to = target ? contextOf(target) : undefined;
            if (!target || !to || to === el.context || !model.contexts.includes(to)) return;
            out.push({ from: el.context, to, kind: kind ?? (model.elements[target]?.kind === 'id' ? 'id' : 'type'), source: el.id, path, target });
        };
        const field = (f: FieldModel, path: string): void => {
            if (f.kind === 'references' && f.target) add(f.target, path, 'id');
            else if (f.type.kind === 'ref') add(f.type.ref, path);
        };
        // fields taken from a field set are uses of the field set, recorded with it
        for (const f of ownFields(el)) field(f, f.name);
        for (const fs of el.fieldSets ?? []) add(fs, 'with');
        for (const s of el.states ?? []) for (const f of s.fields) field(f, `${s.name}.${f.name}`);
        for (const v of el.variants ?? []) for (const f of v.fields) field(f, `${v.name}.${f.name}`);
        if (el.tagType) add(el.tagType, 'by');
        if (el.verified) {
            if (el.verified.of.kind === 'ref') add(el.verified.of.ref, 'of');
            if (el.verified.for?.type.kind === 'ref') add(el.verified.for.type.ref, 'for');
            for (const e of el.verified.errors) add(e, `⇒ ${shortName(e)}`);
        }
        for (const c of el.commands ?? []) {
            for (const p of c.params) field(p, `${c.name}(${p.name})`);
            for (const e of [...emittedEvents(c), ...c.errors]) add(e, `${c.name} ⇒ ${shortName(e)}`);
        }
    }
    return out;
}

/** A dependency between two contexts with all its uses. */
export interface ContextDependency {
    from: string;
    to: string;
    uses: Dependency[];
    ids: number;
    types: number;
}

/** Dependencies grouped by pair of contexts. */
export function groupByContext(deps: readonly Dependency[]): ContextDependency[] {
    const byPair = new Map<string, ContextDependency>();
    for (const d of deps) {
        const key = `${d.from}->${d.to}`;
        const g = byPair.get(key) ?? { from: d.from, to: d.to, uses: [], ids: 0, types: 0 };
        g.uses.push(d);
        if (d.kind === 'id') g.ids++;
        else g.types++;
        byPair.set(key, g);
    }
    return [...byPair.values()];
}

/**
 * Contexts that are infrastructure rather than domain in a context map: shared contexts (used everywhere by design)
 * and contexts that only declare IDs of things living elsewhere (identity, partners, external systems).
 */
export function supportingContexts(model: DomainModel): Set<string> {
    const out = new Set(model.sharedContexts);
    for (const ctx of model.contexts) {
        const els = elementList(model).filter((e) => e.context === ctx);
        if (els.length > 0 && els.every((e) => e.kind === 'id')) out.add(ctx);
    }
    return out;
}

/**
 * The element that stands for `target` in a diagram: an ID is shown as the aggregate or entity it identifies
 * (when one exists), anything else as itself.
 */
export function representative(model: DomainModel, target: string): ElementModel | undefined {
    const el = model.elements[target];
    if (el?.kind !== 'id') return el;
    return elementList(model).find((e) => (e.kind === 'aggregate' || e.kind === 'entity') && identityOf(e) === target) ?? el;
}

const contextOf = (qname: string): string | undefined => (qname.includes('.') ? qname.slice(0, qname.indexOf('.')) : undefined);
const shortName = (qname: string): string => qname.slice(qname.lastIndexOf('.') + 1);
