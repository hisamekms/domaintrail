import type { RuleSink } from '../diagnostics.js';
import { didYouMean, suggestFrom, type Candidate } from '@domaintrail/kernel';
import {
    commandsOf,
    commonFields,
    discriminatorOf,
    elementsOf,
    fieldsOf,
    includedFields,
    invariantsOf,
    isShared,
    lookup,
    lookupVisible,
    primitiveInvariants,
    statesOf,
    type AggregateDecl,
    type CommandDecl,
    type DomainPrimitiveDecl,
    type EnumDecl,
    type Expr,
    type FieldDecl,
    type InvariantDecl,
    type ParamDecl,
    type RequirementDecl,
    type SourceModel,
    type StateDecl,
    type UnionDecl,
} from '../source-model.js';
import { BOOL, COMPUTED_INT, ERROR, basePrimitive, isBool, isDomainPrimitive, isNumeric, memberType, sameType, showType, type Ty } from '../types.js';

interface Scope {
    ctx: string;
    /** Fields (and the parameters of a command) visible in this invariant or requirement. */
    fields: Map<string, FieldDecl | ParamDecl>;
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
export function checkInvariants(model: SourceModel, rules: RuleSink): void {
    for (const el of model.elements) {
        const ctx = el.context;
        if (el.kind === 'aggregate') {
            checkAggregate(el, ctx, model, rules);
        } else if (el.kind === 'entity' || el.kind === 'valueObject') {
            const fields = new Map<string, FieldDecl | ParamDecl>([...includedFields(el).map((x) => x.field), ...fieldsOf(el.members)].map((f) => [f.name, f]));
            for (const inv of invariantsOf(el.members)) {
                checkInvariant(inv, { ctx, fields, hidden: new Map(), lambdas: [], present: new Set() }, model, rules);
            }
        } else if (el.kind === 'union') {
            // Variant invariants see the fields of their own variant.
            for (const v of el.variants) {
                const fields = new Map<string, FieldDecl | ParamDecl>(fieldsOf(v.members).map((f) => [f.name, f]));
                for (const inv of invariantsOf(v.members)) {
                    checkInvariant(inv, { ctx, fields, hidden: new Map(), lambdas: [], present: new Set() }, model, rules);
                }
            }
        } else if (el.kind === 'id' || el.kind === 'primitive') {
            checkPrimitive(el, ctx, model, rules);
        }
    }
}

/** Type of a union's discriminator and of its tags: the bound enum, or the union's own tag type. */
function tagOf(u: UnionDecl): Ty {
    const bound = u.tagType?.target;
    if (u.tagType && !bound) return ERROR; // unresolved, reported as M001
    return bound ? { k: 'enum', decl: bound } : { k: 'tag', decl: u };
}

/** Domain primitive invariants see a single name, `value`, of the base primitive type. */
function checkPrimitive(p: DomainPrimitiveDecl, ctx: string, model: SourceModel, rules: RuleSink): void {
    if (!p.base) return;
    for (const inv of primitiveInvariants(p)) {
        if ('kind' in inv.decl) checkDeclared(inv.decl, rules);
        if (!inv.expr) continue;
        const scope: Scope = { ctx, fields: new Map(), hidden: new Map(), lambdas: [['value', { k: 'prim', name: p.base }]], present: new Set() };
        const t = new ExprChecker(model, rules).check(inv.expr, scope);
        if (t.k !== 'error' && !isBool(t)) {
            const what = inv.decl === inv.expr ? `The constraint of '${p.name}'` : `Invariant '${inv.name}'`;
            rules.error('M008', `${what} must be a Bool expression, but has type '${showType(t)}'.`, inv.expr.at);
        }
    }
}

function checkAggregate(agg: AggregateDecl, ctx: string, model: SourceModel, rules: RuleSink): void {
    // fields taken from field sets are common fields too
    const common = new Map<string, FieldDecl | ParamDecl>([...includedFields(agg).map((x) => x.field), ...commonFields(agg)].map((f) => [f.name, f]));
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
        checkInvariant(inv, { ctx, fields: common, hidden: stateOnly(), lambdas: [], present: new Set() }, model, rules);
    }
    // State-level invariants: common + that state's own fields.
    for (const s of states) {
        const fields = new Map(common);
        for (const f of fieldsOf(s.members)) fields.set(f.name, f);
        const hidden = stateOnly(s.name);
        for (const name of fields.keys()) hidden.delete(name);
        for (const inv of invariantsOf(s.members)) {
            checkInvariant(inv, { ctx, fields, hidden, lambdas: [], present: new Set() }, model, rules);
        }
    }
    for (const cmd of commandsOf(agg)) {
        if (cmd.requirements.length) checkRequirements(agg, cmd, common, ctx, model, rules);
        for (const outcome of cmd.outcomes) checkChoice(outcome, cmd, common, ctx, model, rules);
        for (const group of agg.members.filter((m) => m.kind === 'transitionGroup')) {
            for (const c of group.cases.filter((c) => c.command.text === cmd.name)) {
                const sources = c.outcomes.flatMap((o) => o.from.map((r) => r.target)).filter((s): s is StateDecl => !!s);
                for (const r of c.requirements) checkDecisionExpr(r.expr, `Requirement '${r.name}'`, r.exprAt, cmd, common, ctx, model, rules, sources);
                for (const outcome of c.outcomes) checkChoice(outcome, cmd, common, ctx, model, rules);
            }
        }
    }
}

