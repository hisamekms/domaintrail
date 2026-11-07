// Where 探す takes the page for an item of the domain model, and what it shows first when the view hides it — the
// model's counterpart of the stickies' `revealIn`: one rule, whatever hides it is taken away before it is selected.
// - A context, an aggregate, an entity, a value object or a union: the Structure View, at a level that draws it (the
//   one shown when it does), with its context among the contexts drawn when the view is narrowed to some. An
//   aggregate's detail opens on 状態.
// - A command or a state: the Structure View with its aggregate selected, its detail on 状態 showing it.
// - What the Structure View never draws (a value object no aggregate holds, a primitive, an event…): the catalog, its
//   filter cleared when it hides it.
// - Anything else: its source in the detail.
import { STRUCTURE_LEVELS, type StructureLevel } from '@domaintrail/visualization';
import type { DomainModel, ElementModel } from '@domaintrail/modeling';
import { CATALOG_SECTIONS, inCatalog, inStructure, matchesQuery, resolve, type CatalogFilter } from '../model-utils';

/** What a view's graph is read for: whether it draws an item (its nodes, by the element they stand for). */
export interface DrawnNodes {
    readonly nodes: readonly { readonly elementId?: string | undefined; readonly kind: string }[];
}

/** What the page shows to show an item of the model. */
export type ModelPlace =
    | {
          readonly view: 'structure';
          /** The item selected on the canvas (a command's or a state's aggregate). */
          readonly show: string;
          /** The level to draw it at, when the one shown does not. */
          readonly level?: StructureLevel;
          /** The contexts to draw, when the ones drawn leave its context out (null: all of them). */
          readonly contexts?: readonly string[] | null;
      }
    | { readonly view: 'catalog'; readonly clearFilter: boolean }
    | { readonly view: 'contextMap' }
    | { readonly view: 'source' };

/** Where an item of the model is shown: the view, what is selected, the detail's tab, and what was taken away for it. */
export interface ModelDestination {
    readonly select: string;
    readonly place: ModelPlace;
    /** The detail's tab: 状態 for an aggregate, a command or a state; the source for what no view draws. */
    readonly inspector?: 'states' | 'source';
}

/** What the views draw now, as the model's destination reads it. */
export interface ModelViews {
    /** Each Structure View level's graph of the whole model (the payload's). */
    readonly graphs: Readonly<Record<StructureLevel, DrawnNodes | null>>;
    readonly level: StructureLevel;
    /** The contexts drawn (null: all), and those that can be chosen. */
    readonly contexts: readonly string[] | null;
    readonly focusContexts: readonly string[];
    readonly catalog: CatalogFilter;
}

const draws = (graph: DrawnNodes | null, id: string): boolean => graph?.nodes.some((n) => n.elementId === id && n.kind !== 'stub') === true;

/**
 * The contexts to draw so that `context` is drawn: unchanged (undefined) when they are all drawn or it is among them;
 * else it added, or all of them when it cannot be chosen (a shared one).
 */
export function contextsShowing(contexts: readonly string[] | null, focusContexts: readonly string[], context: string): readonly string[] | null | undefined {
    if (contexts === null) return undefined;
    const checked = focusContexts.filter((c) => contexts.includes(c));
    if (checked.length === focusContexts.length || checked.includes(context)) return undefined;
    return focusContexts.includes(context) ? [...contexts, context] : null;
}

/** Whether the catalog's filter hides an element (its kind's section, its context, or the text). */
function catalogHides(filter: CatalogFilter, el: ElementModel): boolean {
    const section = CATALOG_SECTIONS.find((s) => (s.kinds as readonly string[]).includes(el.kind))?.key;
    if (filter.sections.length > 0 && (section === undefined || !filter.sections.includes(section))) return true;
    if (filter.contexts !== null && !filter.contexts.includes(el.context)) return true;
    return !matchesQuery(el, filter.query);
}

/** Where 探す takes the page for `id` (a context, an element, a command or a state), or undefined when the model has none. */
export function modelDestination(model: DomainModel, id: string, views: ModelViews): ModelDestination | undefined {
    const r = resolve(model, id);
    if (!r) return undefined;
    const target = r.kind === 'context' ? r.name : r.kind === 'element' ? r.el.id : r.agg.id;
    const context = r.kind === 'context' ? r.name : r.kind === 'element' ? r.el.context : r.agg.context;
    const states = r.kind === 'command' || r.kind === 'state' || (r.kind === 'element' && r.el.kind === 'aggregate');
    if (r.kind !== 'element' || inStructure(r.el.kind)) {
        const level = [views.level, ...STRUCTURE_LEVELS.filter((l) => l !== views.level)].find((l) => draws(views.graphs[l], target));
        if (level !== undefined) {
            const contexts = contextsShowing(views.contexts, views.focusContexts, context);
            return {
                select: id,
                place: { view: 'structure', show: target, ...(level !== views.level && { level }), ...(contexts !== undefined && { contexts }) },
                ...(states && { inspector: 'states' as const }),
            };
        }
    }
    if (r.kind === 'context') return { select: id, place: { view: 'contextMap' } };
    if (r.kind === 'element' && inCatalog(r.el.kind)) {
        return { select: id, place: { view: 'catalog', clearFilter: catalogHides(views.catalog, r.el) } };
    }
    return { select: id, place: { view: 'source' }, inspector: states ? 'states' : 'source' };
}

/** What a destination took away, to say it: a level, a narrowing. */
export function modelNotes(place: ModelPlace): { level?: StructureLevel; filter: boolean } {
    if (place.view === 'structure') return { ...(place.level !== undefined && { level: place.level }), filter: place.contexts !== undefined };
    return { filter: place.view === 'catalog' && place.clearFilter };
}
