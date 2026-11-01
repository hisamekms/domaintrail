import { representative } from './dependencies.js';
import { allFieldsOf, elementList, type DomainModel, type ElementModel } from './model.js';

/** Value types and entities: what a field can hold inside an aggregate. */
const HELD_KINDS = new Set<ElementModel['kind']>(['entity', 'valueObject', 'union']);

/** Aggregates that (transitively) hold each entity / value object. */
export function owningAggregates(elements: readonly ElementModel[], byId: Map<string, ElementModel>): Map<string, Set<string>> {
    const owners = new Map<string, Set<string>>();
    for (const agg of elements.filter((e) => e.kind === 'aggregate')) {
        const stack: ElementModel[] = [agg];
        const seen = new Set<string>();
        while (stack.length) {
            const el = stack.pop()!;
            if (seen.has(el.id)) continue;
            seen.add(el.id);
            for (const f of allFieldsOf(el)) {
                if (f.kind === 'references' || f.type.kind !== 'ref') continue;
                const t = byId.get(f.type.ref);
                if (!t || !HELD_KINDS.has(t.kind)) continue;
                const set = owners.get(t.id) ?? new Set<string>();
                set.add(agg.id);
                owners.set(t.id, set);
                stack.push(t);
            }
        }
    }
    return owners;
}

/** The aggregate of `ctx` that alone holds an element (of `owners`, from `owningAggregates`), if there is one. */
export function soleOwner(owners: Set<string> | undefined, ctx: string): string | undefined {
    if (!owners || owners.size !== 1) return undefined;
    const [owner] = owners;
    return owner.startsWith(`${ctx}.`) ? owner : undefined;
}

/** A dependency of one aggregate on another, with the paths of the fields it goes through (`items.product`). */
export interface AggregateDependency {
    source: string;
    target: string;
    /** Holds a type of the other aggregate, not only its ID. */
    type: boolean;
    paths: string[];
}

/**
 * Dependencies between aggregates: an aggregate depends on another when it, or an entity / value object / union it
 * holds, references it, holds its ID or the ID of one of its entities, or holds it as a value. One per pair, in
 * declaration order.
 */
export function aggregateDependencies(model: DomainModel): AggregateDependency[] {
    const elements = elementList(model);
    const byId = new Map(elements.map((e) => [e.id, e]));
    const owners = owningAggregates(elements, byId);
    /** The aggregate that stands for an element: itself, or the aggregate that owns an entity. */
    const aggregateOf = (el: ElementModel | undefined): string | undefined =>
        el?.kind === 'aggregate' ? el.id : el?.kind === 'entity' ? soleOwner(owners.get(el.id), el.context) : undefined;
    const out = new Map<string, AggregateDependency>();
    for (const agg of elements.filter((e) => e.kind === 'aggregate')) {
        const add = (target: string | undefined, type: boolean, path: string): void => {
            if (!target || target === agg.id) return;
            const key = `${agg.id}=>${target}`;
            const dep = out.get(key) ?? { source: agg.id, target, type: false, paths: [] };
            dep.type ||= type;
            if (!dep.paths.includes(path)) dep.paths.push(path);
            out.set(key, dep);
        };
        const queue: [ElementModel, string][] = [[agg, '']];
        const seen = new Set<string>();
        while (queue.length) {
            const [el, prefix] = queue.shift()!;
            if (seen.has(el.id)) continue;
            seen.add(el.id);
            for (const f of allFieldsOf(el)) {
                const path = prefix + f.name;
                if (f.kind === 'references') {
                    if (f.target) add(aggregateOf(representative(model, f.target)), false, path);
                    continue;
                }
                const t = f.type.kind === 'ref' ? byId.get(f.type.ref) : undefined;
                if (t?.kind === 'id') add(aggregateOf(representative(model, t.id)), false, path);
                else if (t?.kind === 'aggregate') add(t.id, true, path);
                else if (t && HELD_KINDS.has(t.kind)) queue.push([t, `${path}.`]);
            }
        }
    }
    return [...out.values()];
}
