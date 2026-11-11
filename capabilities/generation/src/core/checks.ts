import type {
    AggregateModel,
    CommandModel,
    DomainModel,
    ElementOf,
    EnumModel,
    ExprModel,
    FieldModel,
    InvariantModel,
    PrimitiveName,
    UnionModel,
} from '@domaintrail/modeling';
import { BINARY_OP_TEXT, applicableOutcomes, contextNames, elementOf, elementsIn, sharedContexts } from '@domaintrail/modeling';
import type { Location } from '@domaintrail/kernel';
import { camel } from '@domaintrail/kernel';
import { RUNTIME_NAMES, TS_RESERVED, commonTypeName, invalidTypeName, makeTypeName, stateTypeName } from './naming.js';
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
    | { k: 'prim'; name: PrimitiveName; literal?: boolean }
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
    ty: Ty;
    /** Whether `js` is already in parentheses as a whole. */
    wrapped?: boolean;
    /** For a `wrapped` binding: the expression inside the parentheses. */
    inner?: string;
    /** Whether `inner` can be an operand of `&&` as it is (it is not a `||`). */
    tight?: boolean;
}

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

const BASE: Record<PrimitiveName, string> = { String: 'string', Int: 'number', Decimal: 'Decimal', Bool: 'boolean', Timestamp: 'Timestamp', UUID: 'string' };

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

/**
 * The invariants that the constructor of an ID or domain primitive checks: on a `UUID` base, the generated `'uuid'`
 * first (the form the other invariants assume), then those of the model (none is named `uuid`, M002).
 */
export const primitiveInvariants = (p: DomainPrimitive): readonly InvariantModel[] => (p.base === 'UUID' ? [UUID_INVARIANT, ...p.invariants] : p.invariants);

/** Every invariant of an aggregate: its own, then those of each state (names are unique across them, M002). */
export const aggregateInvariants = (agg: AggregateModel): InvariantModel[] => [...agg.invariants, ...agg.states.flatMap((s) => s.invariants)];

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

/** The base primitive of a scalar type, if it is one. */
function primOf(t: Ty): PrimitiveName | undefined {
    if (t.k === 'prim') return t.name;
    if (t.k === 'dp') return t.el.base;
    return undefined;
}

const strip = (t: Ty): Ty => (t.k === 'opt' ? t.inner : t);

/** A number for `<`, `==`, ranges: Decimals are carried as strings, Timestamps as Dates. */
function scalar(b: Binding): string {
    const t = strip(b.ty); // an optional value is guarded by exists(...) (M009)
    const p = primOf(t);
    if (p === 'Timestamp') return `${b.js}.getTime()`;
    return b.js;
}

const isDecimal = (b: Binding): boolean => primOf(strip(b.ty)) === 'Decimal';
const compare = (a: Binding, b: Binding, op: string): string =>
    isDecimal(a) || isDecimal(b) ? `decimalCompare(String(${a.js}), String(${b.js})) ${op} 0` : `${scalar(a)} ${op} ${scalar(b)}`;

export class ExprCompiler {
    /** Counter of temporaries (`$0`, `$1`, …), which no DSL name can collide with. */
    private temp = 0;
    /** The parameters of the check the expression being compiled is in (see `violated`). */
    private params: readonly string[] = [];
    /** Names a lambda variable must not take in this module, other than those of the scope. */
    private readonly notLambda: ReadonlySet<string>;

    constructor(private readonly env: CheckEnv) {
        const { model, ctx } = env;
        // the other contexts are imported as namespaces, and the equality of this context's types is called by name
        const equalities = elementsIn(model, ctx)
            .filter((el) => el.kind === 'valueObject' || el.kind === 'entity' || el.kind === 'union')
            .map((el) => equalName(el));
        this.notLambda = new Set([...NOT_LAMBDA_NAMES, ...contextNames(model), ...equalities]);
    }

