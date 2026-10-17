/**
 * Typed Model: a resolved, serializable view of the domain model.
 * It is the input of the TypeScript generator and of the Graph IR, and is sent to the Live View.
 */

export type PrimitiveName = 'String' | 'Int' | 'Decimal' | 'Bool' | 'Timestamp' | 'UUID';

export type ElementKind = 'id' | 'primitive' | 'enum' | 'valueObject' | 'entity' | 'aggregate' | 'event' | 'error';

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

export interface CommandModel extends Described {
    id: string;
    name: string;
    factory: boolean;
    params: FieldModel[];
    /** State names (within the owning aggregate). */
    from: string[];
    to: string[];
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
