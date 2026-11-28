// The static types of values over the model as written (source-model.ts), for the rules that compare types: the
// expressions (M008, M009), the commands (M021), the payloads (M022), and the multiplicities the structure checks
// (M005, M013, M020); the Typed Model's multiplicities (infrastructure/syntax/build.ts) take `cardinality` and
// `multiplicityText` too.
import type { Cardinality, PrimitiveName } from './model.js';
import type {
    AggregateDecl,
    EntityDecl,
    EnumDecl,
    FieldDecl,
    IdDecl,
    KindDecl,
    Multiplicity,
    ParamDecl,
    PrimitiveDecl,
    StateDecl,
    TypeRef,
    UnionDecl,
    ValueObjectDecl,
    VerifiedDecl,
} from './source-model.js';

/** Static types used by the invariant expression checker. */
export type Ty =
    /**
     * `literal` marks values written in the source (`0`, `"x"`), `computed` the numbers `count(…)` and `length(…)`
     * compute; both have no concept of their own and may be compared with domain primitives.
     */
    | { k: 'prim'; name: PrimitiveName; literal?: boolean; computed?: boolean; scale?: number }
    | { k: 'id'; decl: IdDecl }
    /** A domain primitive declared with `primitive`. */
    | { k: 'dp'; decl: PrimitiveDecl }
    | { k: 'enum'; decl: EnumDecl }
    | { k: 'struct'; decl: EntityDecl | ValueObjectDecl }
    | { k: 'union'; decl: UnionDecl }
    /** The discriminator of a union not bound to an enum, and its values (`Actor.EXTERNAL_PARTY`). */
    | { k: 'tag'; decl: UnionDecl }
    | { k: 'list'; elem: Ty }
    | { k: 'opt'; inner: Ty }
    /** The name of an enum type used in value position, e.g. `CancelReason` in `CancelReason.Other`. */
    | { k: 'enumType'; decl: EnumDecl }
    /** The name of a union type used in value position, e.g. `Actor` in `Actor.EXTERNAL_PARTY`. */
    | { k: 'unionType'; decl: UnionDecl }
    /** A context name used as a qualifier, e.g. `Sales` in `Sales.Status.Open`. */
    | { k: 'ctx'; name: string }
    /**
     * `before` / `after` in `changes x = …` and `ensures`: the aggregate's fields before and after the outcome; `this`
     * in `requires`, choice rules and the aggregate's own invariants: the aggregate itself (only a `match` subject).
     * `aggregate` says which states and kinds it can be in there, for `match`.
     */
    | { k: 'frame'; name: 'before' | 'after' | 'this'; fields: ReadonlyMap<string, FieldDecl | ParamDecl>; aggregate?: AggregateFrame }
    /** Already reported; suppresses cascading diagnostics. */
    | { k: 'error' };

/**
 * One way the aggregate can be where an expression is: of `kind` (absent without kinds), in state `from` before the
 * command and `to` after it (absent without states, and `to` where there is no after: `requires`, invariants).
 */
export interface AggregatePair {
    kind?: KindDecl;
    from?: StateDecl;
    to?: StateDecl;
}

/**
 * What `match (before)`, `match (after)` and `match (this)` choose among: the (kind, state) pairs the aggregate can be
 * in where the expression is. `before` and `this` read the pairs' `from`, `after` their `to`; the frames of one
 * contract share `pairs` (by `group`), so a case of one narrows the other: `after` in `Confirmed` came from the
 * sources of the transitions into `Confirmed`.
 */
export interface AggregateFrame {
    agg: AggregateDecl;
    /** The common fields (those of the field sets included), which every case sees. */
    common: ReadonlyMap<string, FieldDecl | ParamDecl>;
    pairs: readonly AggregatePair[];
    /** Which state of a pair the frame is in. */
    side: 'from' | 'to';
    /** The frames of one scope that narrow together. */
    group: object;
    /** How the diagnostics name the states and the kinds: `the source states of command 'cancel'`. */
    statesWhat: string;
    kindsWhat: string;
}

export const BOOL: Ty = { k: 'prim', name: 'Bool' };
/** The result of `count(…)` and `length(…)`. */
export const COMPUTED_INT: Ty = { k: 'prim', name: 'Int', computed: true };
export const ERROR: Ty = { k: 'error' };

/**
 * A multiplicity as `dt fmt` writes it: `?` for `[0..1]`, empty without one or for `[1..1]`, else `[lower..upper]`.
 * Two fields with the same text have the same multiplicity.
 */
export function multiplicityText(m: Multiplicity | undefined): string {
    if (!m) return '';
    if (m.optional || (m.lower === 0 && m.upper === 1)) return '?';
    if (m.lower === 1 && m.upper === 1) return '';
    return `[${m.lower}..${m.unbounded ? '*' : m.upper}]`;
}

