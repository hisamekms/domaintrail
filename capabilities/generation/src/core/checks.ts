import type {
    AggregateModel,
    CommandModel,
    DomainModel,
    ElementOf,
    EnumModel,
    ExprModel,
    FieldModel,
    FunctionModel,
    InvariantModel,
    PrimitiveName,
    SemanticIR,
    UnionModel,
} from '@domaintrail/modeling';
import { exprModelIndex } from '@domaintrail/modeling';
import {
    BINARY_OP_TEXT,
    applicableOutcomes,
    canonicalTemporal,
    commandKinds,
    contextNames,
    elementOf,
    elementsIn,
    isTemporal,
    kindCase,
    kindOf,
} from '@domaintrail/modeling';
import type { Location } from '@domaintrail/kernel';
import { camel } from '@domaintrail/kernel';
import {
    KIND_TAG,
    RUNTIME_NAMES,
    STATE_TAG,
    TS_RESERVED,
    commonTypeName,
    invalidTypeName,
    kindTypeName,
    makeTypeName,
    pairTypeName,
    stateTypeName,
} from './naming.js';
import { aggregateParamName, choiceCheckName, choiceChecksTypeName, commandTypeName, paramsArgName, paramsTypeName } from './naming.js';

/**
 * Generated checks (ADR 0020): invariant and requirement expressions translated 1:1 into TypeScript, and the equality
 * of ADR 0016 per value object, entity and union. Pure functions over the generated types; an invariant or requirement
 * without an expression becomes a slot (`…DeclaredChecks`) that the user's code fills in.
 */

/** An ID or a domain primitive. */
export type DomainPrimitive = ElementOf<'id' | 'primitive'>;
/** A value object or an entity: a type with fields. */
export type Struct = ElementOf<'valueObject' | 'entity'>;

/** The type of a value in an expression, resolved against the Typed Model. */
export type Ty =
    | { k: 'prim'; name: PrimitiveName }
    /** An ID or domain primitive. */
    | { k: 'dp'; el: DomainPrimitive }
    /** An enum value, or the discriminator of a union (both are strings). */
    | { k: 'enum' }
    | { k: 'struct'; el: Struct }
    | { k: 'union'; el: UnionModel }
    | { k: 'list'; elem: Ty }
    | { k: 'opt'; inner: Ty }
    | { k: 'enumType'; el: EnumModel }
    | { k: 'unionType'; el: UnionModel }
    | { k: 'ctx'; name: string };

/** What the code of a context module provides to the checks it emits. */
export interface CheckEnv {
    model: DomainModel;
    ctx: string;
    /** The Semantic IR of the model. */
    ir: SemanticIR;
    /** TypeScript type of an element by qualified name, importing its context as a type. */
    typeRef(qname: string): string;
    /** A generated function of an element's context (`equalMoney` of `Common.Money`), importing the context as a value. */
    valueRef(qname: string, name: string): string;
    /** TypeScript type of a field or parameter. */
    fieldType(f: FieldModel): string;
    /** A JSDoc block for a generated declaration (ending with its `@see` line). */
    jsdoc(lines: string[], loc: Location): string[];
}

interface Binding {
    js: string;
    /** Whether `js` is already in parentheses as a whole. */
    wrapped?: boolean;
    /** For a string literal: its text as written. */
    literal?: string;
    /** For a `wrapped` binding: the expression inside the parentheses. */
    inner?: string;
    /** Whether `inner` can be an operand of `&&` as it is (it is not a `||`). */
    tight?: boolean;
}
type TypedBinding = Binding & { ty: Ty };

/** `!x`, with parentheses unless `x` already has them. */
export const negate = (b: Binding): string => (b.wrapped ? `!${b.js}` : `!(${b.js})`);

/** `x` as an operand of `&&`: without its parentheses when it does not need them. */
const andOperand = (b: Binding): string => (b.tight && b.inner !== undefined ? b.inner : b.js);

type Scope = Map<string, Binding>;

/** Names a lambda variable must not take, besides the variables in scope and the check's parameters (ADR 0028). */
const NOT_LAMBDA_NAMES: ReadonlySet<string> = new Set([
    ...TS_RESERVED,
    // the names the module imports from the runtime (other contexts are added per model)
    ...RUNTIME_NAMES,
    // the globals the translated expressions use
    'Number',
    'RegExp',
    // the variables of the check functions around the expression
    'checks',
    'violated',
]);

const BASE: Record<PrimitiveName, string> = {
    String: 'string',
    Int: 'number',
    Decimal: 'Decimal',
    Bool: 'boolean',
    Timestamp: 'Timestamp',
    UUID: 'string',
    Date: 'PlainDate',
    Time: 'PlainTime',
    YearMonth: 'PlainYearMonth',
    DateTime: 'PlainDateTime',
    ZonedDateTime: 'ZonedDateTime',
    TimeZone: 'TimeZone',
};

export const equalName = (el: { name: string }): string => `equal${el.name}`;
export const checkName = (typeName: string): string => `check${typeName}`;
export const checkWithName = (typeName: string): string => `check${typeName}With`;
export const declaredChecksName = (typeName: string): string => `${typeName}DeclaredChecks`;
export const makeName = (p: { name: string }): string => `make${p.name}`;
export const makeWithName = (p: { name: string }): string => `make${p.name}With`;
/** `checkConfirmOrderRequires`: the first requirement of a command that does not hold. */
export const requiresName = (commandType: string): string => `check${commandType}Requires`;
export const requiresWithName = (commandType: string): string => `check${commandType}RequiresWith`;
export const declaredRequiresName = (commandType: string): string => `${commandType}DeclaredRequires`;

/** Test-only count of expression nodes compiled without a corresponding Semantic IR expression. */
export let irMisses = 0;
export let irSymbolMisses = 0;
export const resetIrMisses = (): void => {
    irMisses = 0;
    irSymbolMisses = 0;
};

/** Whether an element's or state's invariants include one without an expression (a slot). */
export const hasDeclared = (invs: readonly { readonly expr?: ExprModel }[]): boolean => invs.some((i) => !i.expr);

/** The form of a UUID (RFC 9562): 8-4-4-4-12 hexadecimal digits, in either case, of any version. */
export const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** The invariant that a value of an ID or domain primitive on `UUID` is a UUID (ADR 0028, decision 1). */
const UUID_INVARIANT: InvariantModel = {
    name: 'uuid',
    source: 'the form of a UUID (RFC 9562): 8-4-4-4-12 hexadecimal digits, in either case, of any version',
    expr: { k: 'matches', operand: { k: 'name', name: 'value' }, pattern: UUID_PATTERN },
};

const syntheticUuidExpressions = new Set<ExprModel>([UUID_INVARIANT.expr!, ...(UUID_INVARIANT.expr!.k === 'matches' ? [UUID_INVARIANT.expr!.operand] : [])]);

/**
 * The invariants that the constructor of an ID or domain primitive checks: on a `UUID` base, the generated `'uuid'`
 * first (the form the other invariants assume), then those of the model (none is named `uuid`, M002).
 */
export const primitiveInvariants = (p: DomainPrimitive): readonly InvariantModel[] => (p.base === 'UUID' ? [UUID_INVARIANT, ...p.invariants] : p.invariants);

/** Every invariant of an aggregate: its own, then those of each state (names are unique across them, M002). */
/** Every invariant of an aggregate: the common ones, those of each state and those of each kind. */
export const aggregateInvariants = (agg: AggregateModel): InvariantModel[] => [
    ...agg.invariants,
    ...agg.states.flatMap((s) => s.invariants),
    ...agg.kinds.flatMap((k) => k.invariants),
];

