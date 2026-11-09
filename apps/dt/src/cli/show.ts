import {
    type AggregateModel,
    type CommandModel,
    commandsOf,
    commandsWithOutcome,
    contextNames,
    contextOf,
    type DomainModel,
    type ElementKind,
    type ElementModel,
    elementOf,
    elementsIn,
    emitApplies,
    type EmitModel,
    type FieldModel,
    fieldSetsOf,
    fieldsOf,
    fieldSetUsers,
    fieldUses,
    fieldUseText,
    identityOf,
    type InvariantModel,
    invariantsOf,
    outcomeFields,
    outcomePatternText,
    policiesReactingTo,
    policiesRunning,
    type PolicyElement,
    statesOf,
    type StateModel,
    type TermModel,
    type TypeExpr,
    valuesOf,
    variantsOf,
} from '@domaintrail/modeling';
import { aggregateParamName } from '@domaintrail/generation';
import { type Candidate, closest, didYouMean, type Location } from '@domaintrail/kernel';

/**
 * `dt show`: the resolved model of one element (or a context, a state, a command), from the Typed Model.
 * Names are dotted: `Sales`, `Sales.Order`, `Sales.Order.Confirmed` (a state), `Sales.Order.confirm` (a command); any
 * trailing part of one (`Order`, `Order.confirm`) is accepted when it names one thing only.
 */

export type ShowTarget =
    | { kind: 'context'; name: string }
    | { kind: 'element'; el: ElementModel }
    | { kind: 'state'; agg: AggregateModel; state: StateModel }
    | { kind: 'command'; agg: AggregateModel; command: CommandModel };

export type Lookup = { found: ShowTarget } | { ambiguous: string[] } | { unknown: true; suggestions: string[]; hint?: string };

/** Every showable thing by its dotted name, in declaration order. */
function entries(model: DomainModel): { name: string; target: ShowTarget }[] {
    const out: { name: string; target: ShowTarget }[] = contextNames(model).map((name) => ({ name, target: { kind: 'context', name } }));
    for (const el of model.elements) {
        out.push({ name: el.id, target: { kind: 'element', el } });
        if (el.kind !== 'aggregate') continue;
        for (const state of el.states) out.push({ name: `${el.id}.${state.name}`, target: { kind: 'state', agg: el, state } });
        for (const command of el.commands) out.push({ name: `${el.id}.${command.name}`, target: { kind: 'command', agg: el, command } });
    }
    return out;
}