function checkChoice(
    outcome: import('../source-model.js').OutcomeDecl,
    cmd: CommandDecl,
    common: Map<string, FieldDecl | ParamDecl>,
    ctx: string,
    model: SourceModel,
    rules: RuleSink,
): void {
    checkDecisionExpr(
        outcome.select?.expr,
        `Choice rule of outcome '${outcome.name}'`,
        outcome.select?.at ?? outcome.at,
        cmd,
        common,
        ctx,
        model,
        rules,
        outcome.from.map((r) => r.target).filter((s): s is StateDecl => !!s),
    );
}

function checkDecisionExpr(
    expr: Expr | undefined,
    label: string,
    at: import('../source-model.js').Site,
    cmd: CommandDecl,
    common: Map<string, FieldDecl | ParamDecl>,
    ctx: string,
    model: SourceModel,
    rules: RuleSink,
    sources: StateDecl[] = [],
): void {
    if (!expr) return;
    const fields = new Map(cmd.factory ? [] : common);
    const [first, ...rest] = sources;
    if (!cmd.factory && first)
        for (const f of fieldsOf(first.members)) {
            const ty = memberType(f);
            if (rest.every((s) => fieldsOf(s.members).some((g) => g.name === f.name && sameType(memberType(g), ty)))) fields.set(f.name, f);
        }
    for (const p of cmd.params) fields.set(p.name, p);
    const t = new ExprChecker(model, rules).check(expr, { ctx, fields, hidden: new Map(), lambdas: [], present: new Set() });
    if (t.k !== 'error' && !isBool(t)) rules.error('M008', `${label} must be a Bool expression, but has type '${showType(t)}'.`, at);
}

