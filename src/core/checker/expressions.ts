import {
    isAggregate,
    isBinaryExpr,
    isBoolLiteral,
    isCountExpr,
    isDecimalLiteral,
    isEnumDecl,
    isExistsExpr,
    isIdType,
    isIntLiteral,
    isLengthExpr,
    isMatchesExpr,
    isMemberAccess,
    isPrimitiveDecl,
    isRangeExpr,
    isNameRef,
    isNotExpr,
    isQuantifierExpr,
    isEntity,
    isStringLiteral,
    isValueObject,
    type Aggregate,
    type DataMember,
    type EnumDecl,
    type Expression,
    type Invariant,
    type MatchesExpr,
} from '../../language/generated/ast.js';
import { GrammarUtils } from 'langium';
import type { DiagnosticSink } from '../diagnostics.js';
import {
    commonFields,
    fieldsOf,
    invariantsOf,
    primitiveInvariants,
    statesOf,
    type DomainPrimitive,
    type FieldLike,
    type ModelIndex,
} from '../model-index.js';
import { BOOL, ERROR, INT, basePrimitive, isBool, isDomainPrimitive, isNumeric, memberType, sameType, showType, type Ty } from '../types.js';

interface Scope {
    ctx: string;
    /** Fields visible in this invariant. */
    fields: Map<string, FieldLike>;
    /** Fields that exist only in other states of the aggregate (for M010 messages). */
    stateOnly: Map<string, string[]>;
    /** Lambda parameters, innermost last. */
    lambdas: Array<[string, Ty]>;
    /** Paths proven present by an enclosing `exists(...)` guard. */
    present: Set<string>;
}

/** Type-checks every invariant in the workspace (M001 for names, M008, M009, M010). */
export function checkInvariants(index: ModelIndex, sink: DiagnosticSink): void {
    for (const el of index.elements) {
        const ctx = el.$container.name;
        if (isAggregate(el)) {
            checkAggregate(el, ctx, index, sink);
        } else if (isEntity(el) || isValueObject(el)) {
            const members: DataMember[] = el.members;
            const fields = new Map(fieldsOf(members).map((f) => [f.name, f]));
            for (const inv of invariantsOf(members)) {
                checkInvariant(inv, { ctx, fields, stateOnly: new Map(), lambdas: [], present: new Set() }, index, sink);
            }
        } else if (isIdType(el) || isPrimitiveDecl(el)) {
            checkPrimitive(el, ctx, index, sink);
        }
    }
}

/** Domain primitive invariants see a single name, `value`, of the base primitive type. */
function checkPrimitive(p: DomainPrimitive, ctx: string, index: ModelIndex, sink: DiagnosticSink): void {
    if (!p.base) return;
    for (const inv of primitiveInvariants(p)) {
        if (!inv.expr) continue;
        const scope: Scope = { ctx, fields: new Map(), stateOnly: new Map(), lambdas: [['value', { k: 'prim', name: p.base }]], present: new Set() };
        const t = new ExprChecker(index, sink).check(inv.expr, scope);
        if (t.k !== 'error' && !isBool(t)) {
            const what = inv.node === inv.expr ? `The constraint of '${p.name}'` : `Invariant '${inv.name}'`;
            sink.error('M008', `${what} must be a Bool expression, but has type '${showType(t)}'.`, inv.expr);
        }
    }
}

function checkAggregate(agg: Aggregate, ctx: string, index: ModelIndex, sink: DiagnosticSink): void {
    const common = new Map(commonFields(agg).map((f) => [f.name, f]));
    const states = statesOf(agg);
    const stateOnly = (except?: string): Map<string, string[]> => {
        const m = new Map<string, string[]>();
        for (const s of states) {
            if (s.name === except) continue;
            for (const f of fieldsOf(s.members)) {
                if (common.has(f.name)) continue;
                m.set(f.name, [...(m.get(f.name) ?? []), s.name]);
            }
        }
        return m;
    };

    // Aggregate-level invariants: common fields only, applied to every state.
    for (const inv of invariantsOf(agg.members)) {
        checkInvariant(inv, { ctx, fields: common, stateOnly: stateOnly(), lambdas: [], present: new Set() }, index, sink);
    }
    // State-level invariants: common + that state's own fields.
    for (const s of states) {
        const fields = new Map(common);
        for (const f of fieldsOf(s.members)) fields.set(f.name, f);
        const hidden = stateOnly(s.name);
        for (const name of fields.keys()) hidden.delete(name);
        for (const inv of invariantsOf(s.members)) {
            checkInvariant(inv, { ctx, fields, stateOnly: hidden, lambdas: [], present: new Set() }, index, sink);
        }
    }
}

function checkInvariant(inv: Invariant, scope: Scope, index: ModelIndex, sink: DiagnosticSink): void {
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
        if (t.k === 'enumType' || t.k === 'ctx') {
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
            return INT;
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
            return INT;
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
                const reason = (err as Error).message.replace(/^Invalid regular expression:\s*/, '');
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
        const enumDecl = this.index.lookupVisible(scope.ctx, name);
        if (enumDecl && isEnumDecl(enumDecl)) return { k: 'enumType', decl: enumDecl };
        if (this.index.contextNames.includes(name)) return { k: 'ctx', name };
        const states = scope.stateOnly.get(name);
        if (states) {
            const where = states.map((s) => `'${s}'`).join(', ');
            this.sink.error('M010', `Field '${name}' exists only in state ${where} and is not in scope here.`, node);
            return ERROR;
        }
        this.sink.error('M001', `Cannot resolve name '${name}'.`, node);
        return ERROR;
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
                this.sink.error('M001', `Context '${recv.name}' has no enum named '${m}'.`, e, 'member');
                return ERROR;
            }
            case 'enumType':
                if (recv.decl.values.some((v) => v.name === m)) return { k: 'enum', decl: recv.decl as EnumDecl };
                this.sink.error('M001', `Enum '${recv.decl.name}' has no value '${m}'.`, e, 'member');
                return ERROR;
            case 'struct': {
                const f = fieldsOf(recv.decl.members).find((x) => x.name === m);
                if (f) return narrow(memberType(f), pathOf(e) ?? '', scope);
                this.sink.error('M001', `'${recv.decl.name}' has no field '${m}'.`, e, 'member');
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
 * Domain primitives (IDs and `primitive`s) compare with the same domain primitive, or with a literal of a
 * compatible base type (`quantity > 0`). Different domain primitives, or a plain field of the base type, do not.
 */
function comparable(l: Ty, r: Ty, check: (a: Ty, b: Ty) => boolean): boolean {
    const ld = isDomainPrimitive(l);
    const rd = isDomainPrimitive(r);
    if (ld && rd) return sameType(l, r) && check(baseOf(l), baseOf(r));
    if (ld || rd) {
        const [dp, other] = ld ? [l, r] : [r, l];
        return other.k === 'prim' && !!other.literal && check(baseOf(dp), other);
    }
    return check(l, r);
}

const baseOf = (t: Ty): Ty => ({ k: 'prim', name: basePrimitive(t)! });

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