    /**
     * The condition under which `e`, an invariant or a requirement, is violated: `!(e)`, or `A && !B` for an implication
     * `A implies B` (ADR 0028), which is the same condition without the double negation. `params` are the parameters of
     * the check it is in, which lambda variables do not shadow.
     */
    violated(e: ExprModel, scope: Scope, params: readonly string[]): string {
        this.params = params;
        if (e.k === 'binary' && e.op === 'implies') return `${andOperand(this.compile(e.left, scope))} && ${negate(this.compile(e.right, scope))}`;
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
        if (pa === 'Timestamp') return `${a}.getTime() === ${b}.getTime()`;
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

    compile(e: ExprModel, scope: Scope): Binding {
        const bool = (js: string): Binding => ({ js, ty: { k: 'prim', name: 'Bool' } });
        /** `(js)`; `loose` when `js` is a `||` at the top. */
        const wrapped = (js: string, loose = false): Binding => ({ ...bool(`(${js})`), wrapped: true, inner: js, tight: !loose });
        /** The body of an arrow function, which needs no parentheses. */
        const body = (b: Binding): string => b.inner ?? b.js;
        switch (e.k) {
            case 'bool':
                return bool(String(e.value));
            case 'int':
                return { js: e.value < 0 ? `(${e.value})` : String(e.value), ty: { k: 'prim', name: 'Int', literal: true } };
            case 'decimal':
                return { js: quote(e.value), ty: { k: 'prim', name: 'Decimal', literal: true } };
            case 'string':
                return { js: quote(e.value), ty: { k: 'prim', name: 'String', literal: true } };
            case 'name':
                return this.name(e.name, scope);
            case 'member':
                return this.member(e.receiver, e.member, scope);
            case 'not':
                return bool(negate(this.compile(e.operand, scope)));
            case 'exists':
                return wrapped(`${this.compile(e.operand, scope).js} !== undefined`);
            case 'count':
            case 'length': {
                const value = this.compile(e.k === 'count' ? e.collection : e.operand, scope);
                return { js: e.k === 'length' ? `Array.from(${value.js}).length` : `${value.js}.length`, ty: { k: 'prim', name: 'Int' } };
            }
            case 'matches':
                return bool(`${regex(e.pattern)}.test(${this.compile(e.operand, scope).js})`);
            case 'range': {
                const v = this.compile(e.operand, scope);
                const lo = this.compile(e.lower, scope);
                const hi = this.compile(e.upper, scope);
                return wrapped(`${compare(lo, v, '<=')} && ${compare(v, hi, '<=')}`);
            }
            case 'quantifier': {
                const c = this.compile(e.collection, scope);
                const elem = c.ty.k === 'list' ? c.ty.elem : c.ty;
                const p = this.lambdaName(e.param, scope);
                const b = this.compile(e.body, new Map([...scope, [e.param, { js: p, ty: elem }]]));
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
                const left = new Map([...scope, [e.param, { js: a, ty: elem }]]);
                const right = new Map([...scope, [e.param, { js: b, ty: elem }]]);
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
                        return wrapped(this.equal(strip(l.ty), l.js, r.js, strip(r.ty)));
                    case 'ne':
                        return bool(`!(${this.equal(strip(l.ty), l.js, r.js, strip(r.ty))})`);
                    case 'lt':
                    case 'le':
                    case 'gt':
                    case 'ge':
                        return wrapped(compare(l, r, BINARY_OP_TEXT[e.op]));
                }
            }
        }
    }

    private name(name: string, scope: Scope): Binding {
        const bound = scope.get(name);
        if (bound) return bound;
        const { model, ctx } = this.env;
        const visible = [ctx, ...sharedContexts(model)].map((c) => elementOf(model, `${c}.${name}`)).find((el) => el?.kind === 'enum' || el?.kind === 'union');
        if (visible?.kind === 'enum') return { js: '', ty: { k: 'enumType', el: visible } };
        if (visible?.kind === 'union') return { js: '', ty: { k: 'unionType', el: visible } };
        if (contextNames(model).some((c) => c === name)) return { js: '', ty: { k: 'ctx', name } };
        throw new Error(`cannot resolve '${name}'`);
    }

