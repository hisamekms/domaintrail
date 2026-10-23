import type { CommandModel, DomainModel, ElementModel, ExprModel, FieldModel, InvariantModel, Location, PrimitiveName } from '../model/model.js';
import { camel, invalidTypeName, makeTypeName, stateTypeName } from './naming.js';

/**
 * Generated checks (ADR 0020): invariant and requirement expressions translated 1:1 into TypeScript, and the equality
 * of ADR 0016 per value object, entity and union. Pure functions over the generated types; an invariant or requirement
 * without an expression becomes a slot (`…DeclaredChecks`) that the user's code fills in.
 */

/** The type of a value in an expression, resolved against the Typed Model. */
export type Ty =
    | { k: 'prim'; name: PrimitiveName; literal?: boolean }
    /** An ID or domain primitive. */
    | { k: 'dp'; el: ElementModel }
    /** An enum value, or the discriminator of a union (both are strings). */
    | { k: 'enum' }
    | { k: 'struct'; el: ElementModel }
    | { k: 'union'; el: ElementModel }
    | { k: 'list'; elem: Ty }
    | { k: 'opt'; inner: Ty }
    | { k: 'enumType'; el: ElementModel }
    | { k: 'unionType'; el: ElementModel }
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
}

type Scope = Map<string, Binding>;

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
export const hasDeclared = (invs: { expr?: ExprModel }[]): boolean => invs.some((i) => !i.expr);

/** Every invariant of an aggregate: its own, then those of each state (names are unique across them, M002). */
export const aggregateInvariants = (agg: ElementModel): InvariantModel[] => [...agg.invariants, ...(agg.states ?? []).flatMap((s) => s.invariants)];

/** Every invariant of a union: those of each variant. */
export const unionInvariants = (u: ElementModel): InvariantModel[] => (u.variants ?? []).flatMap((v) => v.invariants);

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
    const el = model.elements[f.type.ref];
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
        default:
            throw new Error(`no value type for field '${f.name}'`);
    }
}

/** The base primitive of a scalar type, if it is one. */
function primOf(t: Ty): PrimitiveName | undefined {
    if (t.k === 'prim') return t.name;
    if (t.k === 'dp') return t.el.base ?? 'String';
    return undefined;
}

const strip = (t: Ty): Ty => (t.k === 'opt' ? t.inner : t);

/** A number for `<`, `==`, ranges: Decimals are carried as strings, Timestamps as Dates. */
function scalar(b: Binding): string {
    const t = strip(b.ty); // an optional value is guarded by exists(...) (M009)
    const p = primOf(t);
    if (p === 'Decimal' && !(t.k === 'prim' && t.literal)) return `Number(${b.js})`;
    if (p === 'Timestamp') return `${b.js}.getTime()`;
    return b.js;
}

export class ExprCompiler {
    /** Counter of temporaries (`$0`, `$1`, …), which no DSL name can collide with. */
    private temp = 0;

    constructor(private readonly env: CheckEnv) {}