/** Fields of the states (other than `except`) that are not common fields, with the states that have each. */
function statesHaving(states: StateDecl[], common: Map<string, FieldDecl | ParamDecl>, except?: string): Map<string, string[]> {
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
function checkRequirements(
    agg: AggregateDecl,
    cmd: CommandDecl,
    common: Map<string, FieldDecl | ParamDecl>,
    ctx: string,
    model: SourceModel,
    rules: RuleSink,
): void {
    const states = statesOf(agg);
    const fields = new Map<string, FieldDecl | ParamDecl>();
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
        const grouped = agg.members
            .filter((m) => m.kind === 'transitionGroup')
            .flatMap((g) => g.cases.filter((c) => c.command.text === cmd.name).flatMap((c) => c.outcomes));
        const sources = [
            ...new Set([
                ...cmd.transitions.flatMap((t) => t.from.map((r) => r.target)),
                ...[...cmd.outcomes, ...grouped].flatMap((o) => o.from.map((r) => r.target)),
            ]),
        ].filter((s): s is StateDecl => !!s);
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
            rules.error(
                'M019',
                `Parameter '${p.name}' of command '${cmd.name}' has the name of a field of '${agg.name}' that its requirements see.`,
                p.nameAt,
                `rename the parameter (e.g. 'new${p.name[0].toUpperCase()}${p.name.slice(1)}'), so that '${p.name}' in a requirement means the field`,
            );
        }
    }
    for (const p of cmd.params) if (p.name) fields.set(p.name, p);

    for (const req of cmd.requirements) {
        checkDeclared(req, rules);
        if (!req.expr) continue;
        const t = new ExprChecker(model, rules).check(req.expr, { ctx, fields, hidden, lambdas: [], present: new Set() });
        if (t.k !== 'error' && !isBool(t)) {
            rules.error('M008', `Requirement '${req.name}' of command '${cmd.name}' must be a Bool expression, but has type '${showType(t)}'.`, req.exprAt);
        }
    }
}

/**
 * M018: an invariant or requirement without an expression is declared for documentation only, so it must say what it
 * requires.
 */
function checkDeclared(x: InvariantDecl | RequirementDecl, rules: RuleSink): void {
    if (x.expr || x.label || x.doc) return;
    const isRequirement = !('kind' in x);
    const what = isRequirement ? 'Requirement' : 'Invariant';
    const keyword = isRequirement ? 'requires' : 'invariant';
    rules.error(
        'M018',
        `${what} '${x.name}' has no expression; give it a label or a /// description that states what it requires.`,
        x.nameAt,
        `write '${keyword} ${x.name} "…"', put a /// line above it, or add an expression in '{ … }'`,
    );
}

function checkInvariant(inv: InvariantDecl, scope: Scope, model: SourceModel, rules: RuleSink): void {
    checkDeclared(inv, rules);
    if (!inv.expr) return;
    const t = new ExprChecker(model, rules).check(inv.expr, scope);
    if (t.k !== 'error' && !isBool(t)) {
        rules.error('M008', `Invariant '${inv.name}' must be a Bool expression, but has type '${showType(t)}'.`, inv.exprAt);
    }
}

type ExprOf<K extends Expr['k']> = Extract<Expr, { k: K }>;

class ExprChecker {
    constructor(
        private readonly model: SourceModel,
        private readonly rules: RuleSink,
    ) {}

    check(e: Expr, scope: Scope): Ty {
        const t = this.infer(e, scope);
        if (t.k === 'enumType' || t.k === 'unionType' || t.k === 'ctx') {
            this.rules.error('M009', `'${showType(t)}' is not a value.`, e.at);
            return ERROR;
        }
        return t;
    }

