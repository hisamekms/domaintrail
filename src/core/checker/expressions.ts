import {
    isAggregate,
    isBinaryExpr,
    isBoolLiteral,
    isContainsExpr,
    isCountExpr,
    isDecimalLiteral,
    isEnumDecl,
    isExistsExpr,
    isIdType,
    isIntLiteral,
    isInvariant,
    isLengthExpr,
    isMatchesExpr,
    isMemberAccess,
    isPrimitiveDecl,
    isRangeExpr,
    isNameRef,
    isNotExpr,
    isQuantifierExpr,
    isRequirement,
    isEntity,
    isStringLiteral,
    isUniqueExpr,
    isUnionDecl,
    isValueObject,
    type Aggregate,
    type Command,
    type DataMember,
    type EnumDecl,
    type Expression,
    type Invariant,
    type MatchesExpr,
    type Parameter,
    type Requirement,
    type State,
    type UnionDecl,
} from '../../language/generated/ast.js';
import { GrammarUtils, type AstNode } from 'langium';
import { docComment } from '../labels.js';
import type { DiagnosticSink } from '../diagnostics.js';
import { didYouMean, suggestFrom, type Candidate } from '../suggest.js';
import {
    commandsOf,
    commonFields,
    discriminatorOf,
    fieldsOf,
    includedFields,
    invariantsOf,
    primitiveInvariants,
    statesOf,
    type DomainPrimitive,
    type FieldLike,
    type ModelIndex,
} from '../model-index.js';
import { BOOL, COMPUTED_INT, ERROR, basePrimitive, isBool, isDomainPrimitive, isNumeric, memberType, sameType, showType, type Ty } from '../types.js';

interface Scope {
    ctx: string;
    /** Fields (and the parameters of a command) visible in this invariant or requirement. */
    fields: Map<string, FieldLike | Parameter>;
    /** M010 diagnostics for fields of the aggregate that exist but are not in scope here, by name. */
    hidden: Map<string, Hidden>;
    /** Lambda parameters, innermost last. */
    lambdas: Array<[string, Ty]>;
    /** Paths proven present by an enclosing `exists(...)` guard. */
    present: Set<string>;
}

interface Hidden {
    message: string;
    hint: string;
}

/** Type-checks every invariant and command requirement in the workspace (M001 for names, M008, M009, M010, M018, M019). */
export function checkInvariants(index: ModelIndex, sink: DiagnosticSink): void {
    for (const el of index.elements) {
        const ctx = el.$container.name;
        if (isAggregate(el)) {
            checkAggregate(el, ctx, index, sink);
        } else if (isEntity(el) || isValueObject(el)) {
            const members: DataMember[] = el.members;
            const fields = new Map([...includedFields(el).map((x) => x.field), ...fieldsOf(members)].map((f) => [f.name, f]));
            for (const inv of invariantsOf(members)) {
                checkInvariant(inv, { ctx, fields, hidden: new Map(), lambdas: [], present: new Set() }, index, sink);
            }
        } else if (isUnionDecl(el)) {
            // Variant invariants see the fields of their own variant.
            for (const v of el.variants) {
                const fields = new Map(fieldsOf(v.members).map((f) => [f.name, f]));
                for (const inv of invariantsOf(v.members)) {
                    checkInvariant(inv, { ctx, fields, hidden: new Map(), lambdas: [], present: new Set() }, index, sink);
                }
            }
        } else if (isIdType(el) || isPrimitiveDecl(el)) {
            checkPrimitive(el, ctx, index, sink);
        }
    }
}

/** Type of a union's discriminator and of its tags: the bound enum, or the union's own tag type. */
function tagOf(u: UnionDecl): Ty {
    const bound = u.tagType?.ref;
    if (u.tagType && !bound) return ERROR; // unresolved, reported as M001
    return bound ? { k: 'enum', decl: bound } : { k: 'tag', decl: u };
}

