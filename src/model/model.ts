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
    source: string;
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

/** `A | B -> C | D`: state names within the owning aggregate. `from` is empty for a factory. */
export interface TransitionModel {
    from: string[];
    to: string[];
}

export interface CommandModel extends Described {
    id: string;
    name: string;
    factory: boolean;
    params: FieldModel[];
    /** State transitions; a factory has one without source states, an aggregate without states none. */
    transitions: TransitionModel[];
    /** Qualified event / error names. */
    emits: string[];
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