    private infer(e: Expr, scope: Scope): Ty {
        switch (e.k) {
            case 'int':
                return { k: 'prim', name: 'Int', literal: true };
            case 'decimal':
                return { k: 'prim', name: 'Decimal', literal: true };
            case 'string':
                return { k: 'prim', name: 'String', literal: true };
            case 'bool':
                return BOOL;
            case 'name':
                return this.name(e.name, e, scope);
            case 'member':
                return this.member(e, scope);
            case 'not': {
                const t = this.check(e.operand, scope);
                if (t.k !== 'error' && !isBool(t)) {
                    this.rules.error('M009', `Operator 'not' requires Bool, but got '${showType(t)}'.`, e.at);
                }
                return BOOL;
            }
            case 'count': {
                const t = this.check(e.collection, scope);
                if (t.k !== 'error' && t.k !== 'list') {
                    this.rules.error('M009', `count() requires a collection, but got '${showType(t)}'.`, e.collectionAt);
                }
                return COMPUTED_INT;
            }
            case 'exists': {
                // Evaluate the operand without narrowing so that `exists(x)` checks the declared optionality.
                const t = this.check(e.operand, { ...scope, present: new Set() });
                if (t.k !== 'error' && t.k !== 'opt') {
                    this.rules.error('M009', `exists() requires an optional value, but '${showType(t)}' is always present.`, e.operandAt);
                }
                return BOOL;
            }
            case 'length': {
                const t = this.check(e.operand, scope);
                if (t.k !== 'error' && !isTextual(t)) {
                    this.rules.error('M009', `length() requires a String value, but got '${showType(t)}'.`, e.operandAt);
                }
                return COMPUTED_INT;
            }
            case 'matches': {
                const t = this.check(e.operand, scope);
                if (t.k !== 'error' && !isTextual(t)) {
                    this.rules.error('M009', `matches() requires a String value, but got '${showType(t)}'.`, e.operandAt);
                }
                // the regular expression as written (backslashes are not string escapes)
                const pattern = e.pattern;
                try {
                    new RegExp(pattern);
                } catch (err) {
                    const reason = String(err instanceof Error ? err.message : err).replace(/^Invalid regular expression:\s*/, '');
                    this.rules.error('M009', `Invalid regular expression "${pattern}": ${reason}`, e.patternAt);
                }
                return BOOL;
            }
            case 'range': {
                const v = this.check(e.operand, scope);
                const lo = this.check(e.lower, scope);
                const hi = this.check(e.upper, scope);
                if (v.k !== 'error' && lo.k !== 'error' && hi.k !== 'error' && !(ordered(v, lo) && ordered(v, hi))) {
                    this.rules.error('M009', `Range '${showType(lo)}..${showType(hi)}' cannot be applied to '${showType(v)}'.`, e.at);
                }
                return BOOL;
            }
            case 'quantifier': {
                const coll = this.check(e.collection, scope);
                let elem: Ty = ERROR;
                if (coll.k === 'list') elem = coll.elem;
                else if (coll.k !== 'error') {
                    this.rules.error('M009', `${e.quantifier}() requires a collection, but got '${showType(coll)}'.`, e.collectionAt);
                }
                const inner: Scope = { ...scope, lambdas: [...scope.lambdas, [e.param, elem]] };
                const body = this.check(e.body, inner);
                if (body.k !== 'error' && !isBool(body)) {
                    this.rules.error('M009', `The predicate of ${e.quantifier}() must be Bool, but has type '${showType(body)}'.`, e.bodyAt);
                }
                return BOOL;
            }
            case 'unique': {
                const coll = this.check(e.collection, scope);
                let elem: Ty = ERROR;
                if (coll.k === 'list') elem = coll.elem;
                else if (coll.k !== 'error') {
                    this.rules.error('M009', `unique() requires a collection, but got '${showType(coll)}'.`, e.collectionAt);
                }
                if (e.param === undefined) {
                    if (elem.k !== 'error' && !equatable(elem, elem)) {
                        this.rules.error(
                            'M009',
                            `unique() requires elements that can be compared with '==', but they have type '${showType(elem)}'.`,
                            e.collectionAt,
                        );
                    }
                    return BOOL;
                }
                const inner: Scope = { ...scope, lambdas: [...scope.lambdas, [e.param, elem]] };
                e.keys.forEach((key, i) => {
                    const t = this.check(key, inner);
                    if (t.k === 'error' || equatable(t, t)) return;
                    const what = `Key '${key.text}' of unique()`;
                    if (t.k === 'opt') {
                        this.rules.error(
                            'M009',
                            `${what} is optional ('${showType(t)}'); keys must always be present. Group the keys into a value object and use it as the key.`,
                            e.keysAt[i],
                        );
                    } else {
                        this.rules.error('M009', `${what} has type '${showType(t)}', which cannot be compared with '=='.`, e.keysAt[i]);
                    }
                });
                return BOOL;
            }
            case 'contains': {
                const coll = this.check(e.collection, scope);
                const x = this.check(e.element, scope);
                if (coll.k !== 'error' && coll.k !== 'list') {
                    this.rules.error('M009', `contains() requires a collection, but got '${showType(coll)}'.`, e.collectionAt);
                } else if (coll.k === 'list' && coll.elem.k !== 'error' && x.k !== 'error' && !equatable(coll.elem, x)) {
                    const hint = x.k === 'opt' ? ' Optional values must be guarded with exists(...) first.' : '';
                    this.rules.error('M009', `contains() cannot compare elements of type '${showType(coll.elem)}' with '${showType(x)}'.${hint}`, e.elementAt);
                }
                return BOOL;
            }
            case 'binary':
                return this.binary(e, scope);
        }
    }