/** Domain primitive invariants see a single name, `value`, of the base primitive type. */
function checkPrimitive(p: DomainPrimitive, ctx: string, index: ModelIndex, sink: DiagnosticSink): void {
    if (!p.base) return;
    for (const inv of primitiveInvariants(p)) {
        if (isInvariant(inv.node)) checkDeclared(inv.node, sink);
        if (!inv.expr) continue;
        const scope: Scope = { ctx, fields: new Map(), hidden: new Map(), lambdas: [['value', { k: 'prim', name: p.base }]], present: new Set() };
        const t = new ExprChecker(index, sink).check(inv.expr, scope);
        if (t.k !== 'error' && !isBool(t)) {
            const what = inv.node === inv.expr ? `The constraint of '${p.name}'` : `Invariant '${inv.name}'`;
            sink.error('M008', `${what} must be a Bool expression, but has type '${showType(t)}'.`, inv.expr);
        }
    }
}

function checkAggregate(agg: Aggregate, ctx: string, index: ModelIndex, sink: DiagnosticSink): void {
    // fields taken from field sets are common fields too
    const common = new Map([...includedFields(agg).map((x) => x.field), ...commonFields(agg)].map((f) => [f.name, f]));
    const states = statesOf(agg);
    const stateOnly = (except?: string): Map<string, Hidden> =>
        new Map(
            [...statesHaving(states, common, except)].map(([name, where]) => [
                name,
                {
                    message: `Field '${name}' exists only in state ${quoted(where)} and is not in scope here.`,
                    hint: `move the field to the common fields of '${agg.name}', or use it only in the invariants of state ${quoted(where)}`,
                },
            ]),
        );

    // Aggregate-level invariants: common fields only, applied to every state.
    for (const inv of invariantsOf(agg.members)) {
        checkInvariant(inv, { ctx, fields: common, hidden: stateOnly(), lambdas: [], present: new Set() }, index, sink);
    }
    // State-level invariants: common + that state's own fields.
    for (const s of states) {
        const fields = new Map(common);
        for (const f of fieldsOf(s.members)) fields.set(f.name, f);
        const hidden = stateOnly(s.name);
        for (const name of fields.keys()) hidden.delete(name);
        for (const inv of invariantsOf(s.members)) {
            checkInvariant(inv, { ctx, fields, hidden, lambdas: [], present: new Set() }, index, sink);
        }
    }
    for (const cmd of commandsOf(agg)) {
        if (cmd.requirements.length) checkRequirements(agg, cmd, common, ctx, index, sink);
    }
}

/** Fields of the states (other than `except`) that are not common fields, with the states that have each. */
function statesHaving(states: State[], common: Map<string, FieldLike>, except?: string): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const s of states) {
        if (s.name === except) continue;
        for (const f of fieldsOf(s.members)) {
            if (common.has(f.name)) continue;
            m.set(f.name, [...(m.get(f.name) ?? []), s.name]);
        }
    }
    return m;
}

const quoted = (names: string[]): string => names.map((n) => `'${n}'`).join(', ');

/**
 * Requirements (`requires`) see the command's parameters and the aggregate's current data: its common fields, plus
 * the fields every source state has with the same name and type. A factory sees its parameters only, an aggregate
 * without states all its fields. M019: a parameter is not named like a field its requirements see.
 */
