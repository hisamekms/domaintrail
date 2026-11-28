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
    kindFields,
    kindsOf,
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
    type KindDecl,
    type ParamDecl,
    type RequirementDecl,
    type SourceModel,
    type StateDecl,
    type UnionDecl,
} from '../source-model.js';
import { canonicalTemporal, isOrderedTemporal, isTemporal, TEMPORAL_EXAMPLE, TEMPORAL_FORM } from '../temporal.js';
import { fieldId } from '../ids.js';
import { BOOL, COMPUTED_INT, ERROR, basePrimitive, isBool, isDomainPrimitive, isNumeric, memberType, sameType, showType, type Ty } from '../types.js';

export interface ExpressionFact {
    expression: Expr;
    type?: Ty;
    comparison?: 'primitive' | 'domainPrimitive' | 'entityId' | 'valueObjectStructural' | 'unionStructural' | 'ordered' | 'enumValue' | 'notComparable';
    symbol?: {
        kind: 'field' | 'parameter' | 'lambdaVariable' | 'value' | 'state' | 'kind' | 'enumValue' | 'type' | 'unionTag' | 'discriminator' | 'context';
        name: string;
        declaration?: object;
        id?: string;
        binding?: Expr;
    };
    paths?: string[];
    scope?: {
        owner: object;
        fields: object[];
        parameters: object[];
        lambdas: Array<{ name: string; binding?: Expr }>;
        sourceStates?: object[];
        targetOutcome?: object;
        kind?: object;
        command?: object;
        onCase?: object;
    };
}
export type ExpressionFactsSink = (fact: ExpressionFact) => void;

interface Scope {
    ctx: string;
    /** Fields (and the parameters of a command) visible in this invariant or requirement. */
    fields: Map<string, FieldDecl | ParamDecl>;
    /** M010 diagnostics for fields of the aggregate that exist but are not in scope here, by name. */
    hidden: Map<string, Hidden>;
    /** Lambda parameters, innermost last. */
    lambdas: Array<[string, Ty, Expr?]>;
    implicitValueId?: string;
    /** Paths proven present by an enclosing `exists(...)` guard. */
    present: Set<string>;
}

interface Hidden {
    message: string;
    hint: string;
}