/** Every invariant of a union: those of each variant. */
export const unionInvariants = (u: UnionModel): InvariantModel[] => u.variants.flatMap((v) => v.invariants);

export function fieldTy(model: DomainModel, f: FieldModel): Ty {
    const base = baseTy(model, f);
    switch (f.cardinality) {
        case 'one':
            return base;
        case 'optional':
            return { k: 'opt', inner: base };
        default:
            return { k: 'list', elem: base };
    }
}

function baseTy(model: DomainModel, f: FieldModel): Ty {
    if (f.type.kind === 'primitive') return { k: 'prim', name: f.type.name };
    const el = elementOf(model, f.type.ref);
    switch (el?.kind) {
        case 'id':
        case 'primitive':
            return { k: 'dp', el };
        case 'enum':
            return { k: 'enum' };
        case 'valueObject':
        case 'entity':
            return { k: 'struct', el };
        case 'union':
            return { k: 'union', el };
        case 'verified':
            return baseTy(model, { ...f, type: el.verified.of }); // a verified value is a value of its base
        default:
            throw new Error(`no value type for field '${f.name}'`);
    }
}

/** Translate an IR checked type into the type used by the expression compiler. */
export function tyFromIr(env: CheckEnv, type: { name: string; cardinality: string }): Ty {
    let base: Ty;
    const el = elementOf(env.model, type.name);
    if (!el) {
        const primitiveNames: readonly PrimitiveName[] = [
            'String',
            'Int',
            'Decimal',
            'Bool',
            'Timestamp',
            'UUID',
            'Date',
            'Time',
            'YearMonth',
            'DateTime',
            'ZonedDateTime',
            'TimeZone',
        ];
        if (!primitiveNames.some((name) => name === type.name)) throw new Error(`unknown IR type '${type.name}'`);
        base = { k: 'prim', name: primitiveNames.find((name) => name === type.name)! };
    } else {
        switch (el.kind) {
            case 'id':
            case 'primitive':
                base = { k: 'dp', el };
                break;
            case 'enum':
                base = { k: 'enum' };
                break;
            case 'valueObject':
            case 'entity':
                base = { k: 'struct', el };
                break;
            case 'union':
                base = { k: 'union', el };
                break;
            case 'verified':
                return tyFromIr(env, { name: el.verified.of.kind === 'primitive' ? el.verified.of.name : el.verified.of.ref, cardinality: type.cardinality });
            default:
                throw new Error(`unsupported IR declaration type '${type.name}'`);
        }
    }
    if (type.cardinality === 'optional') return { k: 'opt', inner: base };
    if (type.cardinality === 'many' || type.cardinality === 'nonEmpty') return { k: 'list', elem: base };
    return base;
}

/** The base primitive of a scalar type, if it is one. */
function primOf(t: Ty): PrimitiveName | undefined {
    if (t.k === 'prim') return t.name;
    if (t.k === 'dp') return t.el.base;
    return undefined;
}

const strip = (t: Ty): Ty => (t.k === 'opt' ? t.inner : t);

/**
 * A value for `<`, `==`, ranges: Decimals are compared by `decimalCompare`; dates and times are their canonical text,
 * which orders as they do (ADR 0038), so a string literal compared with one is written in its canonical form.
 */
function scalar(b: TypedBinding, other?: TypedBinding): string {
    const p = other && primOf(strip(other.ty));
    if (b.literal !== undefined && isTemporal(p)) return quote(canonicalTemporal(p, b.literal) ?? b.literal);
    return b.js;
}

const isDecimal = (b: TypedBinding): boolean => primOf(strip(b.ty)) === 'Decimal';
const isZoned = (b: TypedBinding): boolean => primOf(strip(b.ty)) === 'ZonedDateTime';
const compare = (a: TypedBinding, b: TypedBinding, op: string): string =>
    isDecimal(a) || isDecimal(b)
        ? `decimalCompare(String(${a.js}), String(${b.js})) ${op} 0`
        : isZoned(a) || isZoned(b) // by instant (ADR 0038)
          ? `zonedCompare(${scalar(a, b)}, ${scalar(b, a)}) ${op} 0`
          : `${scalar(a, b)} ${op} ${scalar(b, a)}`;

export class ExprCompiler {
    /** Counter of temporaries (`$0`, `$1`, …), which no DSL name can collide with. */
    private temp = 0;
    /** The parameters of the check the expression being compiled is in (see `violated`). */
    private params: readonly string[] = [];
    /** Names a lambda variable must not take in this module, other than those of the scope. */
    private readonly notLambda: ReadonlySet<string>;
    private readonly irIndex: ReturnType<typeof exprModelIndex>;

    constructor(private readonly env: CheckEnv) {
        const { model, ctx } = env;
        this.irIndex = exprModelIndex(env.ir, model);
        // the other contexts are imported as namespaces, and the equality of this context's types is called by name
        const equalities = elementsIn(model, ctx)
            .filter((el) => el.kind === 'valueObject' || el.kind === 'entity' || el.kind === 'union')
            .map((el) => equalName(el));
        this.notLambda = new Set([...NOT_LAMBDA_NAMES, ...contextNames(model), ...equalities]);
    }

    /**
     * The condition under which `e`, an invariant or a requirement, is violated: `!(e)`, or `A && !B` for an implication
     * `A implies B` (ADR 0028) or `!(A) || B`, which is the same condition without the double negation. `params` are the parameters of
     * the check it is in, which lambda variables do not shadow.
     */
    violated(e: ExprModel, scope: Scope, params: readonly string[]): string {
        this.params = params;
        if (e.k === 'binary' && e.op === 'implies') return `${andOperand(this.compile(e.left, scope))} && ${negate(this.compile(e.right, scope))}`;
        // `!(A) || B`, the implication of the TS-like syntax: violated when `A && !B`
        if (e.k === 'binary' && e.op === 'or' && e.left.k === 'not')
            return `${andOperand(this.compile(e.left.operand, scope))} && ${negate(this.compile(e.right, scope))}`;
        return negate(this.compile(e, scope));
    }

    /**
     * The TypeScript name of a lambda variable: its name in `.dt` (`item`), or with a number (`item2`) when that clashes
     * with a variable in scope, a parameter of the check, a reserved word or a name the module imports.
     */
    private lambdaName(name: string, scope: Scope, more: readonly string[] = []): string {
        const used = new Set([...this.params, ...more]);
        for (const b of scope.values()) {
            const root = /^[A-Za-z_$][\w$]*/.exec(b.js);
            if (root) used.add(root[0]);
        }
        const free = (n: string): boolean => !used.has(n) && !this.notLambda.has(n);
        if (free(name)) return name;
        let i = 2;
        while (!free(`${name}${i}`)) i++;
        return `${name}${i}`;
    }

    /** `a == b` by the equality of ADR 0016, for two values of type `t` (and `u` on the right, for numbers). */
    equal(t: Ty, a: string, b: string, u: Ty = t): string {
        const s = strip(t);
        if (t.k === 'opt') return `sameOptional(${a}, ${b}, ${this.equalFn(t.inner)})`;
        if (t.k === 'list') return `sameList(${a}, ${b}, ${this.equalFn(t.elem)})`;
        if (s.k === 'struct' || s.k === 'union') return `${this.env.valueRef(s.el.id, equalName(s.el))}(${a}, ${b})`;
        const pa = primOf(s);
        const pb = primOf(strip(u));
        if (pa === 'Decimal' || pb === 'Decimal') return `decimalCompare(String(${a}), String(${b})) === 0`;
        return `${a} === ${b}`;
    }