function checkRequirements(agg: Aggregate, cmd: Command, common: Map<string, FieldLike>, ctx: string, index: ModelIndex, sink: DiagnosticSink): void {
    const states = statesOf(agg);
    const fields = new Map<string, FieldLike | Parameter>();
    const hidden = new Map<string, Hidden>();
    if (cmd.factory) {
        const all = [...common.keys(), ...statesHaving(states, common).keys()];
        for (const name of all) {
            hidden.set(name, {
                message: `Field '${name}' of '${agg.name}' is not in scope: the requirements of a 'create command' see only its parameters.`,
                hint: `pass the value as a parameter of '${cmd.name}', or state the condition as an invariant of '${agg.name}'`,
            });
        }
    } else {
        for (const [name, f] of common) fields.set(name, f);
        const sources = [...new Set(cmd.transitions.flatMap((t) => t.from.map((r) => r.ref)))].filter((s): s is State => !!s);
        const [first, ...rest] = sources;
        for (const f of first ? fieldsOf(first.members) : []) {
            if (common.has(f.name)) continue;
            const t = memberType(f);
            const inAll = rest.every((s) => fieldsOf(s.members).some((g) => g.name === f.name && sameType(memberType(g), t)));
            if (inAll) fields.set(f.name, f);
        }
        for (const [name, where] of statesHaving(states, common)) {
            if (fields.has(name)) continue;
            hidden.set(name, {
                message: `Field '${name}' is in state ${quoted(where)} only; the requirements of command '${cmd.name}' see the fields that every source state has (with the same type).`,
                hint: `declare '${name}' with the same type in every source state of '${cmd.name}' (or among the common fields), or split the command by source state`,
            });
        }
    }
    for (const p of cmd.params) {
        if (p.name && fields.has(p.name)) {
            sink.error(
                'M019',
                `Parameter '${p.name}' of command '${cmd.name}' has the name of a field of '${agg.name}' that its requirements see.`,
                p,
                'name',
                undefined,
                `rename the parameter (e.g. 'new${p.name[0].toUpperCase()}${p.name.slice(1)}'), so that '${p.name}' in a requirement means the field`,
            );
        }
    }
    for (const p of cmd.params) if (p.name) fields.set(p.name, p);

    for (const req of cmd.requirements) {
        checkDeclared(req, sink);
        if (!req.expr) continue;
        const t = new ExprChecker(index, sink).check(req.expr, { ctx, fields, hidden, lambdas: [], present: new Set() });
        if (t.k !== 'error' && !isBool(t)) {
            sink.error('M008', `Requirement '${req.name}' of command '${cmd.name}' must be a Bool expression, but has type '${showType(t)}'.`, req, 'expr');
        }
    }
}

/**
 * M018: an invariant or requirement without an expression is declared for documentation only, so it must say what it
 * requires.
 */
function checkDeclared(x: Invariant | Requirement, sink: DiagnosticSink): void {
    if (x.expr || x.label || docComment(x)) return;
    const what = isRequirement(x) ? 'Requirement' : 'Invariant';
    const keyword = isRequirement(x) ? 'requires' : 'invariant';
    sink.error(
        'M018',
        `${what} '${x.name}' has no expression; give it a label or a /// description that states what it requires.`,
        x,
        'name',
        undefined,
        `write '${keyword} ${x.name} "…"', put a /// line above it, or add an expression in '{ … }'`,
    );
}

function checkInvariant(inv: Invariant, scope: Scope, index: ModelIndex, sink: DiagnosticSink): void {
    checkDeclared(inv, sink);
    if (!inv.expr) return;
    const t = new ExprChecker(index, sink).check(inv.expr, scope);
    if (t.k !== 'error' && !isBool(t)) {
        sink.error('M008', `Invariant '${inv.name}' must be a Bool expression, but has type '${showType(t)}'.`, inv, 'expr');
    }
}

class ExprChecker {
    constructor(
        private readonly index: ModelIndex,
        private readonly sink: DiagnosticSink,
    ) {}

    check(e: Expression, scope: Scope): Ty {
        const t = this.infer(e, scope);
        if (t.k === 'enumType' || t.k === 'unionType' || t.k === 'ctx') {
            this.sink.error('M009', `'${showType(t)}' is not a value.`, e);
            return ERROR;
        }
        return t;
    }