    private binary(e: ExprOf<'binary'>, scope: Scope): Ty {
        const { op } = e;
        if (op === 'and' || op === 'or' || op === 'implies') {
            const l = this.check(e.left, scope);
            // `a and b` / `a implies b`: b is evaluated only when a holds, so a's exists() guards apply to b.
            const rightScope = op === 'or' ? scope : { ...scope, present: new Set([...scope.present, ...guards(e.left)]) };
            const r = this.check(e.right, rightScope);
            for (const [side, t, at] of [
                ['left', l, e.leftAt],
                ['right', r, e.rightAt],
            ] as const) {
                if (t.k !== 'error' && !isBool(t)) {
                    this.rules.error('M009', `Operator '${op}' requires Bool operands, but the ${side} operand has type '${showType(t)}'.`, at);
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
            this.rules.error('M009', `Operator '${op}' cannot be applied to '${showType(l)}' and '${showType(r)}'.${hint}`, e.at);
        }
        return BOOL;
    }

    private name(name: string, node: Expr, scope: Scope): Ty {
        for (let i = scope.lambdas.length - 1; i >= 0; i--) {
            if (scope.lambdas[i][0] === name) return narrow(scope.lambdas[i][1], name, scope);
        }
        const field = scope.fields.get(name);
        if (field) return narrow(memberType(field), name, scope);
        const decl = lookupVisible(this.model, scope.ctx, name);
        if (decl?.kind === 'enum') return { k: 'enumType', decl };
        if (decl?.kind === 'union') return { k: 'unionType', decl };
        if (this.model.contexts.includes(name)) return { k: 'ctx', name };
        const hidden = scope.hidden.get(name);
        if (hidden) {
            this.rules.error('M010', hidden.message, node.at, hidden.hint);
            return ERROR;
        }
        this.rules.error('M001', `Cannot resolve name '${name}'.`, node.at, didYouMean(name, this.namesIn(scope)));
        return ERROR;
    }

    /**
     * Names usable as values here: lambda parameters, fields and parameters, the enums and unions of this context and of
     * shared contexts, those of other contexts qualified, and context names.
     */
    private namesIn(scope: Scope): Candidate[] {
        const names: Candidate[] = [...scope.lambdas.map(([name]) => ({ name })), ...[...scope.fields.keys()].map((name) => ({ name }))];
        for (const el of this.model.elements) {
            if (el.kind !== 'enum' && el.kind !== 'union') continue;
            const owner = el.context;
            const visible = owner === scope.ctx || isShared(this.model, owner);
            names.push(visible ? { name: el.name } : { name: `${owner}.${el.name}`, key: el.name });
        }
        return [...names, ...this.model.contexts.map((name) => ({ name }))];
    }

    private member(e: ExprOf<'member'>, scope: Scope): Ty {
        const recv = this.infer(e.receiver, scope);
        const m = e.member;
        switch (recv.k) {
            case 'error':
                return ERROR;
            case 'ctx': {
                const el = lookup(this.model, `${recv.name}.${m}`);
                if (el?.kind === 'enum') return { k: 'enumType', decl: el };
                if (el?.kind === 'union') return { k: 'unionType', decl: el };
                const names = elementsOf(this.model, recv.name)
                    .filter((x) => x.kind === 'enum' || x.kind === 'union')
                    .map((x) => x.name);
                this.rules.error('M001', `Context '${recv.name}' has no enum or union named '${m}'.`, e.memberAt, didYouMean(m, names));
                return ERROR;
            }
            case 'enumType':
                if (recv.decl.values.some((v) => v.name === m)) return { k: 'enum', decl: recv.decl as EnumDecl };
                this.rules.error(
                    'M001',
                    `Enum '${recv.decl.name}' has no value '${m}'.`,
                    e.memberAt,
                    suggestFrom(
                        m,
                        recv.decl.values.map((v) => v.name),
                        `a value of '${recv.decl.name}'`,
                    ),
                );
                return ERROR;
            case 'unionType':
                if (recv.decl.variants.some((v) => v.name === m)) return tagOf(recv.decl);
                this.rules.error(
                    'M001',
                    `Union '${recv.decl.name}' has no variant '${m}'.`,
                    e.memberAt,
                    suggestFrom(
                        m,
                        recv.decl.variants.map((v) => v.name),
                        `a variant of '${recv.decl.name}'`,
                    ),
                );
                return ERROR;
            case 'union': {
                if (m === discriminatorOf(recv.decl)) return tagOf(recv.decl);
                const variants = recv.decl.variants.filter((v) => fieldsOf(v.members).some((f) => f.name === m)).map((v) => v.name);
                if (variants.length) {
                    this.rules.error(
                        'M009',
                        `'${m}' exists only in variant ${variants.map((v) => `'${v}'`).join(', ')} of union '${recv.decl.name}'; only '${discriminatorOf(recv.decl)}' is accessible from outside.`,
                        e.memberAt,
                    );
                } else {
                    const hint = didYouMean(m, [discriminatorOf(recv.decl)]) ?? `only '${discriminatorOf(recv.decl)}' is accessible from outside the union`;
                    this.rules.error('M001', `Union '${recv.decl.name}' has no field '${m}'.`, e.memberAt, hint);
                }
                return ERROR;
            }
            case 'struct': {
                const fields = [...includedFields(recv.decl).map((x) => x.field), ...fieldsOf(recv.decl.members)];
                const f = fields.find((x) => x.name === m);
                if (f) return narrow(memberType(f), pathOf(e) ?? '', scope);
                const hint = suggestFrom(
                    m,
                    fields.map((x) => x.name),
                    `a field of '${recv.decl.name}'`,
                );
                this.rules.error('M001', `'${recv.decl.name}' has no field '${m}'.`, e.memberAt, hint);
                return ERROR;
            }
            case 'opt':
                this.rules.error('M009', `'${pathOf(e.receiver) ?? 'value'}' is optional; guard the access with exists(...) first.`, e.at);
                return ERROR;
            case 'id':
                this.rules.error(
                    'M009',
                    `'${recv.decl.name}' is an identifier; the referenced aggregate's state cannot be accessed from an invariant.`,
                    e.memberAt,
                );
                return ERROR;
            default:
                this.rules.error('M009', `'${showType(recv)}' has no field '${m}'.`, e.memberAt);
                return ERROR;
        }
    }
}

function narrow(t: Ty, path: string, scope: Scope): Ty {
    return t.k === 'opt' && scope.present.has(path) ? t.inner : t;
}

/** Dotted path of a NameRef / MemberAccess chain, used to track exists() guards. */
function pathOf(e: Expr): string | undefined {
    if (e.k === 'name') return e.name;
    if (e.k === 'member') {
        const r = pathOf(e.receiver);
        return r === undefined ? undefined : `${r}.${e.member}`;
    }
    return undefined;
}

/** Paths guaranteed present when `e` evaluates to true (exists() conjuncts). */
function guards(e: Expr): string[] {
    if (e.k === 'exists') {
        const p = pathOf(e.operand);
        return p ? [p] : [];
    }
    if (e.k === 'binary' && e.op === 'and') return [...guards(e.left), ...guards(e.right)];
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
