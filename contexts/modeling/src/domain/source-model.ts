/**
 * The model as written: every declaration of the `.dt` sources, with a site for everything a diagnostic may point at,
 * its expressions as trees and its references resolved to the declarations they name. Modeling's rules (and the
 * generator's name check) read it; the Typed Model (`DomainModel`, model.ts) is the resolved and deduplicated view that
 * the generator and the Live View read.
 *
 * Unlike the Typed Model it keeps what the rules report on: duplicate declarations and members (the first of a name is
 * the one references resolve to), references as written with their target when they resolve, the kind of each field,
 * terms and every fragment of a context. It is built from the syntax (`infrastructure/syntax/build-source.ts`) when the
 * sources parse, and never serialized: references are the declarations themselves and may form cycles.
 */
import type { Position } from '@domaintrail/kernel';
import type { PrimitiveName } from './model.js';

/**
 * Where a diagnostic is reported: a range of a source (1-based, as in a `Diagnostic`) and the stable ID (ids.ts) of the
 * model element, state, command or context it lies in.
 */
export interface Site {
    file: string;
    start: Position;
    end: Position;
    elementId?: string;
}

/** A reference as written, with the declaration it resolves to (absent when it does not; linking reports it). */
export interface Ref<T> {
    text: string;
    target?: T;
    /** The name as written. */
    at: Site;
}

/** What every named declaration has: its name, inline label and `///` description, and their sites. */
export interface Declared {
    name: string;
    /** The label written after the name (not the one taken from a term or a type). */
    label?: string;
    doc?: string;
    /** The whole declaration. */
    at: Site;
    nameAt: Site;
    /** The label; the whole declaration when it has none. */
    labelAt: Site;
}

/** `?` or `[lower..upper]` / `[lower..*]` as written. */
export interface Multiplicity {
    optional: boolean;
    lower?: number;
    upper?: number;
    unbounded: boolean;
}

/** The type of a field or parameter as written: a built-in type, or a reference to a declared one. */
export interface TypeRef {
    primitive?: PrimitiveName;
    decl?: Ref<TypeDecl>;
    at: Site;
}

/** A field of an element, state or variant: plain, `owns` or `references`. */
export interface FieldDecl extends Declared {
    kind: 'field' | 'owns' | 'references';
    type?: TypeRef;
    multiplicity?: Multiplicity;
    /** The aggregate a `references` field points at (`-> Aggregate`; the syntax's `target`). */
    aggregate?: Ref<AggregateDecl>;
    typeAt: Site;
}

/** A parameter of a command. */
export interface ParamDecl extends Declared {
    kind: 'param';
    type?: TypeRef;
    multiplicity?: Multiplicity;
    typeAt: Site;
}

export interface InvariantDecl extends Declared {
    kind: 'invariant';
    expr?: Expr;
    /** The expression; the whole invariant without one. */
    exprAt: Site;
}

export type DataMember = FieldDecl | InvariantDecl;

export interface StateDecl extends Declared {
    kind: 'state';
    /** Stable ID (`Sales.Order#Confirmed`). */
    id: string;
    members: DataMember[];
}

/** `A | B -> C | D`; a factory's has no source states. */
export interface TransitionDecl {
    from: Ref<StateDecl>[];
    to: Ref<StateDecl>[];
    at: Site;
}

/** `when A | B -> C` of an `emits` entry. */
export interface OutcomePatternDecl {
    from: Ref<StateDecl>[];
    to: Ref<StateDecl>[];
    at: Site;
}

export interface EmitDecl {
    event: Ref<EventDecl>;
    multiplicity?: Multiplicity;
    when?: OutcomePatternDecl;
    at: Site;
    /** The pattern; the whole entry without one. */
    whenAt: Site;
}

export interface RequirementDecl extends Declared {
    expr?: Expr;
    error: Ref<ErrorDecl>;
    /** The expression; the whole requirement without one. */
    exprAt: Site;
}

