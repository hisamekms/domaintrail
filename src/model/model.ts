/**
 * Typed Model: a resolved, serializable view of the domain model.
 * It is the input of the TypeScript generator and of the Graph IR, and is sent to the Live View.
 */

export type PrimitiveName = 'String' | 'Int' | 'Decimal' | 'Bool' | 'Timestamp' | 'UUID';

export type ElementKind = 'id' | 'primitive' | 'enum' | 'valueObject' | 'union' | 'entity' | 'aggregate' | 'event' | 'error' | 'fieldSet';

export type TypeExpr =
    | { kind: 'primitive'; name: PrimitiveName }
    /** `ref` is the qualified name of the target; `target` is undefined when the reference is unresolved. */
    | { kind: 'ref'; ref: string; text: string; target?: ElementKind };

export type Cardinality = 'one' | 'optional' | 'many' | 'nonEmpty';

export interface FieldModel {
    name: string;
    kind: 'field' | 'owns' | 'references' | 'param';
    type: TypeExpr;
    cardinality: Cardinality;
    /** Multiplicity as written in the DSL (`?`, `[0..*]`, ...), empty when omitted. */
    multiplicity: string;
    /** Qualified name of the referenced aggregate (`references` only). */
    target?: string;
    /** Japanese (display) name and where it came from. */
    label?: string;
    labelSource?: 'inline' | 'term' | 'type';
    /** Description from `///` comments (own, or of the term). */
    doc?: string;
    /** Qualified name of the field set the field comes from (`with`); absent for the element's own fields. */
    fieldSet?: string;
}

/** Display name and description shared by declarations. */
export interface Described {
    label?: string;
    doc?: string;
}

export interface InvariantModel extends Described {
    name: string;
    /** The expression as written; absent for an invariant declared without one (not expressed in the DSL). */
    source?: string;
}

export interface Location {
    file: string;
    /** 1-based first line of the declaration. */
    line: number;
    /** 1-based last line of the declaration. */
    endLine: number;
}

export interface StateModel extends Described {
    id: string;
    name: string;
    fields: FieldModel[];
    invariants: InvariantModel[];
    location: Location;
}

/** A variant of a union: its name is the discriminator value. */
export interface VariantModel extends Described {
    name: string;
    fields: FieldModel[];
    invariants: InvariantModel[];
}

/** `requires name "label" { expr } else Error`: the command is accepted only if the requirement holds. */
export interface RequirementModel extends Described {
    name: string;
    /** The expression as written; absent for a requirement declared without one (not expressed in the DSL). */
    source?: string;
    /** Qualified name of the error returned when the requirement does not hold. */
    error: string;
}

/** `A | B -> C | D`: state names within the owning aggregate. `from` is empty for a factory. */
export interface TransitionModel {
    from: string[];
    to: string[];
}

/** `when A | B -> C`: the outcomes an `emits` entry applies to. An empty side matches any state (a factory has no source). */
export interface OutcomePatternModel {
    from: string[];
    to: string[];
}

/**
 * An entry of `emits`: the command emits `event` as often as its multiplicity says (once without one), for the
 * outcomes that match `when` (every outcome without it). On failure it emits nothing.
 */
export interface EmitModel {
    /** Qualified event name. */
    event: string;
    cardinality: Cardinality;
    /** Multiplicity as written in the DSL (`?`, `[1..*]`, ...), empty when omitted. */
    multiplicity: string;
    /** How many times the event is emitted, at least and at most (`undefined`: no upper bound). */
    lower: number;
    upper?: number;
    when?: OutcomePatternModel;
}

export interface CommandModel extends Described {
    id: string;
    name: string;
    factory: boolean;
    params: FieldModel[];
    /** State transitions; a factory has one without source states, an aggregate without states none. */
    transitions: TransitionModel[];
    /** Preconditions over the parameters and the aggregate's current data (`requires`). */
    requires: RequirementModel[];
    /**
     * `changes`: the fields the command may change, as written — common fields, and state-specific fields it would
     * otherwise carry over. Empty: it changes no common field (a factory sets every field).
     */
    changes: string[];
    /** The events emitted on success, per entry of `emits`. */
    emits: EmitModel[];
    /**
     * Qualified error names: those listed in `errors`, then those named by `else` of the requirements, each once.
     * Together they make the command's error union.
     */
    errors: string[];
    location: Location;
}

export interface ElementModel extends Described {
    id: string;
    context: string;
    name: string;
    kind: ElementKind;
    location: Location;
    /** Base primitive of an ID or domain primitive. */
    base?: PrimitiveName;
    /** Values of an enum. */
    values?: string[];
    /** Japanese names of enum values, by value. */
    valueLabels?: Record<string, string>;
    fields: FieldModel[];
    invariants: InvariantModel[];
    /** Unions only: the discriminator property, the enum it is bound to (qualified name), and the variants. */
    discriminator?: string;
    tagType?: string;
    variants?: VariantModel[];
    /**
     * Aggregates, entities and events: the field sets named with `with` (qualified names). Their fields come first in
     * `fields`, marked with `fieldSet`.
     */
    fieldSets?: string[];
    /** Events only: true when the event is declared `persistent` (its contract is to be persisted). */
    persistent?: boolean;
    /** Aggregates only. */
    states?: StateModel[];
    commands?: CommandModel[];
}