    /** A function `(x, y) => boolean` for the equality of type `t`. */
    equalFn(t: Ty): string {
        if (t.k === 'struct' || t.k === 'union') return this.env.valueRef(t.el.id, equalName(t.el));
        const [x, y] = [`$${this.temp++}`, `$${this.temp++}`];
        return `(${x}: ${this.tsType(t)}, ${y}: ${this.tsType(t)}) => ${this.equal(t, x, y)}`;
    }

    private tsType(t: Ty): string {
        switch (t.k) {
            case 'prim':
                return BASE[t.name];
            case 'dp':
            case 'struct':
            case 'union':
                return this.env.typeRef(t.el.id);
            default:
                return 'string';
        }
    }

    compile(e: ExprModel, scope: Scope): TypedBinding {
        const result = this.compileNode(e, scope);
        // the generator's own UUID invariant has no source: `matches(value, …)` is a Bool over the UUID's text
        if (syntheticUuidExpressions.has(e)) return { ...result, ty: { k: 'prim', name: e.k === 'matches' ? 'Bool' : 'UUID' } };
        const type = this.irTy(e);
        if (!type) throw new Error(`expression '${this.irNode(e)?.source ?? e.k}' has no IR type`);
        return { ...result, ty: type };
    }

    private compileNode(e: ExprModel, scope: Scope): Binding {
        const irNode = this.irNode(e);
        if (this.env.ir && !irNode && !syntheticUuidExpressions.has(e)) irMisses++;
        if (this.env.ir && (e.k === 'name' || e.k === 'member') && !irNode?.symbol && !syntheticUuidExpressions.has(e)) irSymbolMisses++;
        const bool = (js: string): Binding => ({ js });
        /** `(js)`; `loose` when `js` is a `||` at the top. */
        const wrapped = (js: string, loose = false): Binding => ({ ...bool(`(${js})`), wrapped: true, inner: js, tight: !loose });
        /** The body of an arrow function, which needs no parentheses. */
        const body = (b: Binding): string => b.inner ?? b.js;
        switch (e.k) {
            case 'bool':
                return bool(String(e.value));
            case 'int':
                return { js: e.value < 0 ? `(${e.value})` : String(e.value) };
            case 'decimal':
                return { js: quote(e.value) };
            case 'string':
                return { js: quote(e.value), literal: e.value };
            case 'name':
                return this.name(e, scope);
            case 'member':
                return this.member(e, scope);
            case 'not':
                return bool(negate(this.compile(e.operand, scope)));
            case 'exists':
                return wrapped(`${this.compile(e.operand, scope).js} !== undefined`);
            case 'count':
            case 'length': {
                const value = this.compile(e.k === 'count' ? e.collection : e.operand, scope);
                return { js: e.k === 'length' && primOf(strip(value.ty)) === 'String' ? `Array.from(${value.js}).length` : `${value.js}.length` };
            }
            case 'matches':
                return bool(`${regex(e.pattern)}.test(${this.compile(e.operand, scope).js})`);
            case 'call': {
                // a function of this context by its name, of a shared context through that context
                const id = this.irNode(e)?.symbol?.id ?? e.name;
                const dot = id.lastIndexOf('.');
                const fn = dot >= 0 && id.slice(0, dot) !== this.env.ctx ? this.env.valueRef(id, e.name) : e.name;
                return { js: `${fn}(${e.args.map((a) => this.compile(a, scope).js).join(', ')})` };
            }
            case 'list':
                return { js: `[${e.items.map((i) => `${i.spread ? '...' : ''}${this.compile(i.value, scope).js}`).join(', ')}]` };
            case 'listMethod': {
                const c = this.compile(e.collection, scope);
                const p = e.param !== undefined ? this.lambdaName(e.param, scope) : `$${this.temp++}`;
                const b = e.param !== undefined && e.body ? this.compile(e.body, new Map([...scope, [e.param, { js: p }]])).js : p;
                if (e.method !== 'sum') return { js: `${c.js}.${e.method}((${p}) => ${b})` };
                const s = `$${this.temp++}`;
                const sum = this.irTy(e);
                return sum?.k === 'prim' && sum.name === 'Decimal'
                    ? { js: `${c.js}.reduce((${s}, ${p}) => decimalAdd(${s}, String(${b})), '0')` }
                    : { js: `${c.js}.reduce((${s}, ${p}) => ${s} + ${b}, 0)` };
            }
            case 'conditional': {
                const test = this.compile(e.test, scope);
                return wrapped(`${test.js} ? ${this.compile(e.ifTrue, scope).js} : ${this.compile(e.ifFalse, scope).js}`, true);
            }
            case 'range': {
                const v = this.compile(e.operand, scope);
                const lo = this.compile(e.lower, scope);
                const hi = this.compile(e.upper, scope);
                return wrapped(`${compare(lo, v, '<=')} && ${compare(v, hi, '<=')}`);
            }
            case 'quantifier': {
                const c = this.compile(e.collection, scope);
                const p = this.lambdaName(e.param, scope);
                const b = this.compile(e.body, new Map([...scope, [e.param, { js: p }]]));
                return bool(`${c.js}.${e.quantifier === 'all' ? 'every' : 'some'}((${p}) => ${body(b)})`);
            }
            case 'contains': {
                const c = this.compile(e.collection, scope);
                const x = this.compile(e.element, scope);
                const elem = c.ty.k === 'list' ? c.ty.elem : c.ty;
                const v = `$${this.temp++}`;
                return bool(`${c.js}.some((${v}) => ${this.equal(elem, v, x.js, x.ty)})`);
            }
            case 'unique': {
                const c = this.compile(e.collection, scope);
                const elem = c.ty.k === 'list' ? c.ty.elem : c.ty;
                if (!e.param) return bool(`distinct(${c.js}, ${this.equalFn(elem)})`);
                // the keys of two elements: the parameter as `x` and as `x2`
                const a = this.lambdaName(e.param, scope);
                const b = this.lambdaName(e.param, scope, [a]);
                const left = new Map([...scope, [e.param, { js: a }]]);
                const right = new Map([...scope, [e.param, { js: b }]]);
                const same = e.keys.map((k) => {
                    const l = this.compile(k, left);
                    return this.equal(l.ty, l.js, this.compile(k, right).js);
                });
                return bool(`distinct(${c.js}, (${a}, ${b}) => ${same.join(' && ')})`);
            }
            case 'binary': {
                const l = this.compile(e.left, scope);
                const r = this.compile(e.right, scope);
                switch (e.op) {
                    case 'and':
                        return wrapped(`${l.js} && ${r.js}`);
                    case 'or':
                        return wrapped(`${l.js} || ${r.js}`, true);
                    case 'implies':
                        return wrapped(`${negate(l)} || ${r.js}`, true);
                    case 'eq':
                        return wrapped(this.comparisonEqual(e, l, r));
                    case 'ne':
                        return bool(`!(${this.comparisonEqual(e, l, r)})`);
                    case 'lt':
                    case 'le':
                    case 'gt':
                    case 'ge':
                        return wrapped(compare(l, r, BINARY_OP_TEXT[e.op]));
                    case 'coalesce':
                        return wrapped(`${l.js} ?? ${r.js}`);
                    case 'add':
                    case 'sub':
                    case 'mul':
                    case 'div': {
                        // Int arithmetic is JavaScript's; a Decimal is a string, computed exactly by the runtime
                        if (!isDecimal(l) && !isDecimal(r)) return wrapped(`${l.js} ${BINARY_OP_TEXT[e.op]} ${r.js}`, e.op !== 'mul');
                        const fn = { add: 'decimalAdd', sub: 'decimalSub', mul: 'decimalMul', div: 'decimalDiv' }[e.op];
                        const scale = e.op === 'div' ? `, ${this.irNode(e)?.type?.scale ?? 0}` : '';
                        return { js: `${fn}(String(${l.js}), String(${r.js})${scale})` };
                    }
                }
            }
        }
    }

