import type { CommandModel, DomainModel, ElementModel, FieldModel, TypeExpr, VariantModel } from '../model/model.js';
import { contextDependencies, representative, supportingContexts } from '../model/dependencies.js';
import { allFieldsOf, elementList } from '../model/model.js';
import {
    CHAR_WIDTH,
    CONTAINER_PADDING,
    HEADER_HEIGHT,
    LINE_HEIGHT,
    TEXT_VARIANTS,
    anyLang,
    mapTexts,
    maxUnits,
    perLang,
    sameText,
    textUnits,
    type Lang,
    type Graph,
    type GraphEdge,
    type GraphLine,
    type GraphNode,
    type StructureLevel,
    type Texts,
    type TransitionLabels,
    TRANSITION_SUB_SIZE,
    compartmentHeight,
    transitionText,
    OVERVIEW_TEXT_SCALE,
} from './ir.js';

export const STRUCTURE_GRAPH_ID = 'structure';
export const stateGraphId = (aggregateId: string): string => `states:${aggregateId}`;
export const boundaryId = (aggregateId: string): string => `${aggregateId}@boundary`;
export const initialNodeId = (aggregateId: string): string => `${aggregateId}@new`;

/** `«…»` captions in every language. */
const stereotype = (ja: string, en: string): Texts => perLang({ ja: `«${ja}»`, en: `«${en}»` });

const STEREOTYPES: Partial<Record<ElementModel['kind'], Texts>> = {
    aggregate: stereotype('集約ルート', 'aggregate root'),
    entity: stereotype('エンティティ', 'entity'),
    valueObject: stereotype('値オブジェクト', 'value object'),
    union: stereotype('ユニオン', 'union'),
};

/** Indent of variant fields under their variant row (no-break spaces, which HTML does not collapse). */
export const VARIANT_INDENT = '\u00a0\u00a0';

/** Element kinds drawn as nodes in the Structure View. */
const STRUCTURE_KINDS = new Set<ElementModel['kind']>(['aggregate', 'entity', 'valueObject', 'union']);
/** Value types and entities: what a field can hold inside an aggregate. */
const HELD_KINDS = new Set<ElementModel['kind']>(['entity', 'valueObject', 'union']);

