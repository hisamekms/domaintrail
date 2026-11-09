import type { ContextDependency, Dependency, DependencyKind } from '../generated/Modeling.js';
import { commandsOf, contextNames, elementOf, emittedEvents, emittedEventsInAggregate, fieldSetsOf, ownFields, sharedContexts, statesOf, variantsOf } from './model.js';
import type { ContextName, DomainModel, ElementModel, FieldModel, QualifiedName } from './model.js';
import { contextName } from './ids.js';
import { identityOf } from './usages.js';

export type { ContextDependency, Dependency, DependencyKind } from '../generated/Modeling.js';

/** Every use of an element of another context, in declaration order. */
export function contextDependencies(model: DomainModel): Dependency[] {
    const out: Dependency[] = [];
    const contexts = new Set<string>(contextNames(model));
    for (const el of model.elements) {
        const add = (target: QualifiedName | undefined, path: string, kind?: DependencyKind): void => {
            const to = target ? contextOfName(target) : undefined;
            if (!target || !to || to === el.context || !contexts.has(to)) return;
            out.push({ from: el.context, to, kind: kind ?? (elementOf(model, target)?.kind === 'id' ? 'id' : 'type'), source: el.id, path, target });
        };
        const field = (f: FieldModel, path: string): void => {
            if (f.kind === 'references' && f.target) add(f.target, path, 'id');
            else if (f.type.kind === 'ref') add(f.type.ref, path);
        };
        // fields taken from a field set are uses of the field set, recorded with it
        for (const f of ownFields(el)) field(f, f.name);
        for (const fs of fieldSetsOf(el)) add(fs, 'with');
        for (const s of statesOf(el)) for (const f of s.fields) field(f, `${s.name}.${f.name}`);
        for (const v of variantsOf(el)) for (const f of v.fields) field(f, `${v.name}.${f.name}`);
        if (el.kind === 'union' && el.tagType) add(el.tagType, 'by');
        if (el.kind === 'verified') {
            if (el.verified.of.kind === 'ref') add(el.verified.of.ref, 'of');
            if (el.verified.for?.type.kind === 'ref') add(el.verified.for.type.ref, 'for');
            for (const e of el.verified.errors) add(e, `⇒ ${shortName(e)}`);
        }
        if (el.kind === 'policy') add(el.policy.event, `when ${shortName(el.policy.event)}`, 'event');
        for (const c of commandsOf(el)) {
            for (const p of c.params) field(p, `${c.name}(${p.name})`);
            for (const e of [...(el.kind === 'aggregate' ? emittedEventsInAggregate(el, c) : emittedEvents(c)), ...c.errors]) add(e, `${c.name} ⇒ ${shortName(e)}`);
        }
    }
    return out;
}

/** Dependencies grouped by pair of contexts. */
export function groupByContext(deps: readonly Dependency[]): ContextDependency[] {
    const byPair = new Map<string, { from: ContextName; to: ContextName; uses: Dependency[]; ids: number; types: number; events: number }>();
    for (const d of deps) {
        const key = `${d.from}->${d.to}`;
        const g = byPair.get(key) ?? { from: d.from, to: d.to, uses: [], ids: 0, types: 0, events: 0 };
        g.uses.push(d);
        if (d.kind === 'id') g.ids++;
        else if (d.kind === 'event') g.events++;
        else g.types++;
        byPair.set(key, g);
    }
    return [...byPair.values()];
}

/**
 * Contexts that are infrastructure rather than domain in a context map: shared contexts (used everywhere by design)
 * and contexts that only declare IDs of things living elsewhere (identity, partners, external systems).
 */
export function supportingContexts(model: DomainModel): Set<ContextName> {
    const out = new Set(sharedContexts(model));
    for (const ctx of contextNames(model)) {
        const els = model.elements.filter((e) => e.context === ctx);
        if (els.length > 0 && els.every((e) => e.kind === 'id')) out.add(ctx);
    }
    return out;
}

/**
 * The element that stands for `target` in a diagram: an ID is shown as the aggregate or entity it identifies
 * (when one exists), anything else as itself.
 */
export function representative(model: DomainModel, target: string): ElementModel | undefined {
    const el = elementOf(model, target);
    if (el?.kind !== 'id') return el;
    return model.elements.find((e) => (e.kind === 'aggregate' || e.kind === 'entity') && identityOf(e) === target) ?? el;
}

const contextOfName = (qname: string): ContextName | undefined => (qname.includes('.') ? contextName(qname.slice(0, qname.indexOf('.'))) : undefined);
const shortName = (qname: string): string => qname.slice(qname.lastIndexOf('.') + 1);