    private irNode(e: ExprModel): ReturnType<typeof exprModelIndex> extends Map<ExprModel, infer T> ? T | undefined : never {
        return this.irIndex.get(e);
    }

    private irTy(e: ExprModel): Ty | undefined {
        const node = this.irNode(e);
        if (node?.type) {
            if (node.type.tag === true) return { k: 'enum' };
            return tyFromIr(this.env, node.type);
        }
        const symbol = node?.symbol;
        if (symbol?.kind === 'type') {
            const el = elementOf(this.env.model, symbol.id);
            if (el?.kind === 'enum') return { k: 'enumType', el };
            if (el?.kind === 'union') return { k: 'unionType', el };
        }
        if (symbol?.kind === 'context') return { k: 'ctx', name: symbol.id };
        return undefined;
    }

    /**
     * `l == r` by the IR's comparison fact (ADR 0016): structural and entity comparisons call the element's equality
     * function, the others compare scalars. Optionality is stripped as before: M009 rejects an unguarded optional, and
     * the IR types a guarded one as present. Lists keep `equal()`'s `sameList` form.
     */
    private comparisonEqual(e: Extract<ExprModel, { k: 'binary' }>, l: TypedBinding, r: TypedBinding): string {
        const comparison = this.irNode(e)?.comparison;
        if (!comparison || comparison === 'notComparable') throw new Error(`'${this.irNode(e)?.source ?? '=='}' has no comparable IR fact`);
        const [t, u] = [strip(l.ty), strip(r.ty)];
        const structural = comparison === 'valueObjectStructural' || comparison === 'unionStructural' || comparison === 'entityId';
        if (structural && t.k !== 'list') {
            const s = t.k === 'struct' || t.k === 'union' ? t : u.k === 'struct' || u.k === 'union' ? u : undefined;
            if (!s) throw new Error(`'${this.irNode(e)?.source}' is a ${comparison} comparison without an element type`);
            return `${this.env.valueRef(s.el.id, equalName(s.el))}(${scalar(l, r)}, ${scalar(r, l)})`;
        }
        return this.equal(t, scalar(l, r), scalar(r, l), u);
    }

    private name(e: Extract<ExprModel, { k: 'name' }>, scope: Scope): Binding {
        const name = e.name;
        const bound = scope.get(name);
        if (bound) return bound;
        const { model } = this.env;
        const symbol = this.irNode(e)?.symbol;
        if (symbol?.kind === 'type') {
            const declared = elementOf(model, symbol.id);
            if (declared?.kind === 'enum' || declared?.kind === 'union') return { js: '' };
        }
        if (symbol?.kind === 'context') return { js: '' };
        throw new Error(`cannot resolve '${name}'`);
    }

    private member(e: Extract<ExprModel, { k: 'member' }>, scope: Scope): Binding {
        const receiver = e.receiver;
        const m = e.member;
        const symbol = this.irNode(e)?.symbol;
        const r = this.compile(receiver, scope);
        const t = strip(r.ty); // an optional receiver is compared with null first (M009), or read with `?.`
        const dot = e.optional ? '?.' : '.';
        switch (t.k) {
            case 'ctx': {
                const el = symbol?.kind === 'type' ? elementOf(this.env.model, symbol.id) : undefined;
                if (el?.kind === 'enum' || el?.kind === 'union') return { js: '' };
                throw new Error(`no enum or union '${t.name}.${m}'`);
            }
            case 'enumType':
            case 'unionType':
                // The IR records which enum value or union tag was resolved at this source location.
                if (symbol?.kind === 'enumValue' || symbol?.kind === 'unionTag') return { js: quote(m) };
                throw new Error(`no enum value or union tag '${m}'`);
            case 'union':
                if (symbol?.kind !== 'discriminator') throw new Error(`union member '${m}' has no discriminator symbol`);
                return { js: `${r.js}${dot}${m}` }; // only the discriminator is accessible (M009)
            case 'struct': {
                const separator = symbol?.kind === 'field' ? symbol.id.lastIndexOf('.') : -1;
                const ownerId = separator >= 0 ? symbol!.id.slice(0, separator) : undefined;
                if (ownerId !== t.el.id) throw new Error(`field '${m}' belongs to '${ownerId ?? 'unknown'}', not '${t.el.id}'`);
                const fieldName = separator >= 0 ? symbol!.id.slice(separator + 1) : undefined;
                const f = fieldName ? t.el.fields.find((x) => x.name === fieldName) : undefined;
                if (!f) throw new Error(`'${t.el.name}' has no field '${m}'`);
                return { js: `${r.js}${dot}${m}` };
            }
            default:
                throw new Error(`no field '${m}'`);
        }
    }
}

/** A string literal in single quotes, as the generated code writes them (ADR 0028). */
export function quote(text: string): string {
    // JSON's escapes are those of a JavaScript string; a `"` needs none between single quotes, a `'` does
    return `'${JSON.stringify(text).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`;
}

/** Translate portable shorthand classes without nesting classes or changing escaped backslashes. */
export function portableRegexPattern(pattern: string): string {
    const classes: Record<string, [string, string]> = {
        d: ['[0-9]', '0-9'],
        D: ['[^0-9]', ''],
        s: ['[ \\t\\n\\r\\f\\v]', ' \\t\\n\\r\\f\\v'],
        S: ['[^ \\t\\n\\r\\f\\v]', ''],
        w: ['[A-Za-z0-9_]', 'A-Za-z0-9_'],
        W: ['[^A-Za-z0-9_]', ''],
    };
    let inClass = false;
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === '\\') {
            const next = pattern[++i];
            if (next === undefined) throw new Error('Trailing backslash in regex');
            const replacement = classes[next];
            if (replacement) {
                if (inClass && !replacement[1]) throw new Error(`\\${next} is not portable inside a character class`);
                out += replacement[inClass ? 1 : 0];
            } else out += `\\${next}`;
        } else {
            if (char === '[' && !inClass) inClass = true;
            else if (char === ']' && inClass) inClass = false;
            out += char;
        }
    }
    return out;
}

/** A Unicode-aware JavaScript regex for the portable subset. */
function regex(pattern: string): string {
    return `new RegExp(${quote(portableRegexPattern(pattern))}, 'u')`;
}

/** A scope with the fields of an element, read from `subject`. */
export function fieldScope(model: DomainModel, subject: string, fields: readonly FieldModel[]): Scope {
    return new Map(fields.map((f) => [f.name, { js: `${subject}.${f.name}` }]));
}

/** The name of the variable holding the value an element's checks look at. */
export const subjectName = (typeName: string): string => {
    const n = camel(typeName);
    return n === 'checks' ? 'subject' : n;
};

/** A parameter list where the parameters the body does not use are prefixed with `_` (for `noUnusedParameters`). */
export function params(list: { name: string; type: string }[], body: string): string {
    return list.map((p) => `${new RegExp(`(^|[^\\w$.])${p.name}\\b`).test(body) ? p.name : `_${p.name}`}: ${p.type}`).join(', ');
}

/** An invariant of a checked value: its expression compiled in `scope`, or (declared) a call of its slot. */
export interface CheckItem {
    name: string;
    /** The condition under which it is violated; absent for an invariant declared without an expression. */
    violated?: string;
    /** For a declared invariant: the arguments its slot takes. */
    args?: string;
    /** Wraps the statement, e.g. `if (x.kind === 'Card') { … }` for the invariants of a union variant. */
    guard?: string;
}