export interface CommandDecl extends Declared {
    kind: 'command';
    /** Stable ID (`Sales.Order:confirm`). */
    id: string;
    factory: boolean;
    params: ParamDecl[];
    transitions: TransitionDecl[];
    /** The site of each transition as a property of the command (`transitions`, index i). */
    transitionsAt: Site[];
    requirements: RequirementDecl[];
    /** `changes a, b`: each name as written. */
    changes: { name: string; at: Site }[];
    emits: EmitDecl[];
    errors: Ref<ErrorDecl>[];
}

export type AggregateMember = DataMember | StateDecl | CommandDecl;

export type EnumValueDecl = Declared;

export interface VariantDecl extends Declared {
    members: DataMember[];
}

/** What every element has, besides its kind's own parts. */
interface ElementBase extends Declared {
    /** Stable ID (`Sales.Order`); duplicates share it. */
    id: string;
    context: string;
}

/** `id X: T { … }` and `primitive X: T { … }`: named invariants, or one anonymous constraint. */
export interface IdDecl extends ElementBase {
    kind: 'id';
    base?: PrimitiveName;
    invariants: InvariantDecl[];
    constraint?: Expr;
}

export interface PrimitiveDecl extends ElementBase {
    kind: 'primitive';
    base?: PrimitiveName;
    invariants: InvariantDecl[];
    constraint?: Expr;
}

export interface VerifiedDecl extends ElementBase {
    kind: 'verified';
    base?: TypeRef;
    /** The context of the check, `for C` (the syntax's `context`; `?`: `forOptional`). */
    for?: TypeRef;
    forOptional: boolean;
    errors: Ref<ErrorDecl>[];
    /** `of …`; the whole declaration without it. */
    baseAt: Site;
    /** `for …`; the whole declaration without it. */
    forAt: Site;
}

export interface EnumDecl extends ElementBase {
    kind: 'enum';
    values: EnumValueDecl[];
}

/** Elements that may name field sets with `with` (only aggregates, entities, value objects and events may, M016). */
interface WithFieldSetsBase extends ElementBase {
    /** `with A, B`: each reference with its site as a property of the element (`fieldSets`, index i). */
    fieldSets: Ref<FieldSetDecl>[];
}

export interface ValueObjectDecl extends WithFieldSetsBase {
    kind: 'valueObject';
    members: DataMember[];
}

export interface FieldSetDecl extends WithFieldSetsBase {
    kind: 'fieldSet';
    members: DataMember[];
}

export interface EntityDecl extends WithFieldSetsBase {
    kind: 'entity';
    members: DataMember[];
}

export interface AggregateDecl extends WithFieldSetsBase {
    kind: 'aggregate';
    members: AggregateMember[];
}

export interface EventDecl extends WithFieldSetsBase {
    kind: 'event';
    persistent: boolean;
    /** Plain fields only. */
    members: FieldDecl[];
}

export interface ErrorDecl extends WithFieldSetsBase {
    kind: 'error';
    /** Plain fields only. */
    members: FieldDecl[];
}

export interface UnionDecl extends ElementBase {
    kind: 'union';
    /** `by name` as written; `discriminatorOf` gives the default. */
    discriminator?: string;
    /** `by name: Enum`. */
    tagType?: Ref<EnumDecl>;
    variants: VariantDecl[];
}

export interface PolicyDecl extends ElementBase {
    kind: 'policy';
    event: Ref<EventDecl>;
    aggregate: Ref<AggregateDecl>;
    /** Looked up in the aggregate. */
    command: Ref<CommandDecl>;
}

export type ElementDecl =
    | IdDecl
    | PrimitiveDecl
    | VerifiedDecl
    | EnumDecl
    | ValueObjectDecl
    | UnionDecl
    | EntityDecl
    | AggregateDecl
    | EventDecl
    | ErrorDecl
    | FieldSetDecl
    | PolicyDecl;

/** Types that may be named as the type of a field or parameter. */
export type TypeDecl = IdDecl | PrimitiveDecl | VerifiedDecl | EnumDecl | ValueObjectDecl | UnionDecl | EntityDecl | AggregateDecl;

/** Elements that may name field sets with `with`. */
export type WithFieldSets = AggregateDecl | EntityDecl | EventDecl | ValueObjectDecl | ErrorDecl | FieldSetDecl;

/** The data an element holds directly: everything that has `members` but an aggregate's states and commands. */
export type WithMembers = ValueObjectDecl | FieldSetDecl | EntityDecl | AggregateDecl | EventDecl | ErrorDecl;