    private infer(e: Expression, scope: Scope): Ty {
        if (isIntLiteral(e)) return { k: 'prim', name: 'Int', literal: true };
        if (isDecimalLiteral(e)) return { k: 'prim', name: 'Decimal', literal: true };
        if (isStringLiteral(e)) return { k: 'prim', name: 'String', literal: true };
        if (isBoolLiteral(e)) return BOOL;
        if (isNameRef(e)) return this.name(e.name, e, scope);
        if (isMemberAccess(e)) return this.member(e, scope);
        if (isNotExpr(e)) {
            const t = this.check(e.operand, scope);
            if (t.k !== 'error' && !isBool(t)) {
                this.sink.error('M009', `Operator 'not' requires Bool, but got '${showType(t)}'.`, e);
            }
            return BOOL;
        }
        if (isCountExpr(e)) {
            const t = this.check(e.collection, scope);
            if (t.k !== 'error' && t.k !== 'list') {
                this.sink.error('M009', `count() requires a collection, but got '${showType(t)}'.`, e, 'collection');
            }
            return COMPUTED_INT;
        }
        if (isExistsExpr(e)) {
            // Evaluate the operand without narrowing so that `exists(x)` checks the declared optionality.
            const t = this.check(e.operand, { ...scope, present: new Set() });
            if (t.k !== 'error' && t.k !== 'opt') {
                this.sink.error('M009', `exists() requires an optional value, but '${showType(t)}' is always present.`, e, 'operand');
            }
            return BOOL;
        }
        if (isLengthExpr(e)) {
            const t = this.check(e.operand, scope);
            if (t.k !== 'error' && !isTextual(t)) {
                this.sink.error('M009', `length() requires a String value, but got '${showType(t)}'.`, e, 'operand');
            }
            return COMPUTED_INT;
        }
        if (isMatchesExpr(e)) {
            const t = this.check(e.operand, scope);
            if (t.k !== 'error' && !isTextual(t)) {
                this.sink.error('M009', `matches() requires a String value, but got '${showType(t)}'.`, e, 'operand');
            }
            const pattern = regexSource(e);
            try {
                new RegExp(pattern);
            } catch (err) {
                const reason = String(err instanceof Error ? err.message : err).replace(/^Invalid regular expression:\s*/, '');
                this.sink.error('M009', `Invalid regular expression "${pattern}": ${reason}`, e, 'pattern');
            }
            return BOOL;
        }
        if (isRangeExpr(e)) {
            const v = this.check(e.operand, scope);
            const lo = this.check(e.lower, scope);
            const hi = this.check(e.upper, scope);
            if (v.k !== 'error' && lo.k !== 'error' && hi.k !== 'error' && !(ordered(v, lo) && ordered(v, hi))) {
                this.sink.error('M009', `Range '${showType(lo)}..${showType(hi)}' cannot be applied to '${showType(v)}'.`, e);
            }
            return BOOL;
        }
        if (isQuantifierExpr(e)) {
            const coll = this.check(e.collection, scope);
            let elem: Ty = ERROR;
            if (coll.k === 'list') elem = coll.elem;
            else if (coll.k !== 'error') {
                this.sink.error('M009', `${e.quantifier}() requires a collection, but got '${showType(coll)}'.`, e, 'collection');
            }
            const inner: Scope = { ...scope, lambdas: [...scope.lambdas, [e.param.name, elem]] };
            const body = this.check(e.body, inner);
            if (body.k !== 'error' && !isBool(body)) {
                this.sink.error('M009', `The predicate of ${e.quantifier}() must be Bool, but has type '${showType(body)}'.`, e, 'body');
            }
            return BOOL;
        }
        if (isUniqueExpr(e)) {
            const coll = this.check(e.collection, scope);
            let elem: Ty = ERROR;
            if (coll.k === 'list') elem = coll.elem;
            else if (coll.k !== 'error') {
                this.sink.error('M009', `unique() requires a collection, but got '${showType(coll)}'.`, e, 'collection');
            }
            if (!e.param) {
                if (elem.k !== 'error' && !equatable(elem, elem)) {
                    this.sink.error('M009', `unique() requires elements that can be compared with '==', but they have type '${showType(elem)}'.`, e, 'collection');
                }
                return BOOL;
            }
            const inner: Scope = { ...scope, lambdas: [...scope.lambdas, [e.param.name, elem]] };
            e.keys.forEach((key, i) => {
                const t = this.check(key, inner);
                if (t.k === 'error' || equatable(t, t)) return;
                const what = `Key '${textOf(key)}' of unique()`;
                if (t.k === 'opt') {
                    this.sink.error('M009', `${what} is optional ('${showType(t)}'); keys must always be present. Group the keys into a value object and use it as the key.`, e, 'keys', i);
                } else {
                    this.sink.error('M009', `${what} has type '${showType(t)}', which cannot be compared with '=='.`, e, 'keys', i);
                }
            });
            return BOOL;
        }
        if (isContainsExpr(e)) {
            const coll = this.check(e.collection, scope);
            const x = this.check(e.element, scope);
            if (coll.k !== 'error' && coll.k !== 'list') {
                this.sink.error('M009', `contains() requires a collection, but got '${showType(coll)}'.`, e, 'collection');
            } else if (coll.k === 'list' && coll.elem.k !== 'error' && x.k !== 'error' && !equatable(coll.elem, x)) {
                const hint = x.k === 'opt' ? ' Optional values must be guarded with exists(...) first.' : '';
                this.sink.error('M009', `contains() cannot compare elements of type '${showType(coll.elem)}' with '${showType(x)}'.${hint}`, e, 'element');
            }
            return BOOL;
        }
        if (isBinaryExpr(e)) return this.binary(e, scope);
        return ERROR;
    }

