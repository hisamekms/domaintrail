import type { CommandModel, DomainModel, ElementModel, FieldModel, TypeExpr, VariantModel } from '../model/model.js';
import { contextDependencies, representative, supportingContexts } from '../model/dependencies.js';
import { allFieldsOf, elementList } from '../model/model.js';
import {
    CHAR_WIDTH,
    DISPLAY_MODES,
    HEADER_HEIGHT,
    LINE_HEIGHT,
    maxUnits,
    sameText,
    textUnits,
    type Graph,
    type GraphEdge,
    type GraphLine,
    type GraphNode,
    type Texts,
    OVERVIEW_TEXT_SCALE,
} from './ir.js';

export const STRUCTURE_GRAPH_ID = 'structure';
export const stateGraphId = (aggregateId: string): string => `states:${aggregateId}`;
export const boundaryId = (aggregateId: string): string => `${aggregateId}@boundary`;
export const initialNodeId = (aggregateId: string): string => `${aggregateId}@new`;

const STEREOTYPES: Partial<Record<ElementModel['kind'], string>> = {
    aggregate: '«aggregate root»',
    entity: '«entity»',
    valueObject: '«value object»',
    union: '«union»',
};

/** Indent of variant fields under their variant row (no-break spaces, which HTML does not collapse). */
export const VARIANT_INDENT = '\u00a0\u00a0';

/** Element kinds drawn as nodes in the Structure View. */
const STRUCTURE_KINDS = new Set<ElementModel['kind']>(['aggregate', 'entity', 'valueObject', 'union']);
/** Value types and entities: what a field can hold inside an aggregate. */
const HELD_KINDS = new Set<ElementModel['kind']>(['entity', 'valueObject', 'union']);

/** Type name as written in `ctx`: own and shared-context types by simple name, others qualified. */
/** Japanese names of built-in types, used in the 日本語 display mode. */
export const PRIMITIVE_JA: Record<string, string> = {
    String: '文字列',
    Int: '整数',
    Decimal: '小数',
    Bool: '真偽値',
    Timestamp: '日時',
    UUID: 'UUID',
};

export function typeText(t: TypeExpr, ctx: string, shared: readonly string[] = []): string {
    if (t.kind === 'primitive') return t.name;
    const owner = t.ref.slice(0, t.ref.indexOf('.'));
    return owner === ctx || shared.includes(owner) ? t.ref.slice(owner.length + 1) : t.ref;
}

export function fieldText(f: FieldModel, ctx: string): string {
    const marker = f.kind === 'owns' ? '◆ ' : f.kind === 'references' ? '→ ' : '';
    return `${marker}${f.name}: ${typeText(f.type, ctx)}${f.multiplicity}`;
}

/** `name` / `label` / `label name` depending on the display mode (label falls back to the name). */
export function named(name: string, label: string | undefined, both = (l: string, n: string) => `${l} (${n})`, suffix = ''): Texts {
    return { en: name + suffix, ja: (label ?? name) + suffix, both: (label ? both(label, name) : name) + suffix };
}

const lookupLabel = (model: DomainModel, qname: string): string | undefined => model.elements[qname]?.label;

/** A field row in every display mode: key `◆ 明細` / `◆ items`, value `注文明細[0..*]` / `OrderItem[0..*]`. */
export function fieldLine(f: FieldModel, ctx: string, model: DomainModel, indent = ''): GraphLine {
    const marker = indent + (f.kind === 'owns' ? '◆ ' : f.kind === 'references' ? '→ ' : '');
    const en = typeText(f.type, ctx, model.sharedContexts);
    const ja = f.type.kind === 'ref' ? (lookupLabel(model, f.type.ref) ?? en) : PRIMITIVE_JA[f.type.name];
    return {
        key: {
            en: `${marker}${f.name}`,
            ja: `${marker}${f.label ?? f.name}`,
            both: `${marker}${f.label ? `${f.label} ` : ''}${f.name}`,
        },
        value: { en: en + f.multiplicity, ja: ja + f.multiplicity, both: en + f.multiplicity },
    };
}

/** Space between the key and value columns, in characters. */
const COLUMN_GAP = 2;

/** Widest body row in any display mode, with keys and values aligned in two columns. */
function bodyUnits(lines: GraphLine[]): number {
    return Math.max(
        0,
        ...DISPLAY_MODES.map((m) => {
            const key = Math.max(0, ...lines.filter((l) => l.value).map((l) => textUnits(l.key[m])));
            const value = Math.max(0, ...lines.map((l) => (l.value ? textUnits(l.value[m]) : 0)));
            const keyOnly = Math.max(0, ...lines.filter((l) => !l.value).map((l) => textUnits(l.key[m])));
            return Math.max(value ? key + COLUMN_GAP + value : 0, keyOnly);
        }),
    );
}