export interface TermModel {
    name: string;
    label: string;
    doc?: string;
}

export interface DomainModel {
    contexts: string[];
    /** Japanese names of contexts. */
    contextLabels: Record<string, string>;
    /** Descriptions of contexts (`///` comments). */
    contextDocs: Record<string, string>;
    /** Shared contexts (shared kernel), whose elements are usable by name from every context. */
    sharedContexts: string[];
    /** Glossary of field / parameter names per context. */
    terms: Record<string, TermModel[]>;
    /** Keyed by stable ID, in declaration order. */
    elements: Record<string, ElementModel>;
}

export const elementsIn = (model: DomainModel, ctx: string): ElementModel[] =>
    Object.values(model.elements).filter((e) => e.context === ctx);

export const elementList = (model: DomainModel): ElementModel[] => Object.values(model.elements);

/** The element's own fields, without those it takes from field sets. */
export const ownFields = (el: ElementModel): FieldModel[] => el.fields.filter((f) => !f.fieldSet);

/** Fields of an element, including state-specific fields of aggregates and the fields of every union variant. */
export const allFieldsOf = (el: ElementModel): FieldModel[] => [
    ...el.fields,
    ...(el.states ?? []).flatMap((s) => s.fields),
    ...(el.variants ?? []).flatMap((v) => v.fields),
];

/** `when` of an `emits` entry as written, e.g. `Confirmed ->` (empty without one). */
export const outcomePatternText = (w: OutcomePatternModel | undefined): string =>
    w ? [w.from.join(' | '), '->', w.to.join(' | ')].filter(Boolean).join(' ') : '';

/** The multiplicity and `when` written after the event of an `emits` entry, e.g. `[1..*] when -> Draft`. */
export const emitSuffix = (e: EmitModel): string => `${e.multiplicity}${e.when ? ` when ${outcomePatternText(e.when)}` : ''}`.trim();

/** The events a command may emit (qualified names, each once, in the order of `emits`). */
export const emittedEvents = (c: CommandModel): string[] => [...new Set(c.emits.map((e) => e.event))];

/**
 * Whether an `emits` entry applies to the outcome of a command that starts in `from` (`undefined` for a factory or an
 * aggregate without states) and ends in `to`.
 */
export const emitApplies = (e: { when?: OutcomePatternModel }, from: string | undefined, to: string | undefined): boolean =>
    !e.when || ((e.when.from.length === 0 || (from !== undefined && e.when.from.includes(from))) && (e.when.to.length === 0 || (to !== undefined && e.when.to.includes(to))));

/** Whether two fields have the same type: base type, multiplicity, and kind (with the target of a reference). */
export const sameFieldType = (a: FieldModel, b: FieldModel): boolean =>
    a.kind === b.kind &&
    a.multiplicity === b.multiplicity &&
    a.target === b.target &&
    (a.type.kind === 'primitive' ? b.type.kind === 'primitive' && a.type.name === b.type.name : b.type.kind === 'ref' && a.type.ref === b.type.ref);

/**
 * What a decision of a command gives for one of its outcomes (ADR 0019), from source state `from` (`undefined` for a
 * factory or an aggregate without states) to target state `to` (`undefined` without states):
 *   - `set`: the fields the decision must give — every field for a factory; else the target's own fields that are not
 *     carried over, and the fields in `changes` that the outcome has;
 *   - `carried`: the fields taken from the input unchanged — the common fields not in `changes`, and the state-specific
 *     fields that source and target both have with the same name and type (not in `changes`);
 *   - `dropped`: the source's own fields that are not carried over.
 */
export function outcomeFields(agg: ElementModel, c: CommandModel, from: string | undefined, to: string | undefined): { set: FieldModel[]; carried: FieldModel[]; dropped: FieldModel[] } {
    const own = (state: string | undefined): FieldModel[] => agg.states?.find((s) => s.name === state)?.fields ?? [];
    const target = own(to);
    if (c.factory) return { set: [...agg.fields, ...target], carried: [], dropped: [] };
    const source = own(from);
    const changes = new Set(c.changes);
    const keeps = (f: FieldModel): boolean => source.some((g) => g.name === f.name && sameFieldType(f, g));
    return {
        set: [...agg.fields.filter((f) => changes.has(f.name)), ...target.filter((f) => !keeps(f) || changes.has(f.name))],
        carried: [...agg.fields, ...target].filter((f) => !changes.has(f.name) && (agg.fields.includes(f) || keeps(f))),
        dropped: source.filter((f) => !target.some((g) => g.name === f.name && sameFieldType(f, g))),
    };
}
