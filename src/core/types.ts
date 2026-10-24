import {
    isEntity,
    isEnumDecl,
    isIdType,
    isPrimitiveDecl,
    isUnionDecl,
    isValueObject,
    isVerifiedDecl,
    isReferenceField,
    type Entity,
    type EnumDecl,
    type IdType,
    type Multiplicity,
    type Parameter,
    type PrimitiveDecl,
    type PrimitiveType,
    type TypeRef,
    type UnionDecl,
    type ValueObject,
} from '../language/generated/ast.js';
import type { FieldLike } from './model-index.js';

/** Static types used by the invariant expression checker. */
export type Ty =
    /**
     * `literal` marks values written in the source (`0`, `"x"`), `computed` the numbers `count(…)` and `length(…)`
     * compute; both have no concept of their own and may be compared with domain primitives.
     */
    | { k: 'prim'; name: PrimitiveType; literal?: boolean; computed?: boolean }
    | { k: 'id'; decl: IdType }
    /** A domain primitive declared with `primitive`. */
    | { k: 'dp'; decl: PrimitiveDecl }
    | { k: 'enum'; decl: EnumDecl }
    | { k: 'struct'; decl: Entity | ValueObject }
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
    /** Already reported; suppresses cascading diagnostics. */
    | { k: 'error' };

export const BOOL: Ty = { k: 'prim', name: 'Bool' };
/** The result of `count(…)` and `length(…)`. */
export const COMPUTED_INT: Ty = { k: 'prim', name: 'Int', computed: true };
export const ERROR: Ty = { k: 'error' };

export type Cardinality = 'one' | 'optional' | 'many' | 'nonEmpty';

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
export function baseType(ref: TypeRef | undefined, seen = new Set<unknown>()): Ty {
    if (!ref) return ERROR;
    if (ref.primitive) return { k: 'prim', name: ref.primitive };
    const decl = ref.decl?.ref;
    if (!decl) return ERROR;
    if (isVerifiedDecl(decl)) {
        if (seen.has(decl)) return ERROR;
        seen.add(decl);
        return baseType(decl.base, seen);
    }
    if (isIdType(decl)) return { k: 'id', decl };
    if (isPrimitiveDecl(decl)) return { k: 'dp', decl };
    if (isEnumDecl(decl)) return { k: 'enum', decl };
    if (isEntity(decl) || isValueObject(decl)) return { k: 'struct', decl };
    if (isUnionDecl(decl)) return { k: 'union', decl };
    return ERROR; // aggregates are not values; reported by M004
}

export function memberType(m: FieldLike | Parameter): Ty {
    const base = baseType(m.type);
    if (base.k === 'error') return base;
    if (isReferenceField(m) && base.k !== 'id') return ERROR;
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
        case 'error':
            return '<error>';
    }
}

export const isNumeric = (t: Ty): boolean => t.k === 'prim' && (t.name === 'Int' || t.name === 'Decimal');

/** Base primitive of an ID or domain primitive, or the primitive itself. */
export function basePrimitive(t: Ty): PrimitiveType | undefined {
    if (t.k === 'prim') return t.name;
    if (t.k === 'id' || t.k === 'dp') return t.decl.base;
    return undefined;
}

export const isDomainPrimitive = (t: Ty): boolean => t.k === 'id' || t.k === 'dp';
export const isBool = (t: Ty): boolean => t.k === 'prim' && t.name === 'Bool';

export function sameType(a: Ty, b: Ty): boolean {
    if (a.k !== b.k) return false;
    switch (a.k) {
        case 'prim':
            return a.name === (b as typeof a).name;
        case 'id':
        case 'dp':
        case 'enum':
        case 'struct':
        case 'union':
        case 'tag':
        case 'enumType':
        case 'unionType':
            return a.decl === (b as typeof a).decl;
        case 'list':
            return sameType(a.elem, (b as typeof a).elem);
        case 'opt':
            return sameType(a.inner, (b as typeof a).inner);
        case 'ctx':
            return a.name === (b as typeof a).name;
        case 'error':
            return true;
    }
}