    private binary(e: Expression & { $type: 'BinaryExpr' }, scope: Scope): Ty {
        const { op } = e;
        if (op === 'and' || op === 'or' || op === 'implies') {
            const l = this.check(e.left, scope);
            // `a and b` / `a implies b`: b is evaluated only when a holds, so a's exists() guards apply to b.
            const rightScope = op === 'or' ? scope : { ...scope, present: new Set([...scope.present, ...guards(e.left)]) };
            const r = this.check(e.right, rightScope);
            for (const [side, t] of [['left', l], ['right', r]] as const) {
                if (t.k !== 'error' && !isBool(t)) {
                    this.sink.error('M009', `Operator '${op}' requires Bool operands, but the ${side} operand has type '${showType(t)}'.`, e, side);
                }
            }
            return BOOL;
        }
        const l = this.check(e.left, scope);
        const r = this.check(e.right, scope);
        if (l.k === 'error' || r.k === 'error') return BOOL;
        const ok = op === '==' || op === '!=' ? equatable(l, r) : ordered(l, r);
        if (!ok) {
            const hint = l.k === 'opt' || r.k === 'opt' ? ' Optional values must be guarded with exists(...) first.' : '';
            this.sink.error('M009', `Operator '${op}' cannot be applied to '${showType(l)}' and '${showType(r)}'.${hint}`, e);
        }
        return BOOL;
    }

    private name(name: string, node: Expression, scope: Scope): Ty {
        for (let i = scope.lambdas.length - 1; i >= 0; i--) {
            if (scope.lambdas[i][0] === name) return narrow(scope.lambdas[i][1], name, scope);
        }
        const field = scope.fields.get(name);
        if (field) return narrow(memberType(field), name, scope);
        const decl = this.index.lookupVisible(scope.ctx, name);
        if (decl && isEnumDecl(decl)) return { k: 'enumType', decl };
        if (decl && isUnionDecl(decl)) return { k: 'unionType', decl };
        if (this.index.contextNames.includes(name)) return { k: 'ctx', name };
        const hidden = scope.hidden.get(name);
        if (hidden) {
            this.sink.error('M010', hidden.message, node, undefined, undefined, hidden.hint);
            return ERROR;
        }
        this.sink.error('M001', `Cannot resolve name '${name}'.`, node, undefined, undefined, didYouMean(name, this.namesIn(scope)));
        return ERROR;
    }