    /** `a == b` by the equality of ADR 0016, for two values of type `t` (and `u` on the right, for numbers). */
    equal(t: Ty, a: string, b: string, u: Ty = t): string {
        const s = strip(t);
        if (t.k === 'opt') return `sameOptional(${a}, ${b}, ${this.equalFn(t.inner)})`;
        if (t.k === 'list') return `sameList(${a}, ${b}, ${this.equalFn(t.elem)})`;
        if (s.k === 'struct' || s.k === 'union') return `${this.env.valueRef(s.el.id, equalName(s.el))}(${a}, ${b})`;
        const pa = primOf(s);
        const pb = primOf(strip(u));
        if (pa === 'Decimal' || pb === 'Decimal') return `${scalar({ js: a, ty: t })} === ${scalar({ js: b, ty: u })}`;
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
        switch (e.k) {
            case 'bool':
                return bool(String(e.value));
            case 'int':
                return { js: e.value < 0 ? `(${e.value})` : String(e.value), ty: { k: 'prim', name: 'Int', literal: true } };
            case 'decimal':
                return { js: e.value.startsWith('-') ? `(${e.value})` : e.value, ty: { k: 'prim', name: 'Decimal', literal: true } };
            case 'string':
                return { js: JSON.stringify(e.value), ty: { k: 'prim', name: 'String', literal: true } };
            case 'name':
                return this.name(e.name, scope);
            case 'member':
                return this.member(e.receiver, e.member, scope);
            case 'not':
                return bool(`!${this.compile(e.operand, scope).js}`);
            case 'exists':
                return bool(`(${this.compile(e.operand, scope).js} !== undefined)`);
            case 'count':
            case 'length':
                return { js: `${this.compile(e.k === 'count' ? e.collection : e.operand, scope).js}.length`, ty: { k: 'prim', name: 'Int' } };
            case 'matches':
                return bool(`${regex(e.pattern)}.test(${this.compile(e.operand, scope).js})`);
            case 'range': {
                const v = this.compile(e.operand, scope);
                const lo = this.compile(e.lower, scope);
                const hi = this.compile(e.upper, scope);
                return bool(`(${scalar(lo)} <= ${scalar(v)} && ${scalar(v)} <= ${scalar(hi)})`);
            }
            case 'quantifier': {
                const c = this.compile(e.collection, scope);
                const elem = c.ty.k === 'list' ? c.ty.elem : c.ty;
                const p = `$${e.param}`;
                const body = this.compile(e.body, new Map([...scope, [e.param, { js: p, ty: elem }]]));
                return bool(`${c.js}.${e.quantifier === 'all' ? 'every' : 'some'}((${p}) => ${body.js})`);
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
                // the keys of two elements: the parameter as `$x` and as `$x$`
                const [a, b] = [`$${e.param}`, `$${e.param}$`];
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
                        return bool(`(${l.js} && ${r.js})`);
                    case 'or':
                        return bool(`(${l.js} || ${r.js})`);
                    case 'implies':
                        return bool(`(!${l.js} || ${r.js})`);
                    case '==':
                        return bool(`(${this.equal(strip(l.ty), l.js, r.js, strip(r.ty))})`);
                    case '!=':
                        return bool(`!(${this.equal(strip(l.ty), l.js, r.js, strip(r.ty))})`);
                    default:
                        return bool(`(${scalar(l)} ${e.op} ${scalar(r)})`);
                }
            }
        }
    }

    private name(name: string, scope: Scope): Binding {
        const bound = scope.get(name);
        if (bound) return bound;
        const { model, ctx } = this.env;
        const visible = [ctx, ...model.sharedContexts].map((c) => model.elements[`${c}.${name}`]).find((el) => el?.kind === 'enum' || el?.kind === 'union');
        if (visible?.kind === 'enum') return { js: '', ty: { k: 'enumType', el: visible } };
        if (visible?.kind === 'union') return { js: '', ty: { k: 'unionType', el: visible } };
        if (model.contexts.includes(name)) return { js: '', ty: { k: 'ctx', name } };
        throw new Error(`cannot resolve '${name}'`);
    }

    private member(receiver: ExprModel, m: string, scope: Scope): Binding {
        const r = this.compile(receiver, scope);
        const t = strip(r.ty); // an optional receiver is guarded by exists(...) (M009)
        switch (t.k) {
            case 'ctx': {
                const el = this.env.model.elements[`${t.name}.${m}`];
                return { js: '', ty: el.kind === 'enum' ? { k: 'enumType', el } : { k: 'unionType', el } };
            }
            case 'enumType':
            case 'unionType':
                return { js: JSON.stringify(m), ty: { k: 'enum' } };
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

/** A regular expression literal for a pattern written as in JavaScript; `new RegExp(…)` when a literal cannot hold it. */
function regex(pattern: string): string {
    if (pattern === '' || /[\n\r\u2028\u2029]/.test(pattern) || /(^|[^\\])(\\\\)*\//.test(pattern)) return `new RegExp(${JSON.stringify(pattern)})`;
    return `/${pattern}/`;
}

/** A scope with the fields of an element, read from `subject`. */
export function fieldScope(model: DomainModel, subject: string, fields: FieldModel[]): Scope {
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
    /** The compiled condition; absent for an invariant declared without an expression. */
    js?: string;
    /** For a declared invariant: the arguments its slot takes. */
    args?: string;
    /** Wraps the statement, e.g. `if (x.kind === 'Card') { … }` for the invariants of a union variant. */
    guard?: string;
}

/** The statements that collect the violated invariants of `items` into `violated`. */
export function collect(items: CheckItem[], indent: string): string[] {
    return items.map((i) => {
        const cond = i.js ?? `checks.${i.name}(${i.args})`;
        return `${indent}if (${i.guard ? `${i.guard} && ` : ''}!(${cond})) violated.push('${i.name}');`;
    });
}

/** Compiles the expressed invariants among `invs` in `scope`; declared ones call their slot with `args`. */
export function items(compiler: ExprCompiler, invs: InvariantModel[], scope: Scope, args: string, guard?: string): CheckItem[] {
    return invs.map((i) => ({ name: i.name, ...(i.expr ? { js: compiler.compile(i.expr, scope).js } : { args }), ...(guard && { guard }) }));
}

/** The requirement scope of a command: the aggregate's fields it sees (from `subject`) and its parameters. */
export function requirementScope(model: DomainModel, agg: ElementModel, c: CommandModel, subject: string): Scope {
    const states = agg.states ?? [];
    const sources = [...new Set(c.transitions.flatMap((t) => t.from))];
    const first = states.find((s) => s.name === sources[0]);
    const fields = c.factory ? [] : [...agg.fields, ...(first?.fields ?? [])];
    const scope = fieldScope(model, subject, fields);
    for (const p of c.params) scope.set(p.name, { js: p.name, ty: fieldTy(model, p) });
    return scope;
}

interface Param {
    name: string;
    type: string;
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

    /**
     * A check function: `check<T>(subject)` returning the violated invariants, or with declared invariants
     * `check<T>With(checks)` returning that function. `body` collects into `violated` (or returns the result itself).
     */
    private checkFunction(doc: string[], loc: Location, typeName: string, subject: Param, result: string, declared: string | false, body: string[]): string[] {
        const text = body.join('\n');
        const head = this.env.jsdoc(doc, loc);
        const collects = text.includes('violated.push');
        const inner = collects ? [`const violated: ${list(result)}[] = [];`, ...body, 'return violated;'] : body;
        if (!declared) {
            return [...head, `export function ${checkName(typeName)}(${params([subject], text)}): readonly ${list(result)}[] {`, ...inner.map((l) => `    ${l}`), '}'];
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
            ...this.env.jsdoc([`The invariants of ${typeName} that the DSL does not express: implement them in your code and pass them to \`${checkWithName(typeName)}\`.`], loc),
            `export type ${declaredChecksName(typeName)} = { ${members.join('; ')} };`,
            '',
        ];
    }

    /** A domain primitive (or ID): its check and its generated constructor `make<Name>`. */
    primitive(p: ElementModel): string[] {
        const base = BASE[p.base ?? 'String'];
        const type = p.name;
        if (p.invariants.length === 0) {
            return [
                ...this.env.jsdoc([`Creates a ${p.name}: it has no invariants, so every value is one.`], p.location),
                `export const ${makeName(p)}: ${makeTypeName(p)} = (value) => value as ${type};`,
            ];
        }
        const scope: Scope = new Map([['value', { js: 'value', ty: { k: 'prim', name: p.base ?? 'String' } }]]);
        const declared = hasDeclared(p.invariants);
        const result = `${invalidTypeName(p)}['invariant']`;
        const out: string[] = [];
        if (declared) out.push(...this.declaredType(type, p.location, p.invariants.filter((i) => !i.expr).map((i) => ({ name: i.name, args: `value: ${base}` }))));
        out.push(
            ...this.checkFunction(
                [`The invariants of ${p.name} that a value violates, in declaration order; empty when it is a ${p.name}.`],
                p.location,
                type,
                { name: 'value', type: base },
                result,
                declared && type,
                collect(items(this.compiler, p.invariants, scope, 'value'), ''),
            ),
            '',
        );
        const make = (check: string, indent: string): string[] =>
            [
                `(value) => {`,
                `    const [invariant] = ${check}(value);`,
                `    if (invariant === undefined) return ok(value as ${type});`,
                `    return err({ type: '${invalidTypeName(p)}', value, invariant });`,
                `}`,
            ].map((l, i) => (i === 0 ? l : `${indent}${l}`));
        if (!declared) {
            out.push(
                ...this.env.jsdoc([`Creates a ${p.name}, checking its invariants with \`${checkName(type)}\`: the first one violated is reported.`], p.location),
                `export const ${makeName(p)}: ${makeTypeName(p)} = ${make(checkName(type), '').join('\n')};`,
            );
        } else {
            out.push(
                ...this.env.jsdoc([`Creates a ${p.name} constructor from the invariants the DSL does not express; the first invariant violated is reported.`], p.location),
                `export const ${makeWithName(p)} = (checks: ${declaredChecksName(type)}): ${makeTypeName(p)} => {`,
                `    const check = ${checkWithName(type)}(checks);`,
                `    return ${make('check', '    ').join('\n')};`,
                `};`,
            );
        }
        return out;
    }

    /** The equality of a value object (all fields), an entity (`id`) or a union (discriminator and fields). */
    equality(el: ElementModel): string[] {
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
            const tag = el.discriminator ?? 'kind';
            doc = `Whether two ${type} values are equal: by \`${tag}\` and the fields of the variant (ADR 0016).`;
            body = [`if (a.${tag} !== b.${tag}) return false;`];
            for (const v of el.variants ?? []) {
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
            `export function ${equalName(el)}(${params([{ name: 'a', type }, { name: 'b', type }], text)}): boolean {`,
            ...body.map((l) => `    ${l}`),
            '}',
        ];
    }

    /** The check of a value object or entity. */
    struct(el: ElementModel): string[] {
        if (!el.invariants.length) return [];
        const subject = subjectName(el.name);
        const scope = fieldScope(this.env.model, subject, el.fields);
        const declared = hasDeclared(el.invariants);
        return [
            ...(declared ? this.declaredType(el.name, el.location, el.invariants.filter((i) => !i.expr).map((i) => ({ name: i.name, args: `${subject}: ${el.name}` }))) : []),
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
    union(u: ElementModel): string[] {
        const all = unionInvariants(u);
        if (!all.length) return [];
        const tag = u.discriminator ?? 'kind';
        const subject = subjectName(u.name);
        const declared = hasDeclared(all);
        const body: CheckItem[] = [];
        const slots: { name: string; args: string }[] = [];
        for (const v of u.variants ?? []) {
            const guard = `${subject}.${tag} === '${v.name}'`;
            body.push(...items(this.compiler, v.invariants, fieldScope(this.env.model, subject, v.fields), subject, guard));
            for (const i of v.invariants.filter((x) => !x.expr)) slots.push({ name: i.name, args: `${subject}: Extract<${u.name}, { readonly ${tag}: '${v.name}' }>` });
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

    /** The checks of an aggregate: per state (the aggregate's invariants and the state's), and for any state. */
    aggregate(agg: ElementModel): string[] {
        const all = aggregateInvariants(agg);
        if (!all.length) return [];
        const subject = subjectName(agg.name);
        const states = agg.states ?? [];
        const declared = hasDeclared(all);
        const model = this.env.model;
        const slotArgs = (stateType: string) => `${subject}: ${stateType}`;
        const out: string[] = [];
        if (declared) {
            const slots = [
                ...agg.invariants.filter((i) => !i.expr).map((i) => ({ name: i.name, args: slotArgs(agg.name) })),
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
        for (const s of states) {
            const type = stateTypeName(agg, s);
            const scope = fieldScope(model, subject, [...agg.fields, ...s.fields]);
            out.push(
                ...this.checkFunction(
                    [`The invariants of ${agg.name} in state ${s.name} (the aggregate's and the state's) that an aggregate violates, in declaration order.`],
                    s.location,
                    type,
                    { name: subject, type },
                    namesType([...agg.invariants, ...s.invariants].map((i) => i.name)),
                    declared && agg.name,
                    collect(items(this.compiler, [...agg.invariants, ...s.invariants], scope, subject), ''),
                ),
                '',
            );
        }
        const call = (s: { name: string }): string => (declared ? `${checkWithName(stateTypeName(agg, s))}(checks)(${subject})` : `${checkName(stateTypeName(agg, s))}(${subject})`);
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
     * `subject` is the aggregate parameter (absent for a factory), `ps` the command's parameters as in its contract.
     */
    requires(agg: ElementModel, c: CommandModel, typeName: string, subject: Param | undefined, ps: Param[]): string[] {
        if (!c.requires.length) return [];
        const scope = requirementScope(this.env.model, agg, c, subject?.name ?? '');
        const args = [...(subject ? [subject] : []), ...ps];
        const argNames = args.map((a) => a.name).join(', ');
        const declared = hasDeclared(c.requires);
        const result = `${namesType(c.requires.map((r) => r.name))} | undefined`;
        const body = [
            ...c.requires.map((r) => `if (!(${r.expr ? this.compiler.compile(r.expr, scope).js : `checks.${r.name}(${argNames})`})) return '${r.name}';`),
            'return undefined;',
        ];
        const text = body.join('\n');
        const doc = [`The first requirement of ${agg.name}.${c.name} that does not hold, in declaration order; \`undefined\` when all hold.`];
        if (!declared) {
            return [...this.env.jsdoc(doc, c.location), `export function ${requiresName(typeName)}(${params(args, text)}): ${result} {`, ...body.map((l) => `    ${l}`), '}'];
        }
        const sig = args.map((a) => `${a.name}: ${a.type}`).join(', ');
        return [
            ...this.env.jsdoc([`The requirements of ${agg.name}.${c.name} that the DSL does not express: implement them in your code and pass them to \`${requiresWithName(typeName)}\`.`], c.location),
            `export type ${declaredRequiresName(typeName)} = { ${c.requires.filter((r) => !r.expr).map((r) => `readonly ${r.name}: (${sig}) => boolean`).join('; ')} };`,
            '',
            ...this.env.jsdoc(doc, c.location),
            `export function ${requiresWithName(typeName)}(checks: ${declaredRequiresName(typeName)}): (${sig}) => ${result} {`,
            `    return (${params(args.map((a) => ({ name: a.name, type: '' })), text).replace(/: (?=,|$)/g, '')}) => {`,
            ...body.map((l) => `        ${l}`),
            '    };',
            '}',
        ];
    }
}