/** Type-checks every invariant and command requirement in the workspace (M001 for names, M008, M009, M010, M018, M019). */
export function checkInvariants(model: SourceModel, rules: RuleSink, sink?: ExpressionFactsSink): void {
    for (const el of model.elements) {
        const ctx = el.context;
        if (el.kind === 'aggregate') {
            checkAggregate(el, ctx, model, rules, sink);
        } else if (el.kind === 'entity' || el.kind === 'valueObject') {
            const fields = new Map<string, FieldDecl | ParamDecl>([...includedFields(el).map((x) => x.field), ...fieldsOf(el.members)].map((f) => [f.name, f]));
            for (const inv of invariantsOf(el.members)) {
                checkInvariant(inv, { ctx, fields, hidden: new Map(), lambdas: [], present: new Set() }, model, rules, sink, {
                    owner: el,
                    fields: [...fields.values()],
                    parameters: [],
                    lambdas: [],
                });
            }
        } else if (el.kind === 'union') {
            // Variant invariants see the fields of their own variant.
            for (const v of el.variants) {
                const fields = new Map<string, FieldDecl | ParamDecl>(fieldsOf(v.members).map((f) => [f.name, f]));
                for (const inv of invariantsOf(v.members)) {
                    checkInvariant(inv, { ctx, fields, hidden: new Map(), lambdas: [], present: new Set() }, model, rules, sink, {
                        owner: v,
                        fields: [...fields.values()],
                        parameters: [],
                        lambdas: [],
                    });
                }
            }
        } else if (el.kind === 'id' || el.kind === 'primitive') {
            checkPrimitive(el, ctx, model, rules, sink);
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
function checkPrimitive(p: DomainPrimitiveDecl, ctx: string, model: SourceModel, rules: RuleSink, sink?: ExpressionFactsSink): void {
    if (!p.base) return;
    for (const inv of primitiveInvariants(p)) {
        if ('kind' in inv.decl) checkDeclared(inv.decl, rules);
        if (!inv.expr) continue;
        const scope: Scope = {
            ctx,
            fields: new Map(),
            hidden: new Map(),
            lambdas: [['value', { k: 'prim', name: p.base }, inv.expr]],
            implicitValueId: p.id,
            present: new Set(),
        };
        sink?.({ expression: inv.expr, scope: { owner: p, fields: [], parameters: [], lambdas: [{ name: 'value', binding: inv.expr }] } });
        const t = new ExprChecker(model, rules, sink).check(inv.expr, scope);
        if (t.k !== 'error' && !isBool(t)) {
            const what = inv.decl === inv.expr ? `The constraint of '${p.name}'` : `Invariant '${inv.name}'`;
            rules.error('M008', `${what} must be a Bool expression, but has type '${showType(t)}'.`, inv.expr.at);
        }
    }
}

function checkAggregate(agg: AggregateDecl, ctx: string, model: SourceModel, rules: RuleSink, sink?: ExpressionFactsSink): void {
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

    // Fields of the kinds (ADR 0037): seen only inside their kind.
    const kinds = kindsOf(agg);
    const kindOnly = (except?: string): Map<string, Hidden> => {
        const m = new Map<string, string[]>();
        for (const k of kinds) if (k.name !== except) for (const f of kindFields(k)) if (!common.has(f.name)) m.set(f.name, [...(m.get(f.name) ?? []), k.name]);
        return new Map(
            [...m].map(([name, where]) => [
                name,
                {
                    message: `Field '${name}' exists only in kind ${quoted(where)} and is not in scope here.`,
                    hint: `write the rule inside 'kind ${where[0]} { … }' (an invariant, or its command or 'on' case), or make '${name}' a common field of '${agg.name}'`,
                },
            ]),
        );
    };
    const withKind = (k: KindDecl | undefined): Map<string, FieldDecl | ParamDecl> =>
        k ? new Map([...common, ...kindFields(k).map((f): [string, FieldDecl] => [f.name, f])]) : common;
    const kindNamed = (name: string | undefined): KindDecl | undefined => kinds.find((k) => k.name === name);

    // Aggregate-level invariants: common fields only, applied to every state.
    for (const inv of invariantsOf(agg.members)) {
        checkInvariant(inv, { ctx, fields: common, hidden: new Map([...stateOnly(), ...kindOnly()]), lambdas: [], present: new Set() }, model, rules, sink, {
            owner: agg,
            fields: [...common.values()],
            parameters: [],
            lambdas: [],
        });
    }
    // Kind-level invariants: common + that kind's own fields, applied to every state of the kind.
    for (const k of kinds)
        for (const inv of invariantsOf(k.members))
            checkInvariant(
                inv,
                { ctx, fields: withKind(k), hidden: new Map([...stateOnly(), ...kindOnly(k.name)]), lambdas: [], present: new Set() },
                model,
                rules,
                sink,
                { owner: k, fields: [...withKind(k).values()], parameters: [], lambdas: [], kind: k },
            );
    // State-level invariants: common + that state's own fields.
    for (const s of states) {
        const fields = new Map(common);
        for (const f of fieldsOf(s.members)) fields.set(f.name, f);
        const hidden = new Map([...stateOnly(s.name), ...kindOnly()]);
        for (const name of fields.keys()) hidden.delete(name);
        for (const inv of invariantsOf(s.members)) {
            checkInvariant(inv, { ctx, fields, hidden, lambdas: [], present: new Set() }, model, rules, sink, {
                owner: s,
                fields: [...fields.values()],
                parameters: [],
                lambdas: [],
                sourceStates: [s],
            });
        }
    }
    for (const cmd of commandsOf(agg)) {
        // a kind's command sees its kind's fields; a common command the common ones
        const own = kindNamed(cmd.ofKind);
        if (cmd.requirements.length) checkRequirements(agg, cmd, withKind(own), kindOnly(own?.name), ctx, model, rules, sink);
        for (const outcome of cmd.outcomes)
            checkChoice(outcome, cmd, withKind(own), ctx, model, rules, sink, { owner: agg, command: cmd, targetOutcome: outcome, kind: own });
        for (const k of kinds) {
            for (const c of k.cases.filter((c) => c.command.text === cmd.name)) {
                const sources = c.outcomes.flatMap((o) => o.from.map((r) => r.target)).filter((s): s is StateDecl => !!s);
                for (const r of c.requirements) {
                    checkDeclared(r, rules);
                    checkDecisionExpr(r.expr, `Requirement '${r.name}'`, r.exprAt, cmd, withKind(k), ctx, model, rules, sources, kindOnly(k.name), sink, {
                        owner: k,
                        command: cmd,
                        onCase: c,
                        sourceStates: sources,
                        kind: k,
                    });
                }
                for (const outcome of c.outcomes)
                    checkChoice(outcome, cmd, withKind(k), ctx, model, rules, sink, { owner: k, command: cmd, onCase: c, targetOutcome: outcome, kind: k });
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
    sink: ExpressionFactsSink | undefined,
    scopeInfo: Pick<NonNullable<ExpressionFact['scope']>, 'owner' | 'command' | 'onCase' | 'targetOutcome' | 'kind' | 'sourceStates'>,
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
        new Map(),
        sink,
        { ...scopeInfo, sourceStates: outcome.from.map((r) => r.target).filter((s): s is StateDecl => !!s) },
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
    hidden: Map<string, Hidden> = new Map(),
    sink?: ExpressionFactsSink,
    scopeInfo?: Pick<NonNullable<ExpressionFact['scope']>, 'owner' | 'command' | 'onCase' | 'targetOutcome' | 'kind' | 'sourceStates'>,
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
    const rootFact = scopeInfo
        ? {
              ...scopeInfo,
              fields: [...fields.values()].filter((x) => !cmd.params.some((parameter) => parameter === x)),
              parameters: cmd.params,
              lambdas: [] as Array<{ name: string; binding?: Expr }>,
          }
        : undefined;
    if (rootFact) sink?.({ expression: expr, scope: rootFact });
    const t = new ExprChecker(model, rules, sink, rootFact ? (name, binding) => rootFact.lambdas.push({ name, binding }) : undefined).check(expr, {
        ctx,
        fields,
        hidden,
        lambdas: [],
        present: new Set(),
    });
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
    kindHidden: Map<string, Hidden>,
    ctx: string,
    model: SourceModel,
    rules: RuleSink,
    sink?: ExpressionFactsSink,
): void {
    const states = statesOf(agg);
    const grouped = kindsOf(agg).flatMap((k) => k.cases.filter((c) => c.command.text === cmd.name).flatMap((c) => c.outcomes));
    const sourceStates = [
        ...new Set([
            ...cmd.transitions.flatMap((t) => t.from.map((r) => r.target)),
            ...[...cmd.outcomes, ...grouped].flatMap((o) => o.from.map((r) => r.target)),
        ]),
    ].filter((s): s is StateDecl => !!s);
    const fields = new Map<string, FieldDecl | ParamDecl>();
    const hidden = new Map<string, Hidden>(cmd.factory ? [] : kindHidden);
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
        const sources = sourceStates;
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
        const rootFact = {
            owner: agg,
            command: cmd,
            sourceStates,
            fields: [...fields.values()].filter((x) => !cmd.params.some((p) => p === x)),
            parameters: cmd.params,
            lambdas: [] as Array<{ name: string; binding?: Expr }>,
        };
        sink?.({ expression: req.expr, scope: rootFact });
        const t = new ExprChecker(model, rules, sink, (name, binding) => rootFact.lambdas.push({ name, binding })).check(req.expr, {
            ctx,
            fields,
            hidden,
            lambdas: [],
            present: new Set(),
        });
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

function checkInvariant(
    inv: InvariantDecl,
    scope: Scope,
    model: SourceModel,
    rules: RuleSink,
    sink?: ExpressionFactsSink,
    scopeInfo?: NonNullable<ExpressionFact['scope']>,
): void {
    checkDeclared(inv, rules);
    if (!inv.expr) return;
    const rootFact = scopeInfo ? { ...scopeInfo, lambdas: [...scopeInfo.lambdas] } : undefined;
    if (rootFact) sink?.({ expression: inv.expr, scope: rootFact });
    const t = new ExprChecker(model, rules, sink, rootFact ? (name, binding) => rootFact.lambdas.push({ name, binding }) : undefined).check(inv.expr, scope);
    if (t.k !== 'error' && !isBool(t)) {
        rules.error('M008', `Invariant '${inv.name}' must be a Bool expression, but has type '${showType(t)}'.`, inv.exprAt);
    }
}

type ExprOf<K extends Expr['k']> = Extract<Expr, { k: K }>;

class ExprChecker {
    private readonly symbols = new WeakMap<Expr, NonNullable<ExpressionFact['symbol']>>();
    private readonly comparisons = new WeakMap<Expr, NonNullable<ExpressionFact['comparison']>>();
    constructor(
        private readonly model: SourceModel,
        private readonly rules: RuleSink,
        private readonly sink?: ExpressionFactsSink,
        private readonly recordLambda?: (name: string, binding: Expr) => void,
    ) {}

    check(e: Expr, scope: Scope): Ty {
        const t = this.infer(e, scope);
        if (t.k !== 'error')
            this.sink?.({
                expression: e,
                type: t,
                ...(this.symbols.has(e) ? { symbol: this.symbols.get(e) } : {}),
                ...(this.comparisons.has(e) ? { comparison: this.comparisons.get(e) } : {}),
            });
        if (t.k === 'enumType' || t.k === 'unionType' || t.k === 'ctx') {
            this.rules.error('M009', `'${showType(t)}' is not a value.`, e.at);
            return ERROR;
        }
        return t;
    }

    private infer(e: Expr, scope: Scope): Ty {
        const type = this.inferNode(e, scope);
        if (type.k !== 'error')
            this.sink?.({
                expression: e,
                type,
                ...(this.symbols.has(e) ? { symbol: this.symbols.get(e) } : {}),
                ...(this.comparisons.has(e) ? { comparison: this.comparisons.get(e) } : {}),
            });
        return type;
    }

    private inferNode(e: Expr, scope: Scope): Ty {
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
                    this.rules.error('M009', `Operator '!' requires Bool, but got '${showType(t)}'.`, e.at);
                }
                return BOOL;
            }
            case 'count': {
                const t = this.check(e.collection, scope);
                if (t.k !== 'error' && t.k !== 'list') {
                    this.rules.error('M009', `'.length' is the size of a list or a string, not of '${showType(t)}'.`, e.collectionAt);
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
                if (t.k !== 'error' && !isTextual(t) && t.k !== 'list') {
                    this.rules.error('M009', `'.length' is the size of a list or a string, not of '${showType(t)}'.`, e.operandAt);
                }
                return COMPUTED_INT;
            }
            case 'matches': {
                const t = this.check(e.operand, scope);
                if (t.k !== 'error' && !isTextual(t)) {
                    this.rules.error('M009', `'.matches(…)' requires a String value, but got '${showType(t)}'.`, e.operandAt);
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
                const bound = (t: Ty, x: Expr): boolean => this.temporalLiteral(v, x, true) || ordered(v, t);
                if (v.k !== 'error' && lo.k !== 'error' && hi.k !== 'error' && !(bound(lo, e.lower) && bound(hi, e.upper))) {
                    this.rules.error('M009', `Range '${showType(lo)}..${showType(hi)}' cannot be applied to '${showType(v)}'.`, e.at);
                }
                return BOOL;
            }
            case 'quantifier': {
                this.recordLambda?.(e.param, e);
                const coll = this.check(e.collection, scope);
                let elem: Ty = ERROR;
                if (coll.k === 'list') elem = coll.elem;
                else if (coll.k !== 'error') {
                    this.rules.error(
                        'M009',
                        `'.${e.quantifier === 'all' ? 'every' : 'some'}(…)' requires a collection, but got '${showType(coll)}'.`,
                        e.collectionAt,
                    );
                }
                const inner: Scope = { ...scope, lambdas: [...scope.lambdas, [e.param, elem, e]] };
                const body = this.check(e.body, inner);
                if (body.k !== 'error' && !isBool(body)) {
                    this.rules.error(
                        'M009',
                        `The predicate of '.${e.quantifier === 'all' ? 'every' : 'some'}(…)' must be Bool, but has type '${showType(body)}'.`,
                        e.bodyAt,
                    );
                }
                return BOOL;
            }
            case 'unique': {
                const coll = this.check(e.collection, scope);
                let elem: Ty = ERROR;
                if (coll.k === 'list') elem = coll.elem;
                else if (coll.k !== 'error') {
                    this.rules.error('M009', `'.unique(…)' requires a collection, but got '${showType(coll)}'.`, e.collectionAt);
                }
                if (e.param === undefined) {
                    const ok = elem.k !== 'error' && equatable(elem, elem);
                    if (elem.k !== 'error') this.comparisons.set(e, ok ? comparisonKind(elem, elem, false) : 'notComparable');
                    if (elem.k !== 'error' && !ok) {
                        this.rules.error(
                            'M009',
                            `'.unique()' requires elements that can be compared with '==', but they have type '${showType(elem)}'.`,
                            e.collectionAt,
                        );
                    }
                    return BOOL;
                }
                this.recordLambda?.(e.param, e);
                const inner: Scope = { ...scope, lambdas: [...scope.lambdas, [e.param, elem, e]] };
                e.keys.forEach((key, i) => {
                    const t = this.check(key, inner);
                    if (t.k !== 'error') this.comparisons.set(key, equatable(t, t) ? comparisonKind(t, t, false) : 'notComparable');
                    if (t.k === 'error' || equatable(t, t)) return;
                    const what = `Key '${key.text}' of '.unique(…)'`;
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
                    this.rules.error('M009', `'.includes(…)' requires a collection, but got '${showType(coll)}'.`, e.collectionAt);
                } else if (coll.k === 'list' && coll.elem.k !== 'error' && x.k !== 'error' && !equatable(coll.elem, x)) {
                    const hint = x.k === 'opt' ? ' Optional values must be guarded with exists(...) first.' : '';
                    this.rules.error(
                        'M009',
                        `'.includes(…)' cannot compare elements of type '${showType(coll.elem)}' with '${showType(x)}'.${hint}`,
                        e.elementAt,
                    );
                }
                if (coll.k === 'list' && coll.elem.k !== 'error' && x.k !== 'error')
                    this.comparisons.set(e, equatable(coll.elem, x) ? comparisonKind(coll.elem, x, false) : 'notComparable');
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
            // `a && b` / `a implies b`: b is evaluated only when a holds; `a || b`: only when a does not. What a's
            // outcome there shows present (`exists(x)` holding, `!exists(x)` not holding) is present in b.
            const guardedPaths = guards(e.left, op !== 'or');
            const rightScope = { ...scope, present: new Set([...scope.present, ...guardedPaths]) };
            if (guardedPaths.length) this.sink?.({ expression: e.right, paths: guardedPaths });
            const r = this.check(e.right, rightScope);
            for (const [side, t, at] of [
                ['left', l, e.leftAt],
                ['right', r, e.rightAt],
            ] as const) {
                if (t.k !== 'error' && !isBool(t)) {
                    this.rules.error(
                        'M009',
                        `Operator '${LOGICAL_SPELLING[op]}' requires Bool operands, but the ${side} operand has type '${showType(t)}'.`,
                        at,
                    );
                }
            }
            return BOOL;
        }
        const l = this.check(e.left, scope);
        const r = this.check(e.right, scope);
        if (l.k === 'error' || r.k === 'error') return BOOL;
        // a date or time compared with a string literal: the literal is a value of its type (ADR 0038)
        const ordering = op !== '==' && op !== '!=';
        if (this.temporalLiteral(l, e.right, ordering) || this.temporalLiteral(r, e.left, ordering)) {
            this.comparisons.set(e, ordering ? 'ordered' : 'primitive');
            return BOOL;
        }
        const ok = op === '==' || op === '!=' ? equatable(l, r) : ordered(l, r);
        this.comparisons.set(e, ok ? comparisonKind(l, r, ordering) : 'notComparable');
        if (!ok) {
            const [lb, rb] = [basePrimitive(l), basePrimitive(r)];
            if (l.k !== 'opt' && r.k !== 'opt' && (isTemporal(lb) || isTemporal(rb)) && lb !== rb) {
                this.rules.error(
                    'M009',
                    `Operator '${op}' compares '${showType(l)}' with '${showType(r)}'; values of different date and time types are not comparable.`,
                    e.at,
                    'convert where the time zone is known (in your code), and pass the result as a parameter of the same type',
                );
                return BOOL;
            }
            const hint = l.k === 'opt' || r.k === 'opt' ? ' Optional values must be guarded with exists(...) first.' : '';
            this.rules.error('M009', `Operator '${op}' cannot be applied to '${showType(l)}' and '${showType(r)}'.${hint}`, e.at);
        }
        return BOOL;
    }

    /**
     * Whether `other` is a string literal compared with a value of a date or time type `t` (ADR 0038): it is then one of
     * that type's values, or M009 says what it should look like.
     */
    private temporalLiteral(t: Ty, other: Expr, ordering = false): boolean {
        const base = basePrimitive(t);
        if (other.k !== 'string' || t.k === 'opt' || t.k === 'list' || !isTemporal(base)) return false;
        if (ordering && !isOrderedTemporal(base)) {
            this.rules.error('M009', `A ${base} has no order: compare it with '==' or '!='.`, other.at);
            return true;
        }
        if (canonicalTemporal(base, other.value) === undefined)
            this.rules.error('M009', `"${other.value}" is not a ${base}: write ${TEMPORAL_FORM[base]}.`, other.at, `for example "${TEMPORAL_EXAMPLE[base]}"`);
        return true;
    }

    private name(name: string, node: Expr, scope: Scope): Ty {
        for (let i = scope.lambdas.length - 1; i >= 0; i--) {
            if (scope.lambdas[i][0] === name) {
                this.symbols.set(node, {
                    kind: scope.implicitValueId && name === 'value' ? 'value' : 'lambdaVariable',
                    name,
                    ...(scope.implicitValueId && name === 'value' ? { id: scope.implicitValueId } : {}),
                    ...(scope.lambdas[i][2] ? { binding: scope.lambdas[i][2] } : {}),
                });
                return narrow(scope.lambdas[i][1], name, scope);
            }
        }
        const field = scope.fields.get(name);
        if (field) {
            // a state (`O#S`), kind (`O/K`) or command (`O:c`) site belongs to its element `O`
            const ownerId = node.at.elementId?.replace(/[#/:].*$/, '');
            const owner = this.model.elements.find((element) => element.id === ownerId);
            const inherited = owner && 'fieldSets' in owner && includedFields(owner).some((entry) => entry.field === field);
            this.symbols.set(node, {
                kind: field.kind === 'param' ? 'parameter' : 'field',
                name,
                declaration: field,
                ...(inherited ? { id: `${owner.id}.${name}` } : {}),
            });
            return narrow(memberType(field), name, scope);
        }
        const decl = lookupVisible(this.model, scope.ctx, name);
        if (decl?.kind === 'enum') {
            this.symbols.set(node, { kind: 'type', name, declaration: decl });
            return { k: 'enumType', decl };
        }
        if (decl?.kind === 'union') {
            this.symbols.set(node, { kind: 'type', name, declaration: decl });
            return { k: 'unionType', decl };
        }
        if (this.model.contexts.includes(name)) {
            this.symbols.set(node, { kind: 'context', name, id: name });
            return { k: 'ctx', name };
        }
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
                if (el?.kind === 'enum') {
                    this.symbols.set(e, { kind: 'type', name: m, declaration: el });
                    return { k: 'enumType', decl: el };
                }
                if (el?.kind === 'union') {
                    this.symbols.set(e, { kind: 'type', name: m, declaration: el });
                    return { k: 'unionType', decl: el };
                }
                const names = elementsOf(this.model, recv.name)
                    .filter((x) => x.kind === 'enum' || x.kind === 'union')
                    .map((x) => x.name);
                this.rules.error('M001', `Context '${recv.name}' has no enum or union named '${m}'.`, e.memberAt, didYouMean(m, names));
                return ERROR;
            }
            case 'enumType': {
                const value = recv.decl.values.find((v) => v.name === m);
                if (value) {
                    this.symbols.set(e, { kind: 'enumValue', name: m, declaration: value });
                    return { k: 'enum', decl: recv.decl as EnumDecl };
                }
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
            }
            case 'unionType':
                const variant = recv.decl.variants.find((v) => v.name === m);
                if (variant) {
                    this.symbols.set(e, { kind: 'unionTag', name: m, declaration: variant });
                    return tagOf(recv.decl);
                }
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
                if (m === discriminatorOf(recv.decl)) {
                    this.symbols.set(e, { kind: 'discriminator', name: m, id: recv.decl.id });
                    return tagOf(recv.decl);
                }
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
                if (f) {
                    this.symbols.set(e, { kind: 'field', name: m, declaration: f, id: fieldId(recv.decl.id, m) });
                    return narrow(memberType(f), pathOf(e) ?? '', scope);
                }
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

function comparisonKind(l: Ty, r: Ty, ordering: boolean): NonNullable<ExpressionFact['comparison']> {
    if (ordering) return 'ordered';
    if (l.k === 'tag' && r.k === 'tag') return 'enumValue';
    if (l.k === 'struct' && r.k === 'struct' && l.decl === r.decl) return l.decl.kind === 'entity' ? 'entityId' : 'valueObjectStructural';
    if (l.k === 'union' && r.k === 'union' && l.decl === r.decl) return 'unionStructural';
    if (l.k === 'enum' && r.k === 'enum') return 'enumValue';
    if (isDomainPrimitive(l) || isDomainPrimitive(r)) return 'domainPrimitive';
    return 'primitive';
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
/** How a logical operator is written (Phase 2): `implies` only in models not yet migrated. */
const LOGICAL_SPELLING: Readonly<Record<'and' | 'or' | 'implies', string>> = { and: '&&', or: '||', implies: 'implies' };

/**
 * The optional paths an expression shows present when it evaluates to `holds`: `exists(x)` holding shows `x`; `!a`
 * flips; `a && b` holding shows what both show holding; `a || b` not holding shows what both show not holding; and
 * `a implies b` not holding shows what `a` shows holding and `b` not holding.
 */
function guards(e: Expr, holds = true): string[] {
    if (e.k === 'exists') {
        const p = pathOf(e.operand);
        return p && holds ? [p] : [];
    }
    if (e.k === 'not') return guards(e.operand, !holds);
    if (e.k === 'binary' && e.op === 'and' && holds) return [...guards(e.left, true), ...guards(e.right, true)];
    if (e.k === 'binary' && e.op === 'or' && !holds) return [...guards(e.left, false), ...guards(e.right, false)];
    if (e.k === 'binary' && e.op === 'implies' && !holds) return [...guards(e.left, true), ...guards(e.right, false)];
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
        return a.k === 'prim' && b.k === 'prim' && a.name === b.name && (isOrderedTemporal(a.name) || a.name === 'String');
    });
}

/** String-like values: String, UUID, and domain primitives over them. */
const isTextual = (t: Ty): boolean => {
    const b = basePrimitive(t);
    return b === 'String' || b === 'UUID';
};