export function sized(n: Omit<GraphNode, 'width' | 'height'>, scale = 1): GraphNode {
    const longest = Math.max(maxUnits(n.label) + 2, n.stereotype ? textUnits(n.stereotype) : 0, bodyUnits(n.lines));
    return {
        ...n,
        width: Math.max(170 * scale, Math.ceil(longest * CHAR_WIDTH * scale + 28)),
        height: Math.ceil(HEADER_HEIGHT * scale) + n.lines.length * LINE_HEIGHT + (n.lines.length ? 10 : 0),
    };
}

/**
 * Structure View: contexts contain aggregate boundaries; an aggregate boundary contains the root
 * and every entity / value object owned exclusively by that aggregate. Shared value objects and
 * unowned entities are placed directly in their context.
 */
export const STRUCTURE_OVERVIEW_GRAPH_ID = 'structure-overview';

/**
 * Structure View of some bounded contexts, with the elements they depend on and that depend on them as stubs
 * (except those of the `hidden` contexts).
 */
export const focusGraphId = (contexts: readonly string[], overview = false, hidden: readonly string[] = []): string =>
    `structure-focus:${[...contexts].sort().join('+')}${hidden.length ? `:hide=${[...hidden].sort().join('+')}` : ''}${overview ? ':overview' : ''}`;

/**
 * Structure View. With `overview`, nodes show only their names (no field rows) in larger text,
 * to see the whole model at a glance. With `focus`, only those contexts are drawn (see `focusStubs`), and
 * the dependencies on and from the `hidden` contexts are left out.
 */
export function buildStructureGraph(model: DomainModel, opts: { overview?: boolean; focus?: readonly string[]; hidden?: readonly string[] } = {}): Graph {
    const scale = opts.overview ? OVERVIEW_TEXT_SCALE : 1;
    const elements = elementList(model);
    const focus = opts.focus?.length ? new Set(opts.focus) : undefined;
    const shown = elements.filter((e) => STRUCTURE_KINDS.has(e.kind) && (!focus || focus.has(e.context)));
    const byId = new Map(elements.map((e) => [e.id, e]));
    const owners = owningAggregates(shown, byId);
    const hidden = (opts.hidden ?? []).filter((c) => !focus?.has(c));
    const stubs = focus ? focusStubs(model, focus, new Set(shown.map((e) => e.id)), new Set(hidden)) : undefined;

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const usedContexts = new Set([...shown, ...(stubs?.elements ?? [])].map((e) => e.context));
    for (const ctx of model.contexts) {
        if (!usedContexts.has(ctx)) continue;
        const shared = model.sharedContexts.includes(ctx);
        const base = named(ctx, model.contextLabels[ctx]);
        const label = shared ? { en: `${base.en} · shared`, ja: `${base.ja} · 共有`, both: `${base.both} · 共有` } : base;
        nodes.push({ id: ctx, kind: shared ? 'sharedContext' : 'context', label, lines: [], elementId: ctx, width: 0, height: 0 });
    }

    for (const el of shown) {
        if (el.kind === 'aggregate') {
            nodes.push({
                id: boundaryId(el.id),
                kind: 'aggregateBoundary',
                label: { en: `${el.name} aggregate`, ja: `${el.label ?? el.name} 集約`, both: `${el.label ? `${el.label} (${el.name})` : el.name} aggregate` },
                lines: [],
                parent: el.context,
                elementId: el.id,
                width: 0,
                height: 0,
            });
        }
        const owner = el.kind === 'aggregate' ? el.id : soleOwner(owners.get(el.id), el.context);
        const lines = opts.overview ? [] : el.fields.map((f) => fieldLine(f, el.context, model));
        if (!opts.overview && el.kind === 'union') {
            // One row per variant (the discriminator value), followed by its fields.
            for (const v of el.variants ?? []) {
                lines.push({ key: named(`${el.discriminator}: ${v.name}`, v.label && `${v.label}`, (l, n) => `${l} (${n})`) });
                lines.push(...v.fields.map((f) => fieldLine(f, el.context, model, VARIANT_INDENT)));
            }
        }
        if (!opts.overview && el.kind === 'aggregate' && el.states?.length) {
            const en = el.states.map((s) => s.name).join(' | ');
            const ja = el.states.map((s) => s.label ?? s.name).join(' | ');
            lines.push({ key: { en: 'state', ja: '状態', both: '状態 state' }, value: { en, ja, both: en } });
        }
        nodes.push(
            sized({
                id: el.id,
                kind: el.kind as GraphNode['kind'],
                label: named(el.name, el.label),
                stereotype: STEREOTYPES[el.kind],
                lines,
                parent: owner ? boundaryId(owner) : el.context,
                elementId: el.id,
            }, scale),
        );

        const fields: [FieldModel, VariantModel | undefined][] = [
            ...[...el.fields, ...(el.states ?? []).flatMap((s) => s.fields)].map((f): [FieldModel, undefined] => [f, undefined]),
            ...(el.variants ?? []).flatMap((v) => v.fields.map((f): [FieldModel, VariantModel] => [f, v])),
        ];
        const seen = new Set<string>();
        for (const [f, variant] of fields) {
            const edge = fieldEdge(el, f, byId, variant);
            // in a focused view, dependencies between contexts are drawn from the context dependencies instead
            if (edge && focus && byId.get(edge.target)?.context !== el.context) continue;
            if (edge && !seen.has(edge.id)) {
                seen.add(edge.id);
                edges.push(edge);
            }
        }
    }
    if (stubs) {
        for (const el of stubs.elements) {
            nodes.push(
                sized({ id: el.id, kind: 'stub', label: named(el.name, el.label), stereotype: STUB_STEREOTYPES[el.kind], lines: [], parent: el.context, elementId: el.id }, scale),
            );
        }
        edges.push(...stubs.edges);
        const id = focusGraphId(opts.focus!, opts.overview, hidden);
        return opts.overview ? { id, nodes, edges, textScale: scale } : { id, nodes, edges };
    }
    return opts.overview ? { id: STRUCTURE_OVERVIEW_GRAPH_ID, nodes, edges, textScale: scale } : { id: STRUCTURE_GRAPH_ID, nodes, edges };
}