/** Finds `name`: a full dotted name wins, else every entry whose name ends with it (by whole parts). */
export function lookup(model: DomainModel, name: string): Lookup {
    const all = entries(model);
    const exact = all.filter((e) => e.name === name);
    const matches = exact.length ? exact : all.filter((e) => e.name.endsWith(`.${name}`));
    if (matches.length === 1) return { found: matches[0].target };
    if (matches.length > 1) return { ambiguous: matches.map((e) => e.name) };
    // compared with every trailing part, so that `Ordr` suggests `Sales.Order`
    const candidates: Candidate[] = all.flatMap((e) => {
        const parts = e.name.split('.');
        return parts.map((_, i) => ({ name: e.name, key: parts.slice(i).join('.') }));
    });
    return { unknown: true, suggestions: closest(name, candidates), hint: didYouMean(name, candidates) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Resolved views shared by the text and the JSON output

/** One outcome of a command: from a source state to a target state (none for a factory / an aggregate without states). */
export interface Outcome {
    from?: string;
    to?: string;
    /** The events emitted for this outcome (`when` resolved), with their multiplicity. */
    emits: { event: string; multiplicity: string; lower: number; upper?: number }[];
    /** Field names the decision gives, takes over unchanged, and drops (see `outcomeFields`). */
    sets: string[];
    carries: string[];
    drops: string[];
}

export function outcomesOf(agg: AggregateModel, c: CommandModel): Outcome[] {
    const pairs: [string | undefined, string | undefined][] = [];
    for (const t of c.transitions) {
        for (const from of t.from.length ? t.from : [undefined]) {
            for (const to of t.to) if (!pairs.some(([f, g]) => f === from && g === to)) pairs.push([from, to]);
        }
    }
    if (!pairs.length) pairs.push([undefined, undefined]);
    return pairs.map(([from, to]) => {
        const fields = outcomeFields(agg, c, from, to);
        return {
            ...(from !== undefined && { from }),
            ...(to !== undefined && { to }),
            emits: c.emits
                .filter((e) => emitApplies(e, from, to))
                .map(({ event, multiplicity, lower, upper }: EmitModel) => ({ event, multiplicity, lower, ...(upper !== undefined && { upper }) })),
            sets: fields.set.map((f) => f.name),
            carries: fields.carried.map((f) => f.name),
            drops: fields.dropped.map((f) => f.name),
        };
    });
}

/** Who uses an element, as dotted paths: `Sales.Order.items`, `Sales.Order.Cancelled.reason`, `Sales.Order.addItem(item)`. */
export interface UsedBy {
    /** Elements that take on the field set (`with`). */
    takenOnBy: string[];
    /** Fields that own it (`owns`). */
    ownedBy: string[];
    /** Other fields and parameters of its type. */
    typeOf: string[];
    /** `references` fields that point to the aggregate. */
    referencedBy: string[];
    /** Other fields and parameters of the aggregate's or entity's ID type. */
    idUsedBy: string[];
    /** Commands that emit the event / return the error; an error also by the verified types whose factory returns it. */
    emittedBy: string[];
    returnedBy: string[];
    /** Verified types that verify a value of it (`of`). */
    verifiedAs: string[];
    /** Verified types whose check needs it (`for`). */
    contextOf: string[];
    /** Unions whose discriminator is bound to the enum. */
    discriminatorOf: string[];
    /** Policies that react to the event. */
    reactedToBy: string[];
}

export function usedBy(model: DomainModel, el: ElementModel): UsedBy {
    const path = (u: ReturnType<typeof fieldUses>[number]): string => `${u.context}.${fieldUseText(u, (x) => x.name)}`;
    const uses = fieldUses(model, el.id);
    const identity = el.kind === 'aggregate' || el.kind === 'entity' ? identityOf(el) : undefined;
    const idUses = identity ? fieldUses(model, identity).filter((u) => u.target !== el.id) : [];
    // a qualified name names the element whose stable ID is the same text
    const isEl = (qname: string | undefined): boolean => qname === el.id;
    const references = (u: (typeof idUses)[number]): boolean => u.field.kind === 'references' && isEl(u.field.target);
    const commands = commandsWithOutcome(model, el.id);
    const verifiedTypes = model.elements.filter((v) => v.kind === 'verified');
    const isRef = (t: TypeExpr, id: string): boolean => t.kind === 'ref' && t.ref === id;
    return {
        takenOnBy: el.kind === 'fieldSet' ? fieldSetUsers(model, el.id).map((e) => e.id) : [],
        ownedBy: uses.filter((u) => u.field.kind === 'owns').map(path),
        typeOf: uses.filter((u) => u.field.kind !== 'owns').map(path),
        referencedBy: idUses.filter(references).map(path),
        idUsedBy: idUses.filter((u) => !references(u)).map(path),
        emittedBy: commands.filter(({ command }) => command.emits.some((e) => isEl(e.event))).map(({ command }) => dotted(command.id)),
        returnedBy: [
            ...commands.filter(({ command }) => command.errors.some(isEl)).map(({ command }) => dotted(command.id)),
            ...verifiedTypes.filter((v) => v.verified.errors.some(isEl)).map((v) => v.id),
        ],
        verifiedAs: verifiedTypes.filter((v) => isRef(v.verified.of, el.id)).map((v) => v.id),
        contextOf: verifiedTypes.filter((v) => v.verified.for && isRef(v.verified.for.type, el.id)).map((v) => v.id),
        discriminatorOf: model.elements.filter((u) => u.kind === 'union' && isEl(u.tagType)).map((u) => u.id),
        reactedToBy: el.kind === 'event' ? policiesReactingTo(model, el.id).map((p) => p.id) : [],
    };
}

/** `Sales.Order:confirm` / `Sales.Order#Draft` → `Sales.Order.confirm` / `Sales.Order.Draft`. */
const dotted = (id: string): string => id.replace(/[#:]/g, '.');

// ---------------------------------------------------------------------------------------------------------------------
// JSON

export interface ContextSummary {
    name: string;
    label?: string;
    doc?: string;
    shared: boolean;
    terms: readonly TermModel[];
    elements: { id: string; kind: ElementKind; name: string; label?: string; location: Location }[];
}

/** What `dt show --format json` prints (besides `{"error": …}`), keyed by `show`. */
export type ShowJson =
    | { show: 'overview'; contexts: ContextSummary[] }
    | { show: 'context'; context: ContextSummary }
    | { show: 'element'; element: ElementJson; usedBy: UsedBy }
    | { show: 'state'; aggregate: string; state: StateModel; enteredBy: Move[]; leftBy: Move[] }
    | { show: 'command'; aggregate: string; command: CommandJson };

/** A command with its outcomes, and the policies that run it (`triggeredBy`, their IDs). */
export type CommandJson = Omit<CommandModel, 'outcomes'> & { outcomes: Outcome[]; namedOutcomes: CommandModel['outcomes']; triggeredBy: string[] };
/** An element; an aggregate with its commands as `CommandJson`. */
export type ElementJson = Exclude<ElementModel, AggregateModel> | (Omit<AggregateModel, 'commands'> & { commands: CommandJson[] });

/** A command's outcome that enters or leaves a state. */
export interface Move {
    command: string;
    from?: string;
    to?: string;
}

function contextSummary(model: DomainModel, name: string): ContextSummary {
    const context = contextOf(model, name);
    return {
        name,
        ...(context?.label && { label: context.label }),
        ...(context?.doc && { doc: context.doc }),
        shared: context?.shared ?? false,
        terms: context?.terms ?? [],
        elements: elementsIn(model, name).map((e) => ({ id: e.id, kind: e.kind, name: e.name, ...(e.label && { label: e.label }), location: e.location })),
    };
}

const commandJson = (model: DomainModel, agg: AggregateModel, c: CommandModel): CommandJson => ({
    ...c,
    outcomes: outcomesOf(agg, c),
    namedOutcomes: c.outcomes,
    triggeredBy: policiesRunning(model, agg.id, c.name).map((p) => p.id),
});

function moves(agg: AggregateModel, state: string): { enteredBy: Move[]; leftBy: Move[] } {
    const all = agg.commands.flatMap((c) => outcomesOf(agg, c).map((o) => ({ command: c.name, ...(o.from && { from: o.from }), ...(o.to && { to: o.to }) })));
    return { enteredBy: all.filter((m) => m.to === state), leftBy: all.filter((m) => m.from === state) };
}

/**
 * The JSON of `dt show`. Invariants and requirements keep their `source`; the expression trees of the Typed Model
 * (`expr`, read by the generator) are left out.
 */
export function showJson(model: DomainModel, target: ShowTarget | undefined): ShowJson {
    return JSON.parse(JSON.stringify(showJsonOf(model, target), (key, value) => (key === 'expr' ? undefined : value)));
}

function showJsonOf(model: DomainModel, target: ShowTarget | undefined): ShowJson {
    if (!target) return { show: 'overview', contexts: contextNames(model).map((c) => contextSummary(model, c)) };
    switch (target.kind) {
        case 'context':
            return { show: 'context', context: contextSummary(model, target.name) };
        case 'element': {
            const el = target.el;
            let element: ElementJson;
            if (el.kind === 'aggregate') {
                const { commands, ...rest } = el;
                element = { ...rest, commands: commands.map((c) => commandJson(model, el, c)) };
            } else element = el;
            return { show: 'element', element, usedBy: usedBy(model, target.el) };
        }
        case 'state':
            return { show: 'state', aggregate: target.agg.id, state: target.state, ...moves(target.agg, target.state.name) };
        case 'command':
            return { show: 'command', aggregate: target.agg.id, command: commandJson(model, target.agg, target.command) };
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Text

const KEYWORDS: Record<ElementKind, string> = {
    id: 'id',
    primitive: 'primitive',
    verified: 'verified',
    enum: 'enum',
    valueObject: 'value',
    union: 'union',
    entity: 'entity',
    aggregate: 'aggregate',
    event: 'event',
    error: 'error',
    fieldSet: 'fields',
    policy: 'policy',
};

const KIND_ORDER: ElementKind[] = [
    'aggregate',
    'entity',
    'valueObject',
    'union',
    'primitive',
    'verified',
    'id',
    'enum',
    'fieldSet',
    'event',
    'error',
    'policy',
];

/** A qualified name as written from `ctx`: without the context when it is `ctx`. */
const nameFrom = (ctx: string, qname: string): string => (qname.startsWith(`${ctx}.`) ? qname.slice(ctx.length + 1) : qname);

const quoted = (label: string | undefined): string => (label ? ` "${label}"` : '');
const at = (loc: Location): string => `  // ${loc.file}:${loc.line}`;
const docLines = (doc: string | undefined, indent: string): string[] => (doc ? doc.split('\n').map((l) => `${indent}/// ${l}`) : []);

function typeText(f: FieldModel, ctx: string): string {
    return typeExprText(f.type, ctx);
}

function typeExprText(t: TypeExpr, ctx: string): string {
    if (t.kind === 'primitive') return t.name;
    return t.target ? nameFrom(ctx, t.ref) : `${t.text} (unresolved)`;
}

/** ` of EmailAddress for CustomerId? errors EmailTaken` of a verified type. */
function verifiedText(el: ElementModel): string {
    if (el.kind !== 'verified') return '';
    const v = el.verified;
    const ctx = el.context;
    return [
        ` of ${typeExprText(v.of, ctx)}`,
        v.for ? ` for ${typeExprText(v.for.type, ctx)}${v.for.optional ? '?' : ''}` : '',
        v.errors.length ? ` errors ${v.errors.map((e) => nameFrom(ctx, e)).join(', ')}` : '',
    ].join('');
}

/** `owns items: OrderItem[0..*] "明細"`, with where an inherited label comes from. */
function fieldText(f: FieldModel, ctx: string): string {
    const prefix = f.kind === 'owns' || f.kind === 'references' ? `${f.kind} ` : '';
    const target = f.kind === 'references' && f.target ? ` -> ${nameFrom(ctx, f.target)}` : '';
    const source = f.label && f.labelSource && f.labelSource !== 'inline' ? ` (from ${f.labelSource})` : '';
    return `${prefix}${f.name}: ${typeText(f, ctx)}${f.multiplicity}${target}${quoted(f.label)}${source}`;
}

function fieldLines(fields: readonly FieldModel[], ctx: string, indent: string): string[] {
    return fields.flatMap((f) => [...docLines(f.doc, indent), `${indent}${fieldText(f, ctx)}${f.fieldSet ? `  // with ${nameFrom(ctx, f.fieldSet)}` : ''}`]);
}

function invariantLines(invs: readonly InvariantModel[], indent: string): string[] {
    return invs.flatMap((i) => [
        ...docLines(i.doc, indent),
        `${indent}invariant ${i.name}${quoted(i.label)} ${i.source ? `{ ${i.source} }` : '(not expressed in the DSL)'}`,
    ]);
}

/** One line per element: `aggregate Order "注文"  // sales/order.dt:12`, with its base, values or states. */
function elementLine(el: ElementModel, indent: string): string {
    const detail =
        el.kind === 'id' || el.kind === 'primitive'
            ? `: ${el.base}`
            : el.kind === 'enum'
              ? ` { ${el.values.map((v) => v.name).join(' ')} }`
              : statesOf(el).length
                ? ` (states ${statesOf(el)
                      .map((s) => s.name)
                      .join(', ')})`
                : el.kind === 'policy'
                  ? ` ${reactionText(el)}`
                  : verifiedText(el);
    return `${indent}${el.kind === 'event' && el.persistent ? 'persistent ' : ''}${KEYWORDS[el.kind]} ${el.name}${quoted(el.label)}${detail}${at(el.location)}`;
}

function contextHeader(model: DomainModel, name: string): string {
    const context = contextOf(model, name);
    return `${context?.shared ? 'shared ' : ''}context ${name}${quoted(context?.label)}`;
}

function overviewText(model: DomainModel): string[] {
    return contextNames(model).flatMap((ctx) => {
        const els = elementsIn(model, ctx);
        const groups = KIND_ORDER.map((k) => [k, els.filter((e) => e.kind === k)] as const).filter(([, es]) => es.length);
        return [contextHeader(model, ctx), ...groups.map(([k, es]) => `  ${KEYWORDS[k]} ${es.map((e) => e.name).join(', ')}`)];
    });
}

function contextText(model: DomainModel, ctx: string): string[] {
    const context = contextOf(model, ctx);
    const terms = context?.terms ?? [];
    return [
        contextHeader(model, ctx),
        ...docLines(context?.doc, '  '),
        ...(terms.length ? [`  terms ${terms.map((t) => `${t.name}${quoted(t.label)}`).join(', ')}`] : []),
        ...elementsIn(model, ctx).map((e) => elementLine(e, '  ')),
    ];
}

/** `when Sales.OrderConfirmed -> Invoice.issue`, the event as written from the policy's context. */
const reactionText = (p: PolicyElement): string =>
    `when ${nameFrom(p.context, p.policy.event)} -> ${nameFrom(p.context, p.policy.aggregate)}.${p.policy.command}`;

/** `place(id: OrderId, customer: CustomerId)` with the parameters' labels. */
const signature = (c: CommandModel, ctx: string): string => `${c.name}(${c.params.map((p) => fieldText(p, ctx)).join(', ')})`;

const outcomeName = (o: { from?: string; to?: string }): string => (o.to === undefined ? 'always' : `${o.from ?? ''} -> ${o.to}`.trim());

const emitsText = (o: Outcome, ctx: string): string =>
    o.emits.length ? `emits ${o.emits.map((e) => `${nameFrom(ctx, e.event)}${e.multiplicity}`).join(', ')}` : 'emits nothing';

/**
 * A command as in the DSL, then what it resolves to: the events per outcome (when `when` makes them differ, or always
 * with `detail`), and the full error union. With `detail`, also the fields each outcome sets, carries over and drops,
 * and the payload of the events and errors.
 */
function commandLines(model: DomainModel, agg: AggregateModel, c: CommandModel, indent: string, detail: boolean): string[] {
    const ctx = agg.context;
    const i2 = `${indent}  `;
    const lines = [...docLines(c.doc, indent), `${indent}${c.factory ? 'create ' : ''}command ${signature(c, ctx)}${quoted(c.label)}${at(c.location)}`];
    for (const p of policiesRunning(model, agg.id, c.name))
        lines.push(`${i2}// triggered by policy ${nameFrom(ctx, p.id)}${quoted(p.label)} when ${nameFrom(ctx, p.policy.event)}`.trimEnd());
    for (const t of c.transitions) lines.push(`${i2}${[t.from.join(' | '), '->', t.to.join(' | ')].filter(Boolean).join(' ')}`);
    for (const r of c.requires) {
        lines.push(
            ...docLines(r.doc, i2),
            `${i2}requires ${r.name}${quoted(r.label)} ${r.source ? `{ ${r.source} }` : '(not expressed in the DSL)'} else ${nameFrom(ctx, r.error)}`,
        );
    }
    if (c.changes.length) lines.push(`${i2}changes ${c.changes.join(', ')}`);
    if (c.emits.length)
        lines.push(
            `${i2}emits ${c.emits.map((e) => `${nameFrom(ctx, e.event)}${e.multiplicity}${e.when ? ` when ${outcomePatternText(e.when)}` : ''}`).join(', ')}`,
        );
    const outcomes = outcomesOf(agg, c);
    if (detail || c.emits.some((e) => e.when)) {
        lines.push(`${i2}outcomes`);
        for (const o of outcomes) {
            lines.push(`${i2}  ${outcomeName(o)}: ${emitsText(o, ctx)}`);
            if (detail) {
                const parts = [
                    `sets ${o.sets.join(', ') || '-'}`,
                    `carries ${o.carries.join(', ') || '-'}`,
                    ...(o.drops.length ? [`drops ${o.drops.join(', ')}`] : []),
                ];
                lines.push(`${i2}    ${parts.join('; ')}`);
            }
        }
    }
    if (!detail) {
        if (c.errors.length) lines.push(`${i2}errors ${c.errors.map((e) => nameFrom(ctx, e)).join(', ')}`);
        return lines;
    }
    const payload = (id: string): string => {
        const el = elementOf(model, id);
        if (!el) return `${nameFrom(ctx, id)} (unresolved)`;
        const fields = fieldsOf(el)
            .map((f) => fieldText(f, el.context))
            .join(', ');
        return `${nameFrom(ctx, id)}${quoted(el.label)}${fields ? ` { ${fields} }` : ''}${at(el.location)}`;
    };
    const events = [...new Set(c.emits.map((e) => e.event))];
    if (events.length) lines.push(`${i2}events`, ...events.map((e) => `${i2}  ${payload(e)}`));
    lines.push(c.errors.length ? `${i2}errors` : `${i2}errors none`, ...c.errors.map((e) => `${i2}  ${payload(e)}`));
    return lines;
}

function stateLines(s: StateModel, ctx: string, indent: string): string[] {
    return [
        ...docLines(s.doc, indent),
        `${indent}state ${s.name}${quoted(s.label)}${at(s.location)}`,
        ...fieldLines(s.fields, ctx, `${indent}  `),
        ...invariantLines(s.invariants, `${indent}  `),
    ];
}

const USED_BY: [keyof UsedBy, string][] = [
    ['takenOnBy', 'taken on by (with)'],
    ['ownedBy', 'owned by'],
    ['typeOf', 'type of'],
    ['referencedBy', 'referenced by'],
    ['idUsedBy', 'ID used by'],
    ['emittedBy', 'emitted by'],
    ['returnedBy', 'returned by'],
    ['verifiedAs', 'verified as'],
    ['contextOf', 'context of'],
    ['discriminatorOf', 'discriminator of'],
    ['reactedToBy', 'reacted to by (policy)'],
];

function usedByLines(model: DomainModel, el: ElementModel): string[] {
    const u = usedBy(model, el);
    const lines = USED_BY.filter(([k]) => u[k].length).map(([k, title]) => `  ${title}: ${u[k].join(', ')}`);
    return lines.length ? ['used by', ...lines] : ['used by: nothing'];
}

/**
 * A policy: its reaction, the event with its payload, and the command it runs, with what the application gives it (the
 * generated `…Input`: the parameters, and for a command that is not a factory the aggregate's ID).
 */
function policyText(model: DomainModel, el: PolicyElement): string[] {
    const p = el.policy;
    const ctx = el.context;
    const lines = [...docLines(el.doc, ''), `policy ${el.id}${quoted(el.label)} ${reactionText(el)}${at(el.location)}`];
    const event = elementOf(model, p.event);
    const fields =
        event &&
        fieldsOf(event)
            .map((f) => fieldText(f, event.context))
            .join(', ');
    lines.push(
        event
            ? `  event ${nameFrom(ctx, event.id)}${quoted(event.label)}${fields ? ` { ${fields} }` : ''}${at(event.location)}`
            : `  event ${p.event} (unresolved)`,
    );
    const agg = elementOf(model, p.aggregate);
    const c = agg && commandsOf(agg).find((x) => x.name === p.command);
    if (!agg || !c) return [...lines, `  command ${nameFrom(ctx, p.aggregate)}.${p.command} (unresolved)`];
    const id = fieldsOf(agg).find((f) => f.name === 'id');
    const input = [
        ...(c.factory || !id ? [] : [`${aggregateParamName(agg)}: ${typeText(id, ctx)}`]),
        ...c.params.map((f) => `${f.name}: ${typeText(f, ctx)}${f.multiplicity}`),
    ];
    lines.push(`  ${c.factory ? 'create ' : ''}command ${nameFrom(ctx, agg.id)}.${signature(c, ctx)}${quoted(c.label)}${at(c.location)}`);
    lines.push(`  input { ${input.join(', ')} }  // what the application needs to run it, eventually (any mechanism)`);
    return lines;
}

function elementText(model: DomainModel, el: ElementModel): string[] {
    if (el.kind === 'policy') return policyText(model, el);
    const ctx = el.context;
    const head = [
        el.kind === 'event' && el.persistent ? 'persistent ' : '',
        `${KEYWORDS[el.kind]} ${el.id}${quoted(el.label)}`,
        el.kind === 'id' || el.kind === 'primitive' ? `: ${el.base}` : '',
        verifiedText(el),
        el.kind === 'union' ? ` by ${el.discriminator}${el.tagType ? `: ${nameFrom(ctx, el.tagType)}` : ''}` : '',
        fieldSetsOf(el).length
            ? ` with ${fieldSetsOf(el)
                  .map((f) => nameFrom(ctx, f))
                  .join(', ')}`
            : '',
    ].join('');
    const lines = [...docLines(el.doc, ''), `${head}${at(el.location)}`];
    for (const v of valuesOf(el)) lines.push(`  ${v.name}${quoted(v.label)}`);
    lines.push(...fieldLines(fieldsOf(el), ctx, '  '), ...invariantLines(invariantsOf(el), '  '));
    for (const v of variantsOf(el)) {
        lines.push(...docLines(v.doc, '  '), `  ${v.name}${quoted(v.label)}`, ...fieldLines(v.fields, ctx, '    '), ...invariantLines(v.invariants, '    '));
    }
    if (el.kind === 'aggregate' && el.states.length) lines.push('', ...el.states.flatMap((s) => stateLines(s, ctx, '  ')));
    if (el.kind === 'aggregate' && el.commands.length) lines.push('', ...el.commands.flatMap((c) => commandLines(model, el, c, '  ', false)));
    lines.push('', ...usedByLines(model, el));
    return lines;
}

function stateText(agg: AggregateModel, s: StateModel): string[] {
    const { enteredBy, leftBy } = moves(agg, s.name);
    const list = (ms: Move[]): string => ms.map((m) => `${m.command} (${outcomeName(m)})`).join(', ') || 'none';
    return [
        ...docLines(s.doc, ''),
        `state ${agg.id}.${s.name}${quoted(s.label)}${at(s.location)}`,
        ...fieldLines(s.fields, agg.context, '  '),
        ...invariantLines(s.invariants, '  '),
        `  common fields of ${agg.name}: ${agg.fields.map((f) => f.name).join(', ') || 'none'}`,
        `  entered by: ${list(enteredBy)}`,
        `  left by: ${list(leftBy)}`,
    ];
}

/** The text of `dt show`: compact, close to the DSL, with names, labels, field sets and outcomes resolved. */
export function showText(model: DomainModel, target: ShowTarget | undefined): string[] {
    if (!target) return overviewText(model);
    switch (target.kind) {
        case 'context':
            return contextText(model, target.name);
        case 'element':
            return elementText(model, target.el);
        case 'state':
            return stateText(target.agg, target.state);
        case 'command': {
            const [first, ...rest] = commandLines(model, target.agg, target.command, '', true).slice(docLines(target.command.doc, '').length);
            const qualified = first.replace(/^(create )?command /, `$1command ${target.agg.id}.`);
            return [...docLines(target.command.doc, ''), qualified, ...rest];
        }
    }
}