/** An entry of a context's `terms`. */
export interface TermDecl {
    name: string;
    label: string;
    doc?: string;
    at: Site;
    nameAt: Site;
    labelAt: Site;
}

/** One `context` block; a context may be split across files. */
export interface ContextFragment {
    name: string;
    shared: boolean;
    label?: string;
    doc?: string;
    /** The `///` lines of `doc`; present with it. */
    docAt?: Site;
    /** The entries of its `terms` blocks, in order. */
    terms: TermDecl[];
    at: Site;
    nameAt: Site;
    labelAt: Site;
}

/**
 * An expression of an invariant or requirement as a tree, with the site of the expression (`at`), of the parts a
 * diagnostic may point at (`…At`), and its text on one line. As in `ExprModel`, names are resolved by whoever reads it.
 */
export type Expr = ExprBase &
    (
        | { k: 'bool'; value: boolean }
        /** The value as written, without its sign (`negative`). */
        | { k: 'int'; value: number; negative: boolean }
        | { k: 'decimal'; value: string; negative: boolean }
        | { k: 'string'; value: string }
        | { k: 'name'; name: string }
        | { k: 'member'; receiver: Expr; member: string; memberAt: Site }
        | { k: 'not'; operand: Expr }
        | {
              k: 'binary';
              op: 'implies' | 'or' | 'and' | '==' | '!=' | '<' | '<=' | '>' | '>=';
              left: Expr;
              right: Expr;
              leftAt: Site;
              rightAt: Site;
          }
        | { k: 'range'; operand: Expr; lower: Expr; upper: Expr }
        | { k: 'count'; collection: Expr; collectionAt: Site }
        | { k: 'exists'; operand: Expr; operandAt: Site }
        | { k: 'length'; operand: Expr; operandAt: Site }
        /** `pattern` is the regular expression exactly as written (see `ExprModel`). */
        | { k: 'matches'; operand: Expr; pattern: string; operandAt: Site; patternAt: Site }
        | { k: 'unique'; collection: Expr; param?: string; keys: Expr[]; collectionAt: Site; keysAt: Site[] }
        | { k: 'contains'; collection: Expr; element: Expr; collectionAt: Site; elementAt: Site }
        | { k: 'quantifier'; quantifier: 'all' | 'any'; collection: Expr; param: string; body: Expr; collectionAt: Site; bodyAt: Site }
    );

interface ExprBase {
    at: Site;
    /** The source text on one line (runs of white space as one space). */
    text: string;
}

export type ExprKind = Expr['k'];

/** The model as written of a workspace's `.dt` sources. */
export interface SourceModel {
    /** Every `context` block, in the order of the sources. */
    fragments: ContextFragment[];
    /** Every element, in the order of the sources, duplicates included. */
    elements: ElementDecl[];
    /** The names of the contexts, sorted, each once. */
    contexts: string[];
    /** The contexts declared `shared` in any of their fragments, sorted (disagreements are reported by M014). */
    sharedContexts: string[];
    /** The elements by qualified name (`Sales.Order`), duplicates in order. */
    byName: ReadonlyMap<string, readonly ElementDecl[]>;
}

// ---- lookups ---------------------------------------------------------------------------------------------------

/** The element of a qualified name (the first, when it is declared more than once). */
export const lookup = (model: SourceModel, qname: string): ElementDecl | undefined => model.byName.get(qname)?.[0];

/** A simple name as seen from `ctx`: its own elements first, then those of shared contexts. */
export const lookupVisible = (model: SourceModel, ctx: string, name: string): ElementDecl | undefined =>
    lookup(model, `${ctx}.${name}`) ?? model.sharedContexts.map((s) => lookup(model, `${s}.${name}`)).find(Boolean);

export const elementsOf = (model: SourceModel, ctx: string): ElementDecl[] => model.elements.filter((e) => e.context === ctx);

export const isShared = (model: SourceModel, ctx: string): boolean => model.fragments.some((c) => c.name === ctx && c.shared);

/** The elements declared more than once, by qualified name, each group in order. */
export const duplicates = (model: SourceModel): (readonly ElementDecl[])[] => [...model.byName.values()].filter((l) => l.length > 1);