/** Type name as written in `ctx`: own and shared-context types by simple name, others qualified. */
/** Labels of built-in types, shown in the ラベル display mode. */
export const PRIMITIVE_LABELS: Record<string, string> = {
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

/** The Live View's own words in the diagrams. */
const WORDS: Record<Lang, { shared: string; aggregate: string; state: string; more: (n: number) => string }> = {
    ja: { shared: '共有', aggregate: '集約', state: '状態', more: (n) => `他${n}` },
    en: { shared: 'shared', aggregate: 'aggregate', state: 'state', more: (n) => `+${n}` },
};

/** `name` / `label` / `label name` depending on the display mode (label falls back to the name). */
export function named(name: string, label: string | undefined, both = (l: string, n: string) => `${l} (${n})`, suffix = ''): Texts {
    return anyLang({ name: name + suffix, label: (label ?? name) + suffix, both: (label ? both(label, name) : name) + suffix });
}

const lookupLabel = (model: DomainModel, qname: string): string | undefined => model.elements[qname]?.label;

/** A field row in every display mode: key `◆ 明細` / `◆ items`, value `注文明細[0..*]` / `OrderItem[0..*]`. */
export function fieldLine(f: FieldModel, ctx: string, model: DomainModel, indent = ''): GraphLine {
    const marker = indent + (f.kind === 'owns' ? '◆ ' : f.kind === 'references' ? '→ ' : '');
    const byName = typeText(f.type, ctx, model.sharedContexts);
    const byLabel = f.type.kind === 'ref' ? (lookupLabel(model, f.type.ref) ?? byName) : PRIMITIVE_LABELS[f.type.name];
    return {
        key: anyLang({
            name: `${marker}${f.name}`,
            label: `${marker}${f.label ?? f.name}`,
            both: `${marker}${f.label ? `${f.label} ` : ''}${f.name}`,
        }),
        value: anyLang({ name: byName + f.multiplicity, label: byLabel + f.multiplicity, both: byName + f.multiplicity }),
    };
}

/** Space between the key and value columns, in characters. */
const COLUMN_GAP = 2;

/** Widest body row in any display mode, with keys and values aligned in two columns. */
function bodyUnits(lines: GraphLine[]): number {
    return Math.max(
        0,
        ...TEXT_VARIANTS.map(([g, m]) => {
            const key = Math.max(0, ...lines.filter((l) => l.value).map((l) => textUnits(l.key[g][m])));
            const value = Math.max(0, ...lines.map((l) => (l.value ? textUnits(l.value[g][m]) : 0)));
            const keyOnly = Math.max(0, ...lines.filter((l) => !l.value).map((l) => textUnits(l.key[g][m])));
            return Math.max(value ? key + COLUMN_GAP + value : 0, keyOnly);
        }),
    );
}

export function sized(n: Omit<GraphNode, 'width' | 'height'>, scale = 1): GraphNode {
    // the body rows keep their size in larger text
    const head = Math.max(maxUnits(n.label) + 2, n.stereotype ? maxUnits(n.stereotype) : 0) * scale;
    return {
        ...n,
        width: Math.max(170 * scale, Math.ceil(Math.max(head, bodyUnits(n.lines)) * CHAR_WIDTH + 28)),
        height: Math.ceil(HEADER_HEIGHT * scale) + n.lines.length * LINE_HEIGHT + (n.lines.length ? 10 : 0),
    };
}

/**
 * Structure View: contexts contain aggregate boundaries; an aggregate boundary contains the root
 * and every entity / value object owned exclusively by that aggregate. Shared value objects and
 * unowned entities are placed directly in their context.
 */
export const STRUCTURE_OVERVIEW_GRAPH_ID = 'structure-overview';
export const STRUCTURE_AGGREGATES_GRAPH_ID = 'structure-aggregates';
const LEVEL_GRAPH_IDS: Record<StructureLevel, string> = {
    detail: STRUCTURE_GRAPH_ID,
    overview: STRUCTURE_OVERVIEW_GRAPH_ID,
    aggregates: STRUCTURE_AGGREGATES_GRAPH_ID,
};

/**
 * Structure View of some bounded contexts, with the elements they depend on and that depend on them as stubs
 * (except those of the `hidden` contexts).
 */
export const focusGraphId = (contexts: readonly string[], level: StructureLevel = 'detail', hidden: readonly string[] = []): string =>
    `structure-focus:${[...contexts].sort().join('+')}${hidden.length ? `:hide=${[...hidden].sort().join('+')}` : ''}${level === 'detail' ? '' : `:${level}`}`;

export interface StructureOptions {
    level?: StructureLevel;
    focus?: readonly string[];
    hidden?: readonly string[];
}

/**
 * Structure View. At the `overview` level, nodes show only their names (no field rows) in larger text,
 * to see the whole model at a glance; at the `aggregates` level, only the aggregates are drawn (see
 * `buildAggregatesGraph`). With `focus`, only those contexts are drawn (see `focusStubs`), and
 * the dependencies on and from the `hidden` contexts are left out.
 */
export function buildStructureGraph(model: DomainModel, opts: StructureOptions = {}): Graph {
    const level = opts.level ?? 'detail';
    if (level === 'aggregates') return buildAggregatesGraph(model, opts);
    const overview = level === 'overview';
    const scale = overview ? OVERVIEW_TEXT_SCALE : 1;
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
        const label = shared ? mapTexts(base, (s, lang) => `${s} · ${WORDS[lang].shared}`) : base;
        nodes.push({ id: ctx, kind: shared ? 'sharedContext' : 'context', label, lines: [], elementId: ctx, width: 0, height: 0 });
    }

    for (const el of shown) {
        if (el.kind === 'aggregate') {
            nodes.push({
                id: boundaryId(el.id),
                kind: 'aggregateBoundary',
                label: mapTexts(named(el.name, el.label), (s, lang) => `${s} ${WORDS[lang].aggregate}`),
                lines: [],
                parent: el.context,
                elementId: el.id,
                width: 0,
                height: 0,
            });
        }
        const owner = el.kind === 'aggregate' ? el.id : soleOwner(owners.get(el.id), el.context);
        const lines = overview ? [] : el.fields.map((f) => fieldLine(f, el.context, model));
        if (!overview && el.kind === 'union') {
            // One row per variant (the discriminator value), followed by its fields.
            for (const v of el.variants ?? []) {
                lines.push({ key: named(`${el.discriminator}: ${v.name}`, v.label && `${v.label}`, (l, n) => `${l} (${n})`) });
                lines.push(...v.fields.map((f) => fieldLine(f, el.context, model, VARIANT_INDENT)));
            }
        }
        if (!overview && el.kind === 'aggregate' && el.states?.length) {
            const byName = el.states.map((s) => s.name).join(' | ');
            const byLabel = el.states.map((s) => s.label ?? s.name).join(' | ');
            lines.push({ key: perLang({ ja: WORDS.ja.state, en: WORDS.en.state }), value: anyLang({ name: byName, label: byLabel, both: byName }) });
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
    }
    const id = stubs ? focusGraphId(opts.focus!, level, hidden) : LEVEL_GRAPH_IDS[level];
    return overview ? { id, nodes, edges, textScale: scale } : { id, nodes, edges };
}

/** Widest row of a description, in characters, on an aggregate and on a context. */
const AGGREGATE_DOC_WIDTH = 36;
const CONTEXT_DOC_WIDTH = 60;

/**
 * Structure View at the aggregates level, for readers who do not need the details: the aggregates with their
 * descriptions, in larger text, and one edge per pair of aggregates where one depends on the other, also through
 * the elements it holds and through IDs (see `aggregateDependencies`). Shared contexts are left out; a context
 * without aggregates is drawn as an empty frame with its description. With `focus`, the aggregates of other contexts
 * that depend on the focused ones or that they depend on are drawn as stubs, except those of shared, ID-only and
 * `hidden` contexts.
 */
function buildAggregatesGraph(model: DomainModel, opts: StructureOptions): Graph {
    const scale = OVERVIEW_TEXT_SCALE;
    const focus = opts.focus?.length ? new Set(opts.focus) : undefined;
    const hidden = (opts.hidden ?? []).filter((c) => !focus?.has(c));
    const left = new Set(focus ? [...supportingContexts(model), ...hidden] : model.sharedContexts);
    const aggregates = elementList(model).filter((e) => e.kind === 'aggregate' && !left.has(e.context));
    const drawable = new Set(aggregates.map((e) => e.id));
    const shown = aggregates.filter((e) => !focus || focus.has(e.context));
    const shownIds = new Set(shown.map((e) => e.id));
    const deps = aggregateDependencies(model).filter(
        (d) => drawable.has(d.source) && drawable.has(d.target) && (shownIds.has(d.source) || shownIds.has(d.target)),
    );
    const stubs = aggregates.filter((e) => !shownIds.has(e.id) && deps.some((d) => d.source === e.id || d.target === e.id));
    const stubContexts = new Set(stubs.map((e) => e.context));

    const nodes: GraphNode[] = [];
    for (const ctx of model.contexts) {
        if (left.has(ctx) || model.sharedContexts.includes(ctx) || (focus && !focus.has(ctx) && !stubContexts.has(ctx))) continue;
        nodes.push(sizedGroup({ id: ctx, kind: 'context', label: named(ctx, model.contextLabels[ctx]), lines: docLines(model.contextDocs[ctx], CONTEXT_DOC_WIDTH), elementId: ctx }, scale));
    }
    const aggregate = stereotype('集約', 'aggregate');
    for (const el of shown) {
        nodes.push(sized({ id: el.id, kind: 'aggregate', label: named(el.name, el.label), stereotype: aggregate, lines: docLines(el.doc, AGGREGATE_DOC_WIDTH), parent: el.context, elementId: el.id }, scale));
    }
    for (const el of stubs) {
        nodes.push(sized({ id: el.id, kind: 'stub', label: named(el.name, el.label), stereotype: aggregate, lines: [], parent: el.context, elementId: el.id }, scale));
    }
    const edges = deps.map((d): GraphEdge => ({ id: `${d.source}=>${d.target}`, kind: d.type ? 'value' : 'references', source: d.source, target: d.target }));
    return { id: focus ? focusGraphId(opts.focus!, 'aggregates', hidden) : STRUCTURE_AGGREGATES_GRAPH_ID, nodes, edges, textScale: scale };
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

/** A description as body rows of at most `width` characters. */
function docLines(doc: string | undefined, width: number): GraphLine[] {
    return doc ? wrapText(doc, width).map((l) => ({ key: sameText(l) })) : [];
}

/** Punctuation that may not start a line; it hangs at the end of the line before. */
const NO_LINE_START = new Set([...'、。，．,.)）」』】!?！？ー']);

/**
 * Splits a text into lines of at most `width` character units, breaking after a space where there is one
 * (punctuation may go over).
 */
export function wrapText(text: string, width: number): string[] {
    const out: string[] = [];
    for (const paragraph of text.split('\n')) {
        let line = '';
        for (const ch of paragraph) {
            if (textUnits(line + ch) <= width || NO_LINE_START.has(ch)) {
                line += ch;
                continue;
            }
            const space = line.lastIndexOf(' ');
            if (ch !== ' ' && space > 0) {
                out.push(line.slice(0, space));
                line = line.slice(space + 1) + ch;
            } else {
                out.push(line.trimEnd());
                line = ch === ' ' ? '' : ch;
            }
        }
        out.push(line.trimEnd());
    }
    return out.filter((l) => l !== '');
}

/** A context drawn with its description under the label; sized to hold them even when it has no children. */
function sizedGroup(n: Omit<GraphNode, 'width' | 'height'>, scale: number): GraphNode {
    const width = Math.ceil(Math.max(160, maxUnits(n.label) * 10.5 * scale + 40, bodyUnits(n.lines) * CHAR_WIDTH + 40));
    const height = Math.ceil(CONTAINER_PADDING.top * scale) + n.lines.length * LINE_HEIGHT + CONTAINER_PADDING.bottom;
    return { ...n, width, height };
}

const STUB_STEREOTYPES: Record<ElementModel['kind'], Texts> = {
    aggregate: stereotype('集約', 'aggregate'),
    entity: stereotype('エンティティ', 'entity'),
    valueObject: stereotype('値オブジェクト', 'value object'),
    union: stereotype('ユニオン', 'union'),
    enum: stereotype('列挙型', 'enum'),
    primitive: stereotype('ドメインプリミティブ', 'primitive'),
    id: stereotype('ID', 'id'),
    event: stereotype('ドメインイベント', 'event'),
    error: stereotype('エラー', 'error'),
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
            label: perLang({ ja: more > 0 ? `${shown} ${WORDS.ja.more(more)}` : shown, en: more > 0 ? `${shown} ${WORDS.en.more(more)}` : shown }),
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
        return mapTexts(field, (s, lang, mode) => `${v[lang][mode]}.${s}`);
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

/**
 * State View of one aggregate: states as nodes, commands as transitions; factories start from an initial node. A command
 * that leaves a state as it is is listed in the state's box instead of drawn as a loop. Nodes and edge labels are sized
 * for the transition texts `labels`.
 */
export function buildStateGraph(agg: ElementModel, model: DomainModel, labels: TransitionLabels = 'both'): Graph {
    const nodes: Omit<GraphNode, 'width' | 'height'>[] = [];
    const edges: GraphEdge[] = [];
    const states = agg.states ?? [];
    const commands = agg.commands ?? [];
    const stateful = states.length > 0;

    if (stateful) {
        for (const s of states) {
            nodes.push({
                id: s.id,
                kind: 'state',
                label: named(s.name, s.label),
                stereotype: stereotype('状態', 'state'),
                lines: [
                    ...s.fields.map((f) => fieldLine(f, agg.context, model)),
                    ...s.invariants.map((i) => ({ key: named(`✓ ${i.name}`, i.label && `✓ ${i.label}`, (l, n) => `${l} (${n.slice(2)})`) })),
                ],
                elementId: s.id,
            });
        }
    } else {
        nodes.push({ id: agg.id, kind: 'state', label: named(agg.name, agg.label), stereotype: stereotype('状態なし', 'no states'), lines: [], elementId: agg.id });
    }

    const stateNode = (name: string): string | undefined => (stateful ? states.find((s) => s.name === name)?.id : agg.id);
    for (const c of commands) {
        const sources = c.factory ? [initialNodeId(agg.id)] : stateful ? c.from.map(stateNode) : [agg.id];
        const targets = stateful ? c.to.map(stateNode) : [agg.id];
        const label = commandLabel(c);
        const events = eventsLabel(c, model);
        for (const source of sources) {
            for (const target of targets) {
                if (!source || !target) continue; // unresolved state, reported as M006
                const id = `${c.id}|${source}->${target}`;
                const node = source === target ? nodes.find((n) => n.id === source) : undefined;
                if (node) (node.internal ??= []).push({ id, elementId: c.id, label, ...(events && { events }) });
                else edges.push({ id, kind: 'transition', source, target, label, ...(events && { events }) });
            }
        }
    }
    const sizedNodes = nodes.map((n) => sizedState(n, labels));
    if (commands.some((c) => c.factory)) {
        sizedNodes.unshift({ id: initialNodeId(agg.id), kind: 'initial', label: sameText('new'), lines: [], elementId: agg.id, width: 64, height: 64 });
    }
    return { id: stateGraphId(agg.id), nodes: sizedNodes, edges, transitionLabels: labels };
}

/** A state's box, with room for its internal transitions' compartment. */
function sizedState(n: Omit<GraphNode, 'width' | 'height'>, labels: TransitionLabels): GraphNode {
    const node = sized(n);
    if (!n.internal?.length) return node;
    const rows = n.internal.map((t) => {
        const text = transitionText(t.label, t.events, labels);
        return Math.max(maxUnits(text.main) + 2, text.sub ? maxUnits(text.sub) * TRANSITION_SUB_SIZE : 0);
    });
    return {
        ...node,
        width: Math.max(node.width, Math.ceil(Math.max(...rows) * CHAR_WIDTH + 28)),
        height: node.height + compartmentHeight(n, labels),
    };
}

function commandLabel(c: CommandModel): Texts {
    const signature = `${c.name}(${c.params.map((p) => p.name).join(', ')})`;
    return anyLang({ name: signature, label: c.label ?? signature, both: `${c.label ? `${c.label} ` : ''}${signature}` });
}

/** The events a command raises, by name or label (none: undefined). */
function eventsLabel(c: CommandModel, model: DomainModel): Texts | undefined {
    if (!c.emits.length) return undefined;
    const short = (q: string): string => q.slice(q.lastIndexOf('.') + 1);
    const each = c.emits.map((e) => named(short(e), lookupLabel(model, e), (l, n) => `${l} ${n}`));
    return anyLang({ name: each.map((t) => t.en.name).join(', '), label: each.map((t) => t.en.label).join(', '), both: each.map((t) => t.en.both).join(', ') });
}