    /**
     * Names usable as values here: lambda parameters, fields and parameters, the enums and unions of this context and of
     * shared contexts, those of other contexts qualified, and context names.
     */
    private namesIn(scope: Scope): Candidate[] {
        const names: Candidate[] = [...scope.lambdas.map(([name]) => ({ name })), ...[...scope.fields.keys()].map((name) => ({ name }))];
        for (const el of this.index.elements) {
            if (!isEnumDecl(el) && !isUnionDecl(el)) continue;
            const owner = el.$container.name;
            const visible = owner === scope.ctx || this.index.isShared(owner);
            names.push(visible ? { name: el.name } : { name: `${owner}.${el.name}`, key: el.name });
        }
        return [...names, ...this.index.contextNames.map((name) => ({ name }))];
    }

    private member(e: Expression & { $type: 'MemberAccess' }, scope: Scope): Ty {
        const recv = this.infer(e.receiver, scope);
        const m = e.member;
        switch (recv.k) {
            case 'error':
                return ERROR;
            case 'ctx': {
                const el = this.index.lookup(`${recv.name}.${m}`);
                if (el && isEnumDecl(el)) return { k: 'enumType', decl: el };
                if (el && isUnionDecl(el)) return { k: 'unionType', decl: el };
                const names = this.index.elementsOf(recv.name).filter((x) => isEnumDecl(x) || isUnionDecl(x)).map((x) => x.name);
                this.sink.error('M001', `Context '${recv.name}' has no enum or union named '${m}'.`, e, 'member', undefined, didYouMean(m, names));
                return ERROR;
            }
            case 'enumType':
                if (recv.decl.values.some((v) => v.name === m)) return { k: 'enum', decl: recv.decl as EnumDecl };
                this.sink.error('M001', `Enum '${recv.decl.name}' has no value '${m}'.`, e, 'member', undefined, suggestFrom(m, recv.decl.values.map((v) => v.name), `a value of '${recv.decl.name}'`));
                return ERROR;
            case 'unionType':
                if (recv.decl.variants.some((v) => v.name === m)) return tagOf(recv.decl);
                this.sink.error('M001', `Union '${recv.decl.name}' has no variant '${m}'.`, e, 'member', undefined, suggestFrom(m, recv.decl.variants.map((v) => v.name), `a variant of '${recv.decl.name}'`));
                return ERROR;
            case 'union': {
                if (m === discriminatorOf(recv.decl)) return tagOf(recv.decl);
                const variants = recv.decl.variants.filter((v) => fieldsOf(v.members).some((f) => f.name === m)).map((v) => v.name);
                if (variants.length) {
                    this.sink.error(
                        'M009',
                        `'${m}' exists only in variant ${variants.map((v) => `'${v}'`).join(', ')} of union '${recv.decl.name}'; only '${discriminatorOf(recv.decl)}' is accessible from outside.`,
                        e,
                        'member',
                    );
                } else {
                    const hint = didYouMean(m, [discriminatorOf(recv.decl)]) ?? `only '${discriminatorOf(recv.decl)}' is accessible from outside the union`;
                    this.sink.error('M001', `Union '${recv.decl.name}' has no field '${m}'.`, e, 'member', undefined, hint);
                }
                return ERROR;
            }
            case 'struct': {
                const fields = [...includedFields(recv.decl).map((x) => x.field), ...fieldsOf(recv.decl.members)];
                const f = fields.find((x) => x.name === m);
                if (f) return narrow(memberType(f), pathOf(e) ?? '', scope);
                const hint = suggestFrom(m, fields.map((x) => x.name), `a field of '${recv.decl.name}'`);
                this.sink.error('M001', `'${recv.decl.name}' has no field '${m}'.`, e, 'member', undefined, hint);
                return ERROR;
            }
            case 'opt':
                this.sink.error('M009', `'${pathOf(e.receiver) ?? 'value'}' is optional; guard the access with exists(...) first.`, e);
                return ERROR;
            case 'id':
                this.sink.error('M009', `'${recv.decl.name}' is an identifier; the referenced aggregate's state cannot be accessed from an invariant.`, e, 'member');
                return ERROR;
            default:
                this.sink.error('M009', `'${showType(recv)}' has no field '${m}'.`, e, 'member');
                return ERROR;
        }
    }
}