// ---- members ---------------------------------------------------------------------------------------------------

export const isField = (m: AggregateMember): m is FieldDecl => m.kind === 'field' || m.kind === 'owns' || m.kind === 'references';

export const fieldsOf = (members: readonly AggregateMember[]): FieldDecl[] => members.filter(isField);

export const invariantsOf = (members: readonly AggregateMember[]): InvariantDecl[] => members.filter((m): m is InvariantDecl => m.kind === 'invariant');

/** An aggregate's fields outside its states. */
export const commonFields = (agg: AggregateDecl): FieldDecl[] => fieldsOf(agg.members);

export const statesOf = (agg: AggregateDecl): StateDecl[] => agg.members.filter((m): m is StateDecl => m.kind === 'state');

export const commandsOf = (agg: AggregateDecl): CommandDecl[] => agg.members.filter((m): m is CommandDecl => m.kind === 'command');

/** The field sets an element names with `with`, resolved, each once, in order. */
export const fieldSetsOf = (el: WithFieldSets): FieldSetDecl[] => [...new Set(el.fieldSets.map((r) => r.target).filter((f): f is FieldSetDecl => !!f))];

/** The fields an element takes from its field sets, with the field set of each, before its own fields. */
export function includedFields(el: WithFieldSets): { field: FieldDecl; fieldSet: FieldSetDecl }[] {
    if (el.kind === 'fieldSet') return [];
    return fieldSetsOf(el).flatMap((fieldSet) => fieldsOf(fieldSet.members).map((field) => ({ field, fieldSet })));
}

/** The `id` field of an aggregate or entity (outside an aggregate's states). */
export const identityField = (el: AggregateDecl | EntityDecl): FieldDecl | undefined => fieldsOf(el.members).find((m) => m.name === 'id');

/** Discriminator property of a union declared without `by`. */
export const DEFAULT_DISCRIMINATOR = 'kind';

export const discriminatorOf = (u: UnionDecl): string => u.discriminator ?? DEFAULT_DISCRIMINATOR;

/** Fields of every variant of a union. */
export const variantFields = (u: UnionDecl): FieldDecl[] => u.variants.flatMap((v) => fieldsOf(v.members));

export type DomainPrimitiveDecl = IdDecl | PrimitiveDecl;

/** Name used for the anonymous constraint form `primitive X: Int { value > 0 }`. */
export const ANONYMOUS_CONSTRAINT = 'valid';

export interface PrimitiveInvariant {
    name: string;
    label?: string;
    expr: Expr | undefined;
    /** The invariant, or the anonymous constraint (then `expr` itself). */
    decl: InvariantDecl | Expr;
    /** Where its diagnostics go: the invariant, or the constraint. */
    at: Site;
}

/** Invariants of a domain primitive, including the anonymous `{ expr }` form. */
export function primitiveInvariants(p: DomainPrimitiveDecl): PrimitiveInvariant[] {
    if (p.constraint) return [{ name: ANONYMOUS_CONSTRAINT, expr: p.constraint, decl: p.constraint, at: p.constraint.at }];
    return p.invariants.map((i) => ({ name: i.name, ...(i.label !== undefined && { label: i.label }), expr: i.expr, decl: i, at: i.at }));
}

/** The type references inside an element, in the order of the source (as M014 visits them). */
export function typeRefsIn(el: ElementDecl): TypeRef[] {
    const ofMembers = (members: readonly AggregateMember[]): TypeRef[] =>
        members.flatMap((m) => {
            if (isField(m)) return m.type ? [m.type] : [];
            if (m.kind === 'state') return ofMembers(m.members);
            if (m.kind === 'command') return m.params.flatMap((p) => (p.type ? [p.type] : []));
            return [];
        });
    switch (el.kind) {
        case 'verified':
            return [el.base, el.for].filter((t): t is TypeRef => !!t);
        case 'union':
            return el.variants.flatMap((v) => ofMembers(v.members));
        case 'valueObject':
        case 'fieldSet':
        case 'entity':
        case 'aggregate':
        case 'event':
        case 'error':
            return ofMembers(el.members);
        default:
            return [];
    }
}