export function cardinality(m: Multiplicity | undefined): Cardinality {
    if (!m) return 'one';
    if (m.optional) return 'optional';
    const lower = m.lower ?? 0;
    const upper = m.unbounded ? Infinity : (m.upper ?? 1);
    if (upper <= 1) return lower === 0 ? 'optional' : 'one';
    return lower >= 1 ? 'nonEmpty' : 'many';
}

/**
 * The type of a value written with `ref`. A verified type is its base type here: in expressions and payloads a
 * verified value behaves as the value it verifies. A cycle of verified types (M024) is an error.
 */
export function baseType(ref: TypeRef | undefined, seen = new Set<VerifiedDecl>()): Ty {
    if (!ref) return ERROR;
    if (ref.primitive) return { k: 'prim', name: ref.primitive, ...(ref.scale !== undefined && { scale: ref.scale }) };
    const decl = ref.decl?.target;
    if (!decl) return ERROR;
    switch (decl.kind) {
        case 'verified':
            if (seen.has(decl)) return ERROR;
            seen.add(decl);
            return baseType(decl.base, seen);
        case 'id':
            return { k: 'id', decl };
        case 'primitive':
            return { k: 'dp', decl };
        case 'enum':
            return { k: 'enum', decl };
        case 'entity':
        case 'valueObject':
            return { k: 'struct', decl };
        case 'union':
            return { k: 'union', decl };
        default:
            return ERROR; // aggregates are not values; reported by M004
    }
}

export function memberType(m: FieldDecl | ParamDecl): Ty {
    const base = baseType(m.type);
    if (base.k === 'error') return base;
    if (m.kind === 'references' && base.k !== 'id') return ERROR;
    switch (cardinality(m.multiplicity)) {
        case 'one':
            return base;
        case 'optional':
            return { k: 'opt', inner: base };
        default:
            return { k: 'list', elem: base };
    }
}

export function showType(t: Ty): string {
    switch (t.k) {
        case 'prim':
            return t.name;
        case 'id':
        case 'dp':
        case 'enum':
        case 'struct':
        case 'union':
            return t.decl.name;
        case 'tag':
            return `tag of ${t.decl.name}`;
        case 'list':
            return `${showType(t.elem)}[0..*]`;
        case 'opt':
            return `${showType(t.inner)}?`;
        case 'enumType':
            return `enum ${t.decl.name}`;
        case 'unionType':
            return `union ${t.decl.name}`;
        case 'ctx':
            return `context ${t.name}`;
        case 'frame':
            return t.name;
        case 'error':
            return '<error>';
    }
}

export const isNumeric = (t: Ty): boolean => t.k === 'prim' && (t.name === 'Int' || t.name === 'Decimal');

/** Base primitive of an ID or domain primitive, or the primitive itself. */
export function basePrimitive(t: Ty): PrimitiveName | undefined {
    if (t.k === 'prim') return t.name;
    if (t.k === 'id' || t.k === 'dp') return t.decl.base;
    return undefined;
}

/**
 * The digits after the point of a number type: a `Decimal(n)` its declared `n`, a decimal literal the digits written
 * (`computed` from the text by the caller), an Int 0; `undefined` for a Decimal of undeclared scale.
 */
export function scaleOf(t: Ty): number | undefined {
    if (t.k === 'prim') return t.name === 'Int' ? 0 : t.name === 'Decimal' ? t.scale : undefined;
    if (t.k === 'id' || t.k === 'dp') return t.decl.base === 'Int' ? 0 : t.decl.base === 'Decimal' ? t.decl.scale : undefined;
    return undefined;
}

export const isDomainPrimitive = (t: Ty): boolean => t.k === 'id' || t.k === 'dp';
export const isBool = (t: Ty): boolean => t.k === 'prim' && t.name === 'Bool';

export function sameType(a: Ty, b: Ty): boolean {
    if (a.k !== b.k) return false;
    switch (a.k) {
        case 'prim':
            return b.k === 'prim' && a.name === b.name;
        case 'id':
        case 'dp':
        case 'enum':
        case 'struct':
        case 'union':
        case 'tag':
        case 'enumType':
        case 'unionType':
            return 'decl' in b && a.decl === b.decl;
        case 'list':
            return b.k === 'list' && sameType(a.elem, b.elem);
        case 'opt':
            return b.k === 'opt' && sameType(a.inner, b.inner);
        case 'ctx':
            return b.k === 'ctx' && a.name === b.name;
        case 'frame':
            return false;
        case 'error':
            return true;
    }
}