    private member(receiver: ExprModel, m: string, scope: Scope): Binding {
        const r = this.compile(receiver, scope);
        const t = strip(r.ty); // an optional receiver is guarded by exists(...) (M009)
        switch (t.k) {
            case 'ctx': {
                const el = elementOf(this.env.model, `${t.name}.${m}`);
                if (el?.kind === 'enum') return { js: '', ty: { k: 'enumType', el } };
                if (el?.kind === 'union') return { js: '', ty: { k: 'unionType', el } };
                throw new Error(`no enum or union '${t.name}.${m}'`);
            }
            case 'enumType':
            case 'unionType':
                return { js: quote(m), ty: { k: 'enum' } };
            case 'union':
                return { js: `${r.js}.${m}`, ty: { k: 'enum' } }; // only the discriminator is accessible (M009)
            case 'struct': {
                const f = t.el.fields.find((x) => x.name === m);
                if (!f) throw new Error(`'${t.el.name}' has no field '${m}'`);
                return { js: `${r.js}.${m}`, ty: fieldTy(this.env.model, f) };
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
    return new Map(fields.map((f) => [f.name, { js: `${subject}.${f.name}`, ty: fieldTy(model, f) }]));
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
    for (const p of c.params) scope.set(p.name, { js: `${params}.${p.name}`, ty: fieldTy(model, p) });
    return scope;
}

interface Param {
    name: string;
    type: string;
}

/** The states a named command can actually receive, preserving kind–state restrictions in generated checks. */
function namedSubjectType(agg: AggregateModel, c: CommandModel): string {
    if (!agg.states.length) return agg.name;
    if (!agg.lifecycleField) {
        const sources = [
            ...new Set(
                [...c.outcomes, ...agg.groups.flatMap((g) => g.cases.filter((x) => x.command === c.name).flatMap((x) => x.outcomes))].flatMap((o) => o.from),
            ),
        ];
        return sources.map((from) => stateTypeName(agg, from)).join(' | ') || 'never';
    }
    const pairs = agg.validStates.flatMap(({ kind }) =>
        applicableOutcomes(agg, c, kind).flatMap((o) => o.from.map((from) => `${kind}${stateTypeName(agg, from)}`)),
    );
    return [...new Set(pairs)].join(' | ') || 'never';
}

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
        const outcomes = [...c.outcomes, ...agg.groups.flatMap((g) => g.cases.filter((x) => x.command === c.name).flatMap((x) => x.outcomes))];
        if (!outcomes.length) return [];
        const external = outcomes.filter((o) => o.select?.kind === 'external');
        const subject = aggregateParamName(agg);
        const parameters = paramsArgName(agg);
        const args = [
            ...(c.factory ? [] : [{ name: subject, type: namedSubjectType(agg, c) }]),
            ...(c.params.length ? [{ name: parameters, type: paramsTypeName(agg, c) }] : []),
        ];
        const signature = args.map((a) => `${a.name}: ${a.type}`).join(', ');
        const lines = [
            `export type ${choiceChecksTypeName(agg, c)} = { ${external.map((o) => `readonly ${o.name}: (${signature}) => boolean`).join('; ')} };`,
            '',
        ];
        const choices = outcomes.map((o) => {
            const choice = o.select;
            const first = agg.states.find((state) => state.name === o.from[0]);
            const scope = c.factory ? new Map<string, Binding>() : fieldScope(this.env.model, subject, [...agg.fields, ...(first?.fields ?? [])]);
            for (const p of c.params) scope.set(p.name, { js: `${parameters}.${p.name}`, ty: fieldTy(this.env.model, p) });
            const code =
                choice?.kind === 'expression'
                    ? this.compiler.compile(choice.expr, scope).js
                    : choice?.kind === 'external'
                      ? `checks.${o.name}(${args.map((a) => a.name).join(', ')})`
                      : 'true';
            const group = agg.groups.find((g) => g.cases.some((x) => x.command === c.name && x.outcomes.includes(o)));
            const guards = c.factory
                ? []
                : [
                      ...(agg.states.length ? [matchesAny(subject, 'state', o.from)] : []),
                      ...(group && agg.lifecycleField ? [matchesAny(subject, agg.lifecycleField, group.values)] : []),
                  ].filter((guard): guard is string => guard !== undefined);
            return `${o.name}: ${guards.length ? `(${guards.map((guard) => `(${guard})`).join(' && ')}) && (` : ''}${code}${guards.length ? ')' : ''}`;
        });
        const body = `return { ${choices.join(', ')} };`;
        lines.push(
            `export function ${choiceCheckName(agg, c)}(checks: ${choiceChecksTypeName(agg, c)}): (${signature}) => { ${outcomes.map((o) => `readonly ${o.name}: boolean`).join('; ')} } {`,
        );
        lines.push(`    return (${params(args, body)}) => { ${body} };`);
        lines.push('}');
        return lines;
    }

    /** Common requirements followed by matching `on` requirements in source order. */
    namedRequirements(agg: AggregateModel, c: CommandModel): string[] {
        const groups = agg.groups.flatMap((g, i) => g.cases.filter((x) => x.command === c.name).map((x) => ({ group: g, index: i, case: x })));
        if (!c.requires.length && !groups.some((g) => g.case.requires.length)) return [];
        const type = commandTypeName(agg, c);
        const subject = aggregateParamName(agg);
        const parameters = paramsArgName(agg);
        const args = [
            ...(c.factory ? [] : [{ name: subject, type: namedSubjectType(agg, c) }]),
            ...(c.params.length ? [{ name: parameters, type: paramsTypeName(agg, c) }] : []),
        ];
        const sig = args.map((a) => `${a.name}: ${a.type}`).join(', ');
        const names = args.map((a) => a.name).join(', ');
        const allSources = [...c.outcomes, ...groups.flatMap((g) => g.case.outcomes)].flatMap((o) => o.from);
        const entries = [
            ...c.requires.map((r) => ({ requirement: r, key: r.name, group: undefined as (typeof groups)[number] | undefined, sources: allSources })),
            ...groups.flatMap((g) =>
                g.case.requires.map((r) => ({ requirement: r, key: `group${g.index}_${r.name}`, group: g, sources: g.case.outcomes.flatMap((o) => o.from) })),
            ),
        ];
        const external = entries.filter(({ requirement }) => !requirement.expr);
        const union = [...new Set(entries.map((e) => e.key))].map((x) => `'${x}'`).join(' | ');
        const lines: string[] = [];
        if (external.length) {
            lines.push(`export type ${declaredRequiresName(type)} = { ${external.map((x) => `readonly ${x.key}: (${sig}) => boolean`).join('; ')} };`, '');
        }
        const body = entries.map(({ requirement, key, group, sources }) => {
            const first = agg.states.find((state) => state.name === sources[0]);
            const scope = c.factory ? new Map<string, Binding>() : fieldScope(this.env.model, subject, [...agg.fields, ...(first?.fields ?? [])]);
            for (const p of c.params) scope.set(p.name, { js: `${parameters}.${p.name}`, ty: fieldTy(this.env.model, p) });
            const holds = requirement.expr ? this.compiler.compile(requirement.expr, scope).js : `checks.${key}(${names})`;
            const check = `if (!(${holds})) return '${key}';`;
            if (!group) return check;
            if (c.factory || !agg.lifecycleField) return check;
            const guards = [matchesAny(subject, agg.lifecycleField, group.group.values), matchesAny(subject, 'state', sources)].filter(
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
        const scope: Scope = new Map([['value', { js: 'value', ty: { k: 'prim', name: p.base } }]]);
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