function narrow(t: Ty, path: string, scope: Scope): Ty {
    return t.k === 'opt' && scope.present.has(path) ? t.inner : t;
}

/**
 * The pattern of `matches(value, "...")` exactly as written: backslashes are not string escapes,
 * so `"\d+"` is the regular expression `\d+` (only `\"` stands for a quote).
 */
export function regexSource(e: MatchesExpr): string {
    const text = GrammarUtils.findNodeForProperty(e.$cstNode, 'pattern')?.text;
    return text ? text.slice(1, -1).replace(/\\"/g, '"') : e.pattern;
}

/** Source text of an expression on one line. */
const textOf = (e: AstNode): string => e.$cstNode?.text.replace(/\s+/g, ' ').trim() ?? '';

/** Dotted path of a NameRef / MemberAccess chain, used to track exists() guards. */
function pathOf(e: Expression): string | undefined {
    if (isNameRef(e)) return e.name;
    if (isMemberAccess(e)) {
        const r = pathOf(e.receiver);
        return r === undefined ? undefined : `${r}.${e.member}`;
    }
    return undefined;
}

/** Paths guaranteed present when `e` evaluates to true (exists() conjuncts). */
function guards(e: Expression): string[] {
    if (isExistsExpr(e)) {
        const p = pathOf(e.operand);
        return p ? [p] : [];
    }
    if (isBinaryExpr(e) && e.op === 'and') return [...guards(e.left), ...guards(e.right)];
    return [];
}

/**
 * Domain primitives (IDs and `primitive`s) compare with the same domain primitive, with a literal of a compatible
 * base type (`quantity > 0`), and, over `Int` or `Decimal`, with a number `count(…)` or `length(…)` computes
 * (`count(confirmedBy) >= policy.required`). Different domain primitives, or a plain field or parameter of the base
 * type, do not.
 */
function comparable(l: Ty, r: Ty, check: (a: Ty, b: Ty) => boolean): boolean {
    const ld = isDomainPrimitive(l);
    const rd = isDomainPrimitive(r);
    if (ld && rd) return sameType(l, r) && check(baseOf(l), baseOf(r));
    if (ld || rd) {
        const [dp, other] = ld ? [l, r] : [r, l];
        const conceptless = other.k === 'prim' && (!!other.literal || (!!other.computed && isNumeric(baseOf(dp))));
        return conceptless && check(baseOf(dp), other);
    }
    return check(l, r);
}

const baseOf = (t: Ty): Ty => ({ k: 'prim', name: basePrimitive(t)! });

/**
 * `==`, `!=`, `unique` and `contains` compare by this rule: value objects by all their fields, entities by `id`,
 * unions by discriminator and fields. Lists and optionals cannot be compared.
 */
function equatable(l: Ty, r: Ty): boolean {
    if (l.k === 'list' || r.k === 'list' || l.k === 'opt' || r.k === 'opt') return false;
    return comparable(l, r, (a, b) => (isNumeric(a) && isNumeric(b)) || sameType(a, b));
}

function ordered(l: Ty, r: Ty): boolean {
    return comparable(l, r, (a, b) => {
        if (isNumeric(a) && isNumeric(b)) return true;
        return a.k === 'prim' && b.k === 'prim' && a.name === b.name && (a.name === 'Timestamp' || a.name === 'String');
    });
}

/** String-like values: String, UUID, and domain primitives over them. */
const isTextual = (t: Ty): boolean => {
    const b = basePrimitive(t);
    return b === 'String' || b === 'UUID';
};