/** The statements that collect the violated invariants of `items` into `violated`. */
export function collect(items: CheckItem[], indent: string): string[] {
    return items.map((i) => {
        const cond = i.violated ?? `!checks.${i.name}(${i.args})`;
        return `${indent}if (${i.guard ? `${i.guard} && ` : ''}${cond}) violated.push('${i.name}');`;
    });
}

/** Compiles the expressed invariants among `invs` in `scope`; declared ones call their slot with `args`. */
export function items(compiler: ExprCompiler, invs: readonly InvariantModel[], scope: Scope, args: string, guard?: string): CheckItem[] {
    return invs.map((i) => ({ name: i.name, ...(i.expr ? { violated: compiler.violated(i.expr, scope, [args]) } : { args }), ...(guard && { guard }) }));
}

/**
 * The requirement scope of a command: the aggregate's fields it sees (from `subject`) and its parameters, read from the
 * parameters object `params`.
 */
export function requirementScope(model: DomainModel, agg: AggregateModel, c: CommandModel, subject: string, params: string): Scope {
    const states = agg.states;
    const sources = [...new Set(c.transitions.flatMap((t) => t.from))];
    const first = states.find((s) => s.name === sources[0]);
    const fields = c.factory ? [] : [...agg.fields, ...(first?.fields ?? [])];
    const scope = fieldScope(model, subject, fields);
    for (const p of c.params) scope.set(p.name, { js: `${params}.${p.name}` });
    return scope;
}

interface Param {
    name: string;
    type: string;
}

/** The states (and kinds) a named command can actually receive, preserving kind–state restrictions in generated checks. */
function namedSubjectType(agg: AggregateModel, c: CommandModel): string {
    if (!agg.kinds.length) {
        if (!agg.states.length) return agg.name;
        const sources = [...new Set(applicableOutcomes(agg, c, '*').flatMap((o) => o.from))];
        return sources.map((from) => stateTypeName(agg, from)).join(' | ') || 'never';
    }
    const kinds = commandKinds(agg, c);
    if (!agg.states.length) return kinds.map((k) => kindTypeName(agg, k)).join(' | ') || 'never';
    const pairs = kinds.flatMap((kind) => applicableOutcomes(agg, c, kind).flatMap((o) => o.from.map((from) => pairTypeName(agg, kind, from))));
    return [...new Set(pairs)].join(' | ') || 'never';
}

/** The fields a decision rule of a command sees for a kind (`'*'` without kinds) and a source state. */
const decisionFields = (agg: AggregateModel, kind: string, from: string | undefined): FieldModel[] => [
    ...agg.fields,
    ...(kindOf(agg, kind)?.fields ?? []),
    ...(agg.states.find((s) => s.name === from)?.fields ?? []),
];

/** Equality guards preserve TypeScript's discriminant narrowing, unlike Array.includes. */
function matchesAny(subject: string, field: string, values: readonly string[]): string | undefined {
    if (!values.length) return undefined;
    return values.map((value) => `${subject}.${field} === '${value}'`).join(' || ');
}

/** A type as the element type of an array (`(A | B)[]`). */
const list = (t: string): string => (/[ |]/.test(t) ? `(${t})` : t);

/** The union of invariant names a check returns (`never` without any). */
const namesType = (names: string[]): string => (names.length ? [...new Set(names)].map((n) => `'${n}'`).join(' | ') : 'never');

/** Writes the generated checks of one context module. */
export class CheckWriter {
    private readonly compiler: ExprCompiler;

    constructor(private readonly env: CheckEnv) {
        this.compiler = new ExprCompiler(env);
    }