const STUB_STEREOTYPES: Record<ElementModel['kind'], string> = {
    aggregate: '«aggregate»',
    entity: '«entity»',
    valueObject: '«value object»',
    union: '«union»',
    enum: '«enum»',
    primitive: '«primitive»',
    id: '«id»',
    event: '«event»',
    error: '«error»',
};

/**
 * Dependencies of the focused contexts, both ways: elements of other contexts that they use, and elements of other
 * contexts that use them, drawn as stubs (name only) in their own context. Dependencies between two focused contexts
 * are drawn between their elements. An ID stands for the aggregate or entity it identifies, and an element that the
 * Structure View does not draw (an enum, a domain primitive) appears as a stub. Shared and ID-only contexts and the
 * `hidden` ones are left out, and so are uses inside events and errors (they repeat the aggregate's fields). One edge
 * per pair of elements, labeled with the fields.
 */
function focusStubs(
    model: DomainModel,
    focus: ReadonlySet<string>,
    shownIds: Set<string>,
    hiddenContexts: ReadonlySet<string>,
): { elements: ElementModel[]; edges: GraphEdge[] } {
    const hidden = new Set([...supportingContexts(model), ...hiddenContexts]);
    const stubs = new Map<string, ElementModel>();
    const pairs = new Map<string, { source: string; target: string; type: boolean; paths: string[] }>();
    for (const d of contextDependencies(model)) {
        if ((!focus.has(d.from) && !focus.has(d.to)) || hidden.has(d.from) || hidden.has(d.to)) continue;
        const source = model.elements[d.source];
        const target = representative(model, d.target);
        if (!source || !target || source.kind === 'event' || source.kind === 'error') continue;
        for (const el of [source, target]) if (!shownIds.has(el.id)) stubs.set(el.id, el);
        const key = `${source.id}=>${target.id}`;
        const pair = pairs.get(key) ?? { source: source.id, target: target.id, type: false, paths: [] };
        pair.type ||= d.kind === 'type';
        if (!pair.paths.includes(d.path)) pair.paths.push(d.path);
        pairs.set(key, pair);
    }
    const edges = [...pairs.entries()].map(([id, p]): GraphEdge => {
        const shown = p.paths.slice(0, 2).join(', ');
        const more = p.paths.length - 2;
        return {
            id,
            kind: p.type ? 'value' : 'references',
            source: p.source,
            target: p.target,
            label: { en: more > 0 ? `${shown} +${more}` : shown, ja: more > 0 ? `${shown} 他${more}` : shown, both: more > 0 ? `${shown} 他${more}` : shown },
        };
    });
    return { elements: [...stubs.values()], edges };
}

/** Edge for a field that holds or references another element; fields of a union variant are prefixed with the variant. */
function fieldEdge(el: ElementModel, f: FieldModel, byId: Map<string, ElementModel>, variant?: VariantModel): GraphEdge | undefined {
    const id = variant ? `${el.id}.${variant.name}.${f.name}` : `${el.id}.${f.name}`;
    const label = (suffix = ''): Texts => {
        const field = named(f.name, f.label, (l, n) => `${l} ${n}`, suffix);
        if (!variant) return field;
        const v = named(variant.name, variant.label, (l, n) => `${l} ${n}`);
        return { en: `${v.en}.${field.en}`, ja: `${v.ja}.${field.ja}`, both: `${v.both}.${field.both}` };
    };
    if (f.kind === 'references') {
        if (!f.target || byId.get(f.target)?.kind !== 'aggregate') return undefined;
        return { id, kind: 'references', source: el.id, target: f.target, label: label() };
    }
    if (f.type.kind !== 'ref') return undefined;
    const target = byId.get(f.type.ref);
    if (!target || !HELD_KINDS.has(target.kind)) return undefined;
    return { id, kind: f.kind === 'owns' ? 'owns' : 'value', source: el.id, target: target.id, label: label(f.multiplicity) };
}

/** Aggregates that (transitively) hold each entity / value object. */
function owningAggregates(shown: ElementModel[], byId: Map<string, ElementModel>): Map<string, Set<string>> {
    const owners = new Map<string, Set<string>>();
    for (const agg of shown.filter((e) => e.kind === 'aggregate')) {
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

function soleOwner(owners: Set<string> | undefined, ctx: string): string | undefined {
    if (!owners || owners.size !== 1) return undefined;
    const [owner] = owners;
    return owner.startsWith(`${ctx}.`) ? owner : undefined;
}

/** State View of one aggregate: states as nodes, commands as transitions; factories start from an initial node. */
export function buildStateGraph(agg: ElementModel, model: DomainModel): Graph {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const states = agg.states ?? [];
    const commands = agg.commands ?? [];
    const stateful = states.length > 0;

    if (commands.some((c) => c.factory)) {
        nodes.push({ id: initialNodeId(agg.id), kind: 'initial', label: sameText('new'), lines: [], elementId: agg.id, width: 64, height: 64 });
    }
    if (stateful) {
        for (const s of states) {
            nodes.push(
                sized({
                    id: s.id,
                    kind: 'state',
                    label: named(s.name, s.label),
                    stereotype: '«state»',
                    lines: [
                        ...s.fields.map((f) => fieldLine(f, agg.context, model)),
                        ...s.invariants.map((i) => ({ key: named(`✓ ${i.name}`, i.label && `✓ ${i.label}`, (l, n) => `${l} (${n.slice(2)})`) })),
                    ],
                    elementId: s.id,
                }),
            );
        }
    } else {
        nodes.push(sized({ id: agg.id, kind: 'state', label: named(agg.name, agg.label), stereotype: '«no states»', lines: [], elementId: agg.id }));
    }

    const stateNode = (name: string): string | undefined => (stateful ? states.find((s) => s.name === name)?.id : agg.id);
    for (const c of commands) {
        const sources = c.factory ? [initialNodeId(agg.id)] : stateful ? c.from.map(stateNode) : [agg.id];
        const targets = stateful ? c.to.map(stateNode) : [agg.id];
        for (const source of sources) {
            for (const target of targets) {
                if (!source || !target) continue; // unresolved state, reported as M006
                edges.push({ id: `${c.id}|${source}->${target}`, kind: 'transition', source, target, label: commandLabel(c, model) });
            }
        }
    }
    return { id: stateGraphId(agg.id), nodes, edges };
}

function commandLabel(c: CommandModel, model: DomainModel): Texts {
    const short = (q: string): string => q.slice(q.lastIndexOf('.') + 1);
    const emitsEn = c.emits.length ? ` ⇒ ${c.emits.map(short).join(', ')}` : '';
    const emitsJa = c.emits.length ? ` ⇒ ${c.emits.map((e) => lookupLabel(model, e) ?? short(e)).join(', ')}` : '';
    const signature = `${c.name}(${c.params.map((p) => p.name).join(', ')})`;
    return {
        en: `${signature}${emitsEn}`,
        ja: `${c.label ?? signature}${emitsJa}`,
        both: `${c.label ? `${c.label} ` : ''}${signature}${emitsEn}`,
    };
}