    /** Predicate values for every named outcome; external choices have mandatory typed slots. */
    choices(agg: AggregateModel, c: CommandModel): string[] {
        // each outcome with the kind it is for: a kind's command or `on` case (ADR 0037), or every kind
        const outcomes = [
            ...c.outcomes.map((o) => ({ o, kind: c.kind })),
            ...agg.kinds.flatMap((k) => (kindCase(agg, k.name, c.name)?.outcomes ?? []).map((o) => ({ o, kind: k.name as string | undefined }))),
        ];
        if (!outcomes.length) return [];
        // an outcome name may be used by several kinds' cases (ADR 0037): one slot and one value per name
        const names = [...new Set(outcomes.map(({ o }) => o.name))];
        const external = names.filter((n) => outcomes.some(({ o }) => o.name === n && o.select?.kind === 'external'));
        const subject = aggregateParamName(agg);
        const parameters = paramsArgName(agg);
        const args = [
            ...(c.factory ? [] : [{ name: subject, type: namedSubjectType(agg, c) }]),
            ...(c.params.length ? [{ name: parameters, type: paramsTypeName(agg, c) }] : []),
        ];
        const signature = args.map((a) => `${a.name}: ${a.type}`).join(', ');
        const lines = [`export type ${choiceChecksTypeName(agg, c)} = { ${external.map((n) => `readonly ${n}: (${signature}) => boolean`).join('; ')} };`, ''];
        const choices = outcomes.map(({ o, kind }) => {
            const choice = o.select;
            const scope = c.factory ? new Map<string, Binding>() : fieldScope(this.env.model, subject, decisionFields(agg, kind ?? '*', o.from[0]));
            for (const p of c.params) scope.set(p.name, { js: `${parameters}.${p.name}` });
            const code =
                choice?.kind === 'expression'
                    ? this.compiler.compile(choice.expr, scope).js
                    : choice?.kind === 'external'
                      ? `checks.${o.name}(${args.map((a) => a.name).join(', ')})`
                      : 'true';
            const caseKind = kind !== undefined && kind !== c.kind ? kind : undefined;
            const guards = c.factory
                ? []
                : [
                      ...(agg.states.length ? [matchesAny(subject, 'state', o.from)] : []),
                      ...(caseKind ? [matchesAny(subject, KIND_TAG, [caseKind])] : []),
                  ].filter((guard): guard is string => guard !== undefined);
            return {
                name: o.name,
                value: `${guards.length ? `(${guards.map((guard) => `(${guard})`).join(' && ')}) && (` : ''}${code}${guards.length ? ')' : ''}`,
            };
        });
        const merged = names.map((n) => {
            const parts = choices.filter((x) => x.name === n).map((x) => x.value);
            return `${n}: ${parts.length === 1 ? parts[0] : parts.map((p) => `(${p})`).join(' || ')}`;
        });
        const body = `return { ${merged.join(', ')} };`;
        lines.push(
            `export function ${choiceCheckName(agg, c)}(checks: ${choiceChecksTypeName(agg, c)}): (${signature}) => { ${names.map((n) => `readonly ${n}: boolean`).join('; ')} } {`,
        );
        lines.push(`    return (${params(args, body)}) => { ${body} };`);
        lines.push('}');
        return lines;
    }

    /** Common requirements followed by those of the `on` case of the aggregate's kind. */
    namedRequirements(agg: AggregateModel, c: CommandModel): string[] {
        const cases = agg.kinds.flatMap((k) => {
            const x = kindCase(agg, k.name, c.name);
            return x ? [{ kind: k.name, case: x }] : [];
        });
        if (!c.requires.length && !cases.some((g) => g.case.requires.length)) return [];
        const type = commandTypeName(agg, c);
        const subject = aggregateParamName(agg);
        const parameters = paramsArgName(agg);
        const args = [
            ...(c.factory ? [] : [{ name: subject, type: namedSubjectType(agg, c) }]),
            ...(c.params.length ? [{ name: parameters, type: paramsTypeName(agg, c) }] : []),
        ];
        const sig = args.map((a) => `${a.name}: ${a.type}`).join(', ');
        const names = args.map((a) => a.name).join(', ');
        const allSources = [...c.outcomes, ...cases.flatMap((g) => g.case.outcomes)].flatMap((o) => o.from);
        const entries = [
            ...c.requires.map((r) => ({ requirement: r, key: r.name, kind: c.kind, inCase: false, sources: allSources })),
            ...cases.flatMap((g) =>
                g.case.requires.map((r) => ({
                    requirement: r,
                    key: `${g.kind}_${r.name}`,
                    kind: g.kind as string | undefined,
                    inCase: true,
                    sources: g.case.outcomes.flatMap((o) => o.from),
                })),
            ),
        ];
        const external = entries.filter(({ requirement }) => !requirement.expr);
        const union = [...new Set(entries.map((e) => e.key))].map((x) => `'${x}'`).join(' | ');
        const lines: string[] = [];
        if (external.length) {
            lines.push(`export type ${declaredRequiresName(type)} = { ${external.map((x) => `readonly ${x.key}: (${sig}) => boolean`).join('; ')} };`, '');
        }
        const body = entries.map(({ requirement, key, kind, inCase, sources }) => {
            const scope = c.factory ? new Map<string, Binding>() : fieldScope(this.env.model, subject, decisionFields(agg, kind ?? '*', sources[0]));
            for (const p of c.params) scope.set(p.name, { js: `${parameters}.${p.name}` });
            const holds = requirement.expr ? this.compiler.compile(requirement.expr, scope).js : `checks.${key}(${names})`;
            const check = `if (!(${holds})) return '${key}';`;
            if (!inCase || c.factory) return check;
            const guards = [matchesAny(subject, KIND_TAG, [kind!]), matchesAny(subject, 'state', sources)].filter(
                (guard): guard is string => guard !== undefined,
            );
            return `if (${guards.map((guard) => `(${guard})`).join(' && ')}) { ${check} }`;
        });
        body.push('return undefined;');
        const name = external.length ? requiresWithName(type) : requiresName(type);
        const returns = `${union} | undefined`;
        if (external.length) {
            lines.push(`export function ${name}(checks: ${declaredRequiresName(type)}): (${sig}) => ${returns} {`);
            lines.push(`    return (${params(args, body.join(' '))}) => {`);
            lines.push(...body.map((line) => `        ${line}`));
            lines.push('    };', '}');
        } else {
            lines.push(`export function ${name}(${params(args, body.join(' '))}): ${returns} {`);
            lines.push(...body.map((line) => `    ${line}`));
            lines.push('}');
        }
        return lines;
    }

    /**
     * A check function: `check<T>(subject)` returning the violated invariants, or with declared invariants
     * `check<T>With(checks)` returning that function. `body` collects into `violated` (or returns the result itself),
     * which starts with the elements of `init` (an expression of an array) when given; an empty body returns none.
     */
    private checkFunction(
        doc: string[],
        loc: Location,
        typeName: string,
        subject: Param,
        result: string,
        declared: string | false,
        body: string[],
        init?: string,
    ): string[] {
        const text = [init ?? '', ...body].join('\n');
        const head = this.env.jsdoc(doc, loc);
        const collects = text.includes('violated.push');
        const start = init ? `[...${init}]` : '[]';
        const inner = collects
            ? [`const violated: ${list(result)}[] = ${start};`, ...body, 'return violated;']
            : body.length
              ? body
              : [`return ${init ?? '[]'};`];
        if (!declared) {
            return [
                ...head,
                `export function ${checkName(typeName)}(${params([subject], text)}): readonly ${list(result)}[] {`,
                ...inner.map((l) => `    ${l}`),
                '}',
            ];
        }
        return [
            ...head,
            `export function ${checkWithName(typeName)}(${text.includes('checks') ? 'checks' : '_checks'}: ${declaredChecksName(declared)}): (${subject.name}: ${subject.type}) => readonly ${list(result)}[] {`,
            `    return (${params([{ name: subject.name, type: '' }], text).replace(/: $/, '')}) => {`,
            ...inner.map((l) => `        ${l}`),
            '    };',
            '}',
        ];
    }

    /** `type <T>DeclaredChecks = { readonly name: (subject) => boolean }`: the slots of invariants without an expression. */
    private declaredType(typeName: string, loc: Location, slots: { name: string; args: string }[]): string[] {
        const seen = new Set<string>();
        const members = slots.filter((s) => !seen.has(s.name) && seen.add(s.name)).map((s) => `readonly ${s.name}: (${s.args}) => boolean`);
        return [
            ...this.env.jsdoc(
                [`The invariants of ${typeName} that the DSL does not express: implement them in your code and pass them to \`${checkWithName(typeName)}\`.`],
                loc,
            ),
            `export type ${declaredChecksName(typeName)} = { ${members.join('; ')} };`,
            '',
        ];
    }

    /** A domain primitive (or ID): its check and its generated constructor `make<Name>`. */
    primitive(p: DomainPrimitive): string[] {
        const base = BASE[p.base];
        const type = p.name;
        const invariants = primitiveInvariants(p);
        if (invariants.length === 0) {
            return [
                ...this.env.jsdoc([`Creates a ${p.name}: it has no invariants, so every value is one.`], p.location),
                `export const ${makeName(p)}: ${makeTypeName(p)} = (value) => value as ${type};`,
            ];
        }
        const scope: Scope = new Map([['value', { js: 'value' }]]);
        const declared = hasDeclared(invariants);
        const result = `${invalidTypeName(p)}['invariant']`;
        const out: string[] = [];
        if (declared)
            out.push(
                ...this.declaredType(
                    type,
                    p.location,
                    invariants.filter((i) => !i.expr).map((i) => ({ name: i.name, args: `value: ${base}` })),
                ),
            );
        out.push(
            ...this.checkFunction(
                [
                    `The invariants of ${p.name} that a value violates, in declaration order${p.base === 'UUID' ? " after 'uuid'" : ''}; empty when it is a ${p.name}.`,
                ],
                p.location,
                type,
                { name: 'value', type: base },
                result,
                declared && type,
                collect(items(this.compiler, invariants, scope, 'value'), ''),
            ),
            '',
        );
        const make = (check: string, indent: string): string[] =>
            [
                `(value) => {`,
                `    const [invariant] = ${check}(value);`,
                `    if (invariant === undefined) return ok(value as ${type});`,
                `    return err({ type: '${this.env.ctx}.${invalidTypeName(p)}', value, invariant });`,
                `}`,
            ].map((l, i) => (i === 0 ? l : `${indent}${l}`));
        if (!declared) {
            out.push(
                ...this.env.jsdoc(
                    [`Creates a ${p.name}, checking its invariants with \`${checkName(type)}\`: the first one violated is reported.`],
                    p.location,
                ),
                `export const ${makeName(p)}: ${makeTypeName(p)} = ${make(checkName(type), '').join('\n')};`,
            );
        } else {
            out.push(
                ...this.env.jsdoc(
                    [`Creates a ${p.name} constructor from the invariants the DSL does not express; the first invariant violated is reported.`],
                    p.location,
                ),
                `export const ${makeWithName(p)} = (checks: ${declaredChecksName(type)}): ${makeTypeName(p)} => {`,
                `    const check = ${checkWithName(type)}(checks);`,
                `    return ${make('check', '    ').join('\n')};`,
                `};`,
            );
        }
        return out;
    }

    /** The equality of a value object (all fields), an entity (`id`) or a union (discriminator and fields). */
    equality(el: Struct | UnionModel): string[] {
        const type = el.name;
        const c = this.compiler;
        let doc: string;
        let body: string[];
        if (el.kind === 'entity') {
            const id = el.fields.find((f) => f.name === 'id')!;
            doc = `Whether two ${type} are the same entity: by \`id\` (ADR 0016).`;
            body = [`return ${c.equal(fieldTy(this.env.model, id), 'a.id', 'b.id')};`];
        } else if (el.kind === 'valueObject') {
            doc = `Whether two ${type} values are equal: by all their fields (ADR 0016).`;
            const parts = el.fields.map((f) => c.equal(fieldTy(this.env.model, f), `a.${f.name}`, `b.${f.name}`));
            body = [`return ${parts.length ? parts.join(' && ') : 'true'};`];
        } else {
            const tag = el.discriminator;
            doc = `Whether two ${type} values are equal: by \`${tag}\` and the fields of the variant (ADR 0016).`;
            body = [`if (a.${tag} !== b.${tag}) return false;`];
            for (const v of el.variants) {
                if (!v.fields.length) continue;
                const narrowed = `Extract<${type}, { readonly ${tag}: '${v.name}' }>`;
                const parts = v.fields.map((f) => c.equal(fieldTy(this.env.model, f), `a.${f.name}`, `y.${f.name}`));
                body.push(`if (a.${tag} === '${v.name}') {`, `    const y = b as ${narrowed};`, `    return ${parts.join(' && ')};`, '}');
            }
            body.push('return true;');
        }
        const text = body.join('\n');
        return [
            ...this.env.jsdoc([doc], el.location),
            `export function ${equalName(el)}(${params(
                [
                    { name: 'a', type },
                    { name: 'b', type },
                ],
                text,
            )}): boolean {`,
            ...body.map((l) => `    ${l}`),
            '}',
        ];
    }

    /** The check of a value object or entity. */
    /** `function name(params): R { expr }` as a TypeScript function of its parameters. */
    fn(f: FunctionModel): string[] {
        const scope: Scope = new Map(f.params.map((p) => [p.name, { js: p.name }]));
        const type = (x: { type: FieldModel['type']; cardinality: FieldModel['cardinality']; name: string }): string => {
            const t = this.env.fieldType({ ...x, kind: 'field', multiplicity: '' } as FieldModel);
            return x.cardinality === 'optional' ? `${t} | undefined` : t;
        };
        const params = f.params.map((p) => `${p.name}: ${type(p)}`).join(', ');
        const returns = type({ name: f.name, type: f.returns, cardinality: f.cardinality });
        return [
            ...this.env.jsdoc([...(f.label ? [f.label] : []), ...(f.doc ? f.doc.split('\n') : []), `@returns ${f.source}`], f.location),
            `export function ${f.name}(${params}): ${returns} {`,
            `    return ${this.compiler.compile(f.expr, scope).js};`,
            '}',
        ];
    }

    struct(el: Struct): string[] {
        if (!el.invariants.length) return [];
        const subject = subjectName(el.name);
        const scope = fieldScope(this.env.model, subject, el.fields);
        const declared = hasDeclared(el.invariants);
        return [
            ...(declared
                ? this.declaredType(
                      el.name,
                      el.location,
                      el.invariants.filter((i) => !i.expr).map((i) => ({ name: i.name, args: `${subject}: ${el.name}` })),
                  )
                : []),
            ...this.checkFunction(
                [`The invariants of ${el.name} that a value violates, in declaration order; empty when it holds them all.`],
                el.location,
                el.name,
                { name: subject, type: el.name },
                namesType(el.invariants.map((i) => i.name)),
                declared && el.name,
                collect(items(this.compiler, el.invariants, scope, subject), ''),
            ),
        ];
    }

    /** The check of a union: the invariants of the variant a value is in. */
    union(u: UnionModel): string[] {
        const all = unionInvariants(u);
        if (!all.length) return [];
        const tag = u.discriminator;
        const subject = subjectName(u.name);
        const declared = hasDeclared(all);
        const body: CheckItem[] = [];
        const slots: { name: string; args: string }[] = [];
        for (const v of u.variants) {
            const guard = `${subject}.${tag} === '${v.name}'`;
            body.push(...items(this.compiler, v.invariants, fieldScope(this.env.model, subject, v.fields), subject, guard));
            for (const i of v.invariants.filter((x) => !x.expr))
                slots.push({ name: i.name, args: `${subject}: Extract<${u.name}, { readonly ${tag}: '${v.name}' }>` });
        }
        return [
            ...(declared ? this.declaredType(u.name, u.location, slots) : []),
            ...this.checkFunction(
                [`The invariants of ${u.name} (those of the variant a value is in) that a value violates; empty when it holds them all.`],
                u.location,
                u.name,
                { name: subject, type: u.name },
                namesType(all.map((i) => i.name)),
                declared && u.name,
                collect(body, ''),
            ),
        ];
    }

    /**
     * The checks of an aggregate. With states: of the common part (the aggregate's invariants, also without any), per
     * state (the common part's and the state's) and for any state.
     */
    aggregate(agg: AggregateModel): string[] {
        if (agg.kinds.length) return this.kindsAggregate(agg);
        const all = aggregateInvariants(agg);
        if (!all.length && !agg.states.length) return [];
        const subject = subjectName(agg.name);
        const states = agg.states;
        const declared = hasDeclared(all);
        const model = this.env.model;
        const slotArgs = (stateType: string) => `${subject}: ${stateType}`;
        const out: string[] = [];
        if (declared) {
            const slots = [
                ...agg.invariants.filter((i) => !i.expr).map((i) => ({ name: i.name, args: slotArgs(states.length ? commonTypeName(agg) : agg.name) })),
                ...states.flatMap((s) => s.invariants.filter((i) => !i.expr).map((i) => ({ name: i.name, args: slotArgs(stateTypeName(agg, s)) }))),
            ];
            out.push(...this.declaredType(agg.name, agg.location, slots));
        }
        if (!states.length) {
            out.push(
                ...this.checkFunction(
                    [`The invariants of ${agg.name} that an aggregate violates, in declaration order; empty when it holds them all.`],
                    agg.location,
                    agg.name,
                    { name: subject, type: agg.name },
                    namesType(all.map((i) => i.name)),
                    declared && agg.name,
                    collect(items(this.compiler, agg.invariants, fieldScope(model, subject, agg.fields), subject), ''),
                ),
            );
            return out;
        }
        // An invariant of the aggregate holds in every state: it, and the slot of one without an expression, sees the common part.
        const common = commonTypeName(agg);
        const commonDeclared = hasDeclared(agg.invariants);
        out.push(
            ...this.checkFunction(
                [`The invariants of ${agg.name} (those of every state) that an aggregate violates, in declaration order; empty when it holds them all.`],
                agg.location,
                common,
                { name: subject, type: common },
                namesType(agg.invariants.map((i) => i.name)),
                commonDeclared && agg.name,
                collect(items(this.compiler, agg.invariants, fieldScope(model, subject, agg.fields), subject), ''),
            ),
        );
        if (!all.length) return out;
        out.push('');
        const commonCall = commonDeclared ? `${checkWithName(common)}(checks)(${subject})` : `${checkName(common)}(${subject})`;
        for (const s of states) {
            const type = stateTypeName(agg, s);
            const scope = fieldScope(model, subject, [...agg.fields, ...s.fields]);
            out.push(
                ...this.checkFunction(
                    [
                        `The invariants of ${agg.name} in state ${s.name} (the aggregate's, by \`${commonDeclared ? checkWithName(common) : checkName(common)}\`, and the state's) that an aggregate violates, in declaration order.`,
                    ],
                    s.location,
                    type,
                    { name: subject, type },
                    namesType([...agg.invariants, ...s.invariants].map((i) => i.name)),
                    declared && agg.name,
                    collect(items(this.compiler, s.invariants, scope, subject), ''),
                    commonCall,
                ),
                '',
            );
        }
        const call = (s: { name: string }): string =>
            declared ? `${checkWithName(stateTypeName(agg, s))}(checks)(${subject})` : `${checkName(stateTypeName(agg, s))}(${subject})`;
        out.push(
            ...this.checkFunction(
                [`The invariants of ${agg.name} in the state it is in that an aggregate violates (see the check of each state).`],
                agg.location,
                agg.name,
                { name: subject, type: agg.name },
                namesType(all.map((i) => i.name)),
                declared && agg.name,
                [`switch (${subject}.state) {`, ...states.map((s) => `    case '${s.name}': return ${call(s)};`), '}'],
            ),
        );
        return out;
    }

    /**
     * The checks of an aggregate with kinds (ADR 0037): the common invariants (`check<Agg>Common`), those of a kind with
     * the common ones (`check<Kind><Agg>`), those of a state with the common ones (`check<State><Agg>`), and all that
     * apply to an aggregate in its kind and state (`check<Agg>`).
     */
    private kindsAggregate(agg: AggregateModel): string[] {
        const all = aggregateInvariants(agg);
        const subject = subjectName(agg.name);
        const states = agg.states;
        const declared = hasDeclared(all);
        const model = this.env.model;
        const common = commonTypeName(agg);
        const commonDeclared = hasDeclared(agg.invariants);
        const out: string[] = [];
        if (declared) {
            const slot = (type: string) => `${subject}: ${type}`;
            out.push(
                ...this.declaredType(agg.name, agg.location, [
                    ...agg.invariants.filter((i) => !i.expr).map((i) => ({ name: i.name, args: slot(common) })),
                    ...states.flatMap((s) => s.invariants.filter((i) => !i.expr).map((i) => ({ name: i.name, args: slot(stateTypeName(agg, s)) }))),
                    ...agg.kinds.flatMap((k) => k.invariants.filter((i) => !i.expr).map((i) => ({ name: i.name, args: slot(kindTypeName(agg, k.name)) }))),
                ]),
            );
        }
        out.push(
            ...this.checkFunction(
                [`The invariants of ${agg.name} (those of every kind${states.length ? ' and state' : ''}) that an aggregate violates, in declaration order.`],
                agg.location,
                common,
                { name: subject, type: common },
                namesType(agg.invariants.map((i) => i.name)),
                commonDeclared && agg.name,
                collect(items(this.compiler, agg.invariants, fieldScope(model, subject, agg.fields), subject), ''),
            ),
            '',
        );
        const commonCall = commonDeclared ? `${checkWithName(common)}(checks)(${subject})` : `${checkName(common)}(${subject})`;
        const call = (type: string, own: boolean): string =>
            declared && own ? `${checkWithName(type)}(checks)(${subject})` : `${checkName(type)}(${subject})`;
        for (const k of agg.kinds.filter((x) => x.invariants.length)) {
            const type = kindTypeName(agg, k.name);
            out.push(
                ...this.checkFunction(
                    [`The invariants of ${agg.name} of kind ${k.name} (the common ones and the kind's) that an aggregate violates, in declaration order.`],
                    k.location,
                    type,
                    { name: subject, type },
                    namesType([...agg.invariants, ...k.invariants].map((i) => i.name)),
                    declared && agg.name,
                    collect(items(this.compiler, k.invariants, fieldScope(model, subject, [...agg.fields, ...k.fields]), subject), ''),
                    commonCall,
                ),
                '',
            );
        }
        for (const s of states) {
            const type = stateTypeName(agg, s);
            out.push(
                ...this.checkFunction(
                    [`The invariants of ${agg.name} in state ${s.name} (the common ones and the state's) that an aggregate violates, in declaration order.`],
                    s.location,
                    type,
                    { name: subject, type },
                    namesType([...agg.invariants, ...s.invariants].map((i) => i.name)),
                    declared && agg.name,
                    collect(items(this.compiler, s.invariants, fieldScope(model, subject, [...agg.fields, ...s.fields]), subject), ''),
                    commonCall,
                ),
                '',
            );
        }
        // the state's check (with the common invariants), then the invariants of the aggregate's kind
        const init = states.length
            ? `${states.map((s) => `${subject}.${STATE_TAG} === '${s.name}' ? ${call(stateTypeName(agg, s), true)}`).join(' : ')} : []`
            : commonCall;
        const kindItems = agg.kinds.flatMap((k) =>
            items(this.compiler, k.invariants, fieldScope(model, subject, [...agg.fields, ...k.fields]), subject, `${subject}.${KIND_TAG} === '${k.name}'`),
        );
        out.push(
            ...this.checkFunction(
                [`The invariants of ${agg.name} in its kind${states.length ? ' and state' : ''} that an aggregate violates.`],
                agg.location,
                agg.name,
                { name: subject, type: agg.name },
                namesType(all.map((i) => i.name)),
                declared && agg.name,
                collect(kindItems, ''),
                init,
            ),
        );
        return out;
    }

    /**
     * The requirements of a command: the first that does not hold, in declaration order (ADR 0020, D2), or `undefined`.
     * `subject` is the aggregate parameter (absent for a factory), `ps` the parameters object (absent without parameters).
     */
    requires(agg: AggregateModel, c: CommandModel, typeName: string, subject: Param | undefined, ps: Param | undefined): string[] {
        if (!c.requires.length) return [];
        const scope = requirementScope(this.env.model, agg, c, subject?.name ?? '', ps?.name ?? '');
        const args = [...(subject ? [subject] : []), ...(ps ? [ps] : [])];
        const names = args.map((a) => a.name);
        const argNames = names.join(', ');
        const declared = hasDeclared(c.requires);
        const result = `${namesType(c.requires.map((r) => r.name))} | undefined`;
        const body = [
            ...c.requires.map((r) => `if (${r.expr ? this.compiler.violated(r.expr, scope, names) : `!checks.${r.name}(${argNames})`}) return '${r.name}';`),
            'return undefined;',
        ];
        const text = body.join('\n');
        const doc = [`The first requirement of ${agg.name}.${c.name} that does not hold, in declaration order; \`undefined\` when all hold.`];
        if (!declared) {
            return [
                ...this.env.jsdoc(doc, c.location),
                `export function ${requiresName(typeName)}(${params(args, text)}): ${result} {`,
                ...body.map((l) => `    ${l}`),
                '}',
            ];
        }
        const sig = args.map((a) => `${a.name}: ${a.type}`).join(', ');
        return [
            ...this.env.jsdoc(
                [
                    `The requirements of ${agg.name}.${c.name} that the DSL does not express: implement them in your code and pass them to \`${requiresWithName(typeName)}\`.`,
                ],
                c.location,
            ),
            `export type ${declaredRequiresName(typeName)} = { ${c.requires
                .filter((r) => !r.expr)
                .map((r) => `readonly ${r.name}: (${sig}) => boolean`)
                .join('; ')} };`,
            '',
            ...this.env.jsdoc(doc, c.location),
            `export function ${requiresWithName(typeName)}(checks: ${declaredRequiresName(typeName)}): (${sig}) => ${result} {`,
            `    return (${params(
                args.map((a) => ({ name: a.name, type: '' })),
                text,
            ).replace(/: (?=,|$)/g, '')}) => {`,
            ...body.map((l) => `        ${l}`),
            '    };',
            '}',
        ];
    }
}
