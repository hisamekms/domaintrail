import type { RuleSink } from '../diagnostics.js';
import type { ModelingRuleId } from '../rule-ids.js';
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
    type FunctionDecl,
    type InvariantDecl,
    type KindDecl,
    type OutcomeDecl,
    type ParamDecl,
    type RequirementDecl,
    type SourceModel,
    type StateDecl,
    type UnionDecl,
} from '../source-model.js';
import { canonicalTemporal, isOrderedTemporal, isTemporal, TEMPORAL_EXAMPLE, TEMPORAL_FORM } from '../temporal.js';
import { fieldId } from '../ids.js';
import { lifecyclesOf } from '../lifecycle.js';
import {
    BOOL,
    COMPUTED_INT,
    ERROR,
    basePrimitive,
    isBool,
    isDomainPrimitive,
    isNumeric,
    memberType,
    sameType,
    scaleOf,
    showType,
    type AggregateFrame,
    type AggregatePair,
    type Ty,
} from '../types.js';

export interface ExpressionFact {
    expression: Expr;
    type?: Ty;
    comparison?: 'primitive' | 'domainPrimitive' | 'entityStructural' | 'valueObjectStructural' | 'unionStructural' | 'ordered' | 'enumValue' | 'notComparable';
    symbol?: {
        kind:
            | 'field'
            | 'parameter'
            | 'lambdaVariable'
            | 'value'
            | 'state'
            | 'kind'
            | 'enumValue'
            | 'type'
            | 'unionTag'
            | 'discriminator'
            | 'context'
            | 'function'
            /**
             * `before` / `after` in `changes x = …` and `ensures`: the aggregate before / after the outcome; `this` in
             * `requires`, choice rules and the aggregate's invariants: the aggregate itself (a `match` subject).
             */
            | 'frame';
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
    /**
     * `before` / `after` where an outcome's contract is checked (`changes x = …`, `ensures`); `this` where the rule is
     * about the aggregate as it is (`requires`, choice rules, the aggregate's own invariants).
     */
    frames?: ReadonlyMap<string, Ty>;
}

interface Hidden {
    message: string;
    hint: string;
    /** The code of the diagnostic: M010 (a field not in scope) unless given. */
    code?: ModelingRuleId;
    /** For `this.x` where `this` is not in scope: what to write instead. */
    memberHint?: (member: string) => string;
}

/** The fields every one of `list` has, with one type (none for an empty list). */
function fieldsInEvery(list: readonly ReadonlyMap<string, FieldDecl | ParamDecl>[]): Map<string, FieldDecl | ParamDecl> {
    if (!list.length) return new Map();
    const [first, ...rest] = list;
    return new Map([...first!].filter(([n, f]) => rest.every((r) => r.has(n) && sameType(memberType(r.get(n)!), memberType(f)))));
}

/** The fields of a kind and a state beyond the common ones. */
const pairFields = (kind: KindDecl | undefined, state: StateDecl | undefined): Map<string, FieldDecl | ParamDecl> =>
    new Map([...(kind ? kindFields(kind) : []), ...(state ? fieldsOf(state.members) : [])].map((f) => [f.name, f]));

/** The states (on the frame's side) and the kinds of a frame's pairs, each once, in order. */
const frameStates = (a: AggregateFrame): StateDecl[] => [...new Set(a.pairs.flatMap((p) => p[a.side] ?? []))];
const frameKinds = (a: AggregateFrame): KindDecl[] => [...new Set(a.pairs.flatMap((p) => p.kind ?? []))];

/**
 * The aggregate as a `before`, `after` or `this` frame: the common fields and those it has in every one of its pairs
 * (`before.x`), and what `match` on it chooses among.
 */
function aggregateFrameTy(name: 'before' | 'after' | 'this', aggregate: AggregateFrame): Ty {
    const own = fieldsInEvery(aggregate.pairs.map((p) => pairFields(p.kind, p[aggregate.side])));
    return { k: 'frame', name, fields: new Map([...aggregate.common, ...own]), aggregate };
}

/**
 * Where `this` is not in scope: in `changes x = …` and `ensures`, which have `before` and `after` (`after` only in
 * `ensures`, `before` only after a command that takes the aggregate), each hint naming those in scope there.
 */
const THIS_IN_CONTRACT = (where: 'changes' | 'ensures', factory: boolean): Hidden => {
    const message = `'this' is not in scope in 'changes x = …' and 'ensures', where it would be ambiguous: 'before' is the aggregate before the outcome, 'after' the aggregate after it (in 'ensures').`;
    if (where === 'ensures' && factory)
        return { code: 'M001', message, hint: `write 'after' (a create has no 'before'), e.g. 'match (after) { … }'`, memberHint: (m) => `write 'after.${m}'` };
    if (where === 'ensures')
        return {
            code: 'M001',
            message,
            hint: `write 'before' or 'after', e.g. 'match (before) { … }'`,
            memberHint: (m) => `write 'before.${m}' or 'after.${m}'`,
        };
    if (factory)
        return {
            code: 'M001',
            message,
            hint: `a create's 'changes x = …' is over its parameters; relate the aggregate made in 'ensures' with 'after'`,
            memberHint: (m) => `give the value by the parameters, or state it in 'ensures' with 'after.${m}'`,
        };
    return { code: 'M001', message, hint: `write 'before', e.g. 'match (before) { … }'`, memberHint: (m) => `write 'before.${m}'` };
};

/** In a create command's requirements and choice rules: no aggregate yet. */
const THIS_IN_FACTORY = (cmd: string): Hidden => ({
    code: 'M001',
    message: `'this' is not in scope in the rules of 'create command ${cmd}': there is no aggregate before it is made.`,
    hint: `decide by the parameters of '${cmd}'`,
});

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
    checkFunctions(model, rules, sink);
}

/** The functions an expression of a context can call: its own, then those of the shared contexts. */
export function functionNamed(model: SourceModel, ctx: string, name: string): FunctionDecl | undefined {
    const fns = model.fragments.flatMap((f) => f.functions);
    return fns.find((f) => f.context === ctx && f.name === name) ?? fns.find((f) => model.sharedContexts.includes(f.context) && f.name === name);
}

/** The type a function returns, as a field of its declared type and multiplicity. */
const returnType = (f: FunctionDecl): Ty =>
    memberType({
        kind: 'param',
        name: f.name,
        type: f.returns,
        multiplicity: f.multiplicity,
        at: f.at,
        nameAt: f.nameAt,
        labelAt: f.labelAt,
        typeAt: f.returnsAt,
    } as ParamDecl);

/** M032: a function's body has its type, and no function calls itself directly or through others. */
function checkFunctions(model: SourceModel, rules: RuleSink, sink?: ExpressionFactsSink): void {
    const fns = model.fragments.flatMap((f) => f.functions);
    for (const f of fns) {
        const fields = new Map<string, FieldDecl | ParamDecl>(f.params.map((p) => [p.name, p]));
        const rootFact = { owner: f, fields: [], parameters: f.params, lambdas: [] as { name: string; binding: Expr }[] };
        sink?.({ expression: f.expr, scope: rootFact });
        const t = new ExprChecker(model, rules, sink, (name, binding) => rootFact.lambdas.push({ name, binding })).check(f.expr, {
            ctx: f.context,
            fields,
            hidden: new Map(),
            lambdas: [],
            present: new Set(),
        });
        const declared = returnType(f);
        if (t.k !== 'error' && declared.k !== 'error' && !assignable(declared, t)) {
            const overflow = scaleOverflow(declared, t);
            const show = overflow ? showScaled : showType;
            rules.error(
                overflow ? 'M009' : 'M032',
                `Function '${f.name}' returns '${show(declared)}', but its body has type '${show(t)}'.`,
                f.expr.at,
                overflow && roundHint(f.expr, overflow),
            );
        }
    }
    // a call graph without cycles: every function is pure and terminates
    const calls = (x: Expr): string[] => (x.k === 'call' ? [x.name, ...x.args.flatMap(calls)] : childExprs(x).flatMap(calls));
    const callees = new Map(fns.map((f) => [f, calls(f.expr).flatMap((n) => functionNamed(model, f.context, n) ?? [])]));
    const reported = new Set<FunctionDecl>();
    const visit = (f: FunctionDecl, path: FunctionDecl[]): void => {
        if (path.includes(f)) {
            const cycle = path.slice(path.indexOf(f));
            if (!cycle.some((c) => reported.has(c))) {
                for (const c of cycle) reported.add(c);
                rules.error('M032', `Function '${f.name}' calls itself: ${[...cycle, f].map((c) => c.name).join(' -> ')}; functions cannot recurse.`, f.nameAt);
            }
            return;
        }
        for (const g of callees.get(f) ?? []) visit(g, [...path, f]);
    };
    for (const f of fns) visit(f, []);
}

/** The direct subexpressions of an expression, in order. */
function childExprs(x: Expr): Expr[] {
    switch (x.k) {
        case 'member':
            return [x.receiver];
        case 'not':
        case 'exists':
        case 'length':
        case 'matches':
            return [x.operand];
        case 'round':
            return [x.operand, x.scale];
        case 'count':
            return [x.collection];
        case 'binary':
            return [x.left, x.right];
        case 'range':
            return [x.operand, x.lower, x.upper];
        case 'unique':
            return [x.collection, ...x.keys];
        case 'contains':
            return [x.collection, x.element];
        case 'quantifier':
            return [x.collection, x.body];
        case 'conditional':
            return [x.test, x.ifTrue, x.ifFalse];
        case 'list':
            return x.items.map((i) => i.value);
        case 'listMethod':
            return x.body ? [x.collection, x.body] : [x.collection];
        case 'call':
            return x.args;
        case 'match':
            return [x.subject, ...x.cases.map((c) => c.body)];
        default:
            return [];
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

    // `this`, `before` and `after` as `match` subjects: the (kind, state) pairs the aggregate can be in there
    const validStates = new Map<string, ReadonlySet<string>>(
        kinds.length && states.length ? lifecyclesOf(agg, true).map((l) => [l.kind, new Set(l.validStates ?? [])]) : [],
    );
    const frame = (name: 'before' | 'after' | 'this', pairs: readonly AggregatePair[], group: object, statesWhat: string, kindsWhat: string): Ty =>
        aggregateFrameTy(name, {
            agg,
            common,
            pairs,
            side: name === 'after' ? 'to' : 'from',
            group,
            statesWhat,
            kindsWhat: `the kinds of ${kindsWhat}`,
        });
    /** The kinds a rule of a command is for: its own kind, or every kind (none: `[undefined]`). */
    const kindsFor = (own: KindDecl | undefined): readonly (KindDecl | undefined)[] => (own ? [own] : kinds.length ? kinds : [undefined]);
    /** The pairs of the aggregate before a rule of `kind`, in one of `sources` (any, without states). */
    const sourcePairs = (kind: KindDecl | undefined, sources: readonly StateDecl[]): AggregatePair[] =>
        states.length ? [...new Set(sources)].map((from) => ({ ...(kind && { kind }), from })) : [{ ...(kind && { kind }) }];
    /** The sources of a command for a kind: its transitions', its outcomes' and those of the kind's `on` case. */
    const sourcesFor = (cmd: CommandDecl, kind: KindDecl | undefined): StateDecl[] =>
        [
            ...cmd.transitions.flatMap((t) => t.from),
            ...cmd.outcomes.flatMap((o) => o.from),
            ...(kind?.cases.filter((c) => c.command.text === cmd.name).flatMap((c) => c.outcomes.flatMap((o) => o.from)) ?? []),
        ].flatMap((r) => (r.target ? [r.target] : []));
    /** `this` in the rules of one state or kind: the aggregate in that one state or kind, whose fields are read by name. */
    const thisIn = (what: 'state' | 'kind', name: string): Hidden => ({
        code: 'M001',
        message: `'this' is not in scope in an invariant of ${what} '${name}', which holds in that one ${what}: its fields are read by name.`,
        hint: `read the fields by name, or write the rule as an invariant of '${agg.name}' with 'match (this) { ${name} { … } => …, … }'`,
        memberHint: (m) => `write '${m}'`,
    });

    // Aggregate-level invariants: common fields only, applied to every state.
    const anyPairs: AggregatePair[] = kinds.length
        ? kinds.flatMap((kind) => (states.length ? states.filter((s) => validStates.get(kind.name)?.has(s.name)).map((from) => ({ kind, from })) : [{ kind }]))
        : states.map((from) => ({ from }));
    const self = frame('this', anyPairs, {}, `the states of '${agg.name}'`, `'${agg.name}'`);
    for (const inv of invariantsOf(agg.members)) {
        checkInvariant(
            inv,
            {
                ctx,
                fields: common,
                hidden: new Map([...stateOnly(), ...kindOnly()]),
                lambdas: [],
                present: new Set(),
                frames: new Map([['this', self]]),
            },
            model,
            rules,
            sink,
            {
                owner: agg,
                fields: [...common.values()],
                parameters: [],
                lambdas: [],
            },
        );
    }
    // Kind-level invariants: common + that kind's own fields, applied to every state of the kind.
    for (const k of kinds)
        for (const inv of invariantsOf(k.members))
            checkInvariant(
                inv,
                {
                    ctx,
                    fields: withKind(k),
                    hidden: new Map([...stateOnly(), ...kindOnly(k.name), ['this', thisIn('kind', k.name)]]),
                    lambdas: [],
                    present: new Set(),
                },
                model,
                rules,
                sink,
                { owner: k, fields: [...withKind(k).values()], parameters: [], lambdas: [], kind: k },
            );
    // State-level invariants: common + that state's own fields.
    for (const s of states) {
        const fields = new Map(common);
        for (const f of fieldsOf(s.members)) fields.set(f.name, f);
        const hidden = new Map([...stateOnly(s.name), ...kindOnly(), ['this', thisIn('state', s.name)]]);
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
    const stateFields = (s: StateDecl): Map<string, FieldDecl | ParamDecl> => new Map(fieldsOf(s.members).map((f) => [f.name, f]));
    const contract = (
        cmd: CommandDecl,
        own: KindDecl | undefined,
        from: readonly StateDecl[],
        to: readonly StateDecl[],
        changes: CommandDecl['changes'],
        ensures: Expr | undefined,
        /** The outcome, or the command of the shorthand form: `outcome 'paused'`. */
        label: string,
        /** The (source, target) pairs of the outcome, or of the shorthand form's transitions. */
        transitions: readonly [StateDecl | undefined, StateDecl | undefined][],
    ): void => {
        if (!changes.some((c) => c.value) && !ensures) return;
        const base = withKind(own);
        const params = new Map<string, FieldDecl | ParamDecl>(cmd.params.map((p) => [p.name, p]));
        // before and after are of one transition of one kind: a case of either narrows both
        const pairs = kindsFor(own).flatMap((kind) =>
            (transitions.length ? transitions : [[undefined, undefined] as const]).map(([f, t]): AggregatePair => ({
                ...(kind && { kind }),
                ...(f && { from: f }),
                ...(t && { to: t }),
            })),
        );
        const group = {};
        const before: Ty | undefined = cmd.factory ? undefined : frame('before', pairs, group, `the source states of ${label}`, label);
        const after: Ty = frame('after', pairs, group, `the target states of ${label}`, label);
        const scope = (frames: [string, Ty][], where: 'changes' | 'ensures'): Scope => ({
            ctx,
            fields: params,
            hidden: new Map([['this', THIS_IN_CONTRACT(where, cmd.factory)]]),
            lambdas: [],
            present: new Set(),
            frames: new Map(frames),
        });
        // `before` / `after` are the frames here: a lambda of that name would read as one and be another
        const shadowing = (x: Expr): void => {
            const names =
                x.k === 'listMethod' || x.k === 'unique' || x.k === 'quantifier' ? [x.param] : x.k === 'match' ? x.cases.flatMap((c) => c.bindings) : [];
            for (const n of names)
                if (n === 'before' || n === 'after')
                    rules.error(
                        'M021',
                        `'${n}' is the aggregate ${n} the outcome in 'changes' and 'ensures': it cannot name a lambda parameter or a binding here.`,
                        x.at,
                        `give it another name`,
                    );
            childExprs(x).forEach(shadowing);
        };
        for (const c of changes) if (c.value) shadowing(c.value);
        if (ensures) shadowing(ensures);
        for (const c of changes) {
            if (!c.value) continue;
            const t = new ExprChecker(model, rules, sink).check(c.value, scope(before ? [['before', before]] : [], 'changes'));
            // the field in each target that has it (the shorthand form may have several targets): each takes the value
            const common = base.get(c.name);
            const fields = common ? [common] : to.flatMap((s) => (stateFields(s).has(c.name) ? [stateFields(s).get(c.name)!] : []));
            if (!fields.length) {
                // M028 reports a field the aggregate does not have at all
                if (to.length && statesOf(agg).some((s) => stateFields(s).has(c.name)))
                    rules.error(
                        'M021',
                        `'changes ${c.name} = …': no target state of the outcome (${to.map((s) => `'${s.name}'`).join(', ')}) has field '${c.name}'.`,
                        c.at,
                    );
                continue;
            }
            if (t.k === 'error') continue;
            const reported = new Set<string>();
            for (const f of fields) {
                if (assignable(memberType(f), t)) continue;
                const overflow = scaleOverflow(memberType(f), t);
                const show = overflow ? showScaled : showType;
                const message = `'${c.name}' is a '${show(memberType(f))}', but '${c.value.text}' is a '${show(t)}'.`;
                if (reported.has(message)) continue;
                reported.add(message);
                rules.error(overflow ? 'M009' : 'M021', message, c.value.at, overflow && roundHint(c.value, overflow));
            }
        }
        if (!ensures) return;
        const t = new ExprChecker(model, rules, sink).check(
            ensures,
            scope([...(before ? [['before', before] as [string, Ty]] : []), ['after', after]], 'ensures'),
        );
        if (t.k !== 'error' && !isBool(t)) rules.error('M021', `'ensures' must be a Bool expression, but has type '${showType(t)}'.`, ensures.at);
        // an equality that determines a field of `after` alone belongs in `changes x = …`
        const conjuncts = (x: Expr): Expr[] => (x.k === 'binary' && x.op === 'and' ? [...conjuncts(x.left), ...conjuncts(x.right)] : [x]);
        const mentionsAfter = (x: Expr): boolean => (x.k === 'name' && x.name === 'after') || childExprs(x).some(mentionsAfter);
        for (const c of conjuncts(ensures)) {
            if (c.k !== 'binary' || c.op !== '==') continue;
            const [field, other] =
                c.left.k === 'member' && c.left.receiver.k === 'name' && c.left.receiver.name === 'after'
                    ? [c.left, c.right]
                    : c.right.k === 'member' && c.right.receiver.k === 'name' && c.right.receiver.name === 'after'
                      ? [c.right, c.left]
                      : [];
            if (field?.k === 'member' && other && !mentionsAfter(other))
                rules.error('M021', `'${c.text}' determines '${field.member}': write 'changes ${field.member} = ${other.text}' instead.`, c.at);
        }
    };
    for (const cmd of commandsOf(agg)) {
        // a kind's command sees its kind's fields; a common command the common ones
        const own = kindNamed(cmd.ofKind);
        const targets = (o: { to: { target?: StateDecl } }): StateDecl[] => (o.to.target ? [o.to.target] : []);
        const sources = (o: { from: { target?: StateDecl }[] }): StateDecl[] => o.from.flatMap((r) => (r.target ? [r.target] : []));
        /** The (source, target) pairs of an outcome. */
        const steps = (o: OutcomeDecl): [StateDecl | undefined, StateDecl | undefined][] =>
            (sources(o).length ? sources(o) : [undefined]).map((f) => [f, o.to.target]);
        for (const o of cmd.outcomes) contract(cmd, own, sources(o), targets(o), o.changes, o.ensures, `outcome '${o.name}'`, steps(o));
        for (const k of kinds)
            for (const c of k.cases.filter((x) => x.command.text === cmd.name))
                for (const o of c.outcomes) contract(cmd, k, sources(o), targets(o), o.changes, o.ensures, `outcome '${o.name}'`, steps(o));
        if (!cmd.outcomes.length)
            contract(
                cmd,
                own,
                cmd.transitions.flatMap((tr) => tr.from.flatMap((r) => (r.target ? [r.target] : []))),
                cmd.transitions.flatMap((tr) => tr.to.flatMap((r) => (r.target ? [r.target] : []))),
                cmd.changes,
                cmd.ensures,
                `command '${cmd.name}'`,
                cmd.transitions.flatMap((tr) =>
                    (tr.from.length ? tr.from.map((r) => r.target) : [undefined]).flatMap((f) =>
                        tr.to.map((r): [StateDecl | undefined, StateDecl | undefined] => [f, r.target]),
                    ),
                ),
            );
        // `this` in a decision rule: the aggregate before the command, of one of its kinds in one of that kind's sources
        const selfBefore = (pairs: readonly AggregatePair[], label: string): Ty => frame('this', pairs, {}, `the source states of ${label}`, label);
        if (cmd.requirements.length)
            checkRequirements(
                agg,
                cmd,
                withKind(own),
                kindOnly(own?.name),
                ctx,
                model,
                rules,
                sink,
                selfBefore(
                    kindsFor(own).flatMap((k) => sourcePairs(k, sourcesFor(cmd, k))),
                    `command '${cmd.name}'`,
                ),
            );
        for (const outcome of cmd.outcomes)
            checkChoice(
                outcome,
                cmd,
                withKind(own),
                ctx,
                model,
                rules,
                sink,
                { owner: agg, command: cmd, targetOutcome: outcome, kind: own },
                selfBefore(
                    kindsFor(own).flatMap((k) => sourcePairs(k, sources(outcome))),
                    `outcome '${outcome.name}'`,
                ),
            );
        for (const k of kinds) {
            for (const c of k.cases.filter((c) => c.command.text === cmd.name)) {
                const sources = c.outcomes.flatMap((o) => o.from.map((r) => r.target)).filter((s): s is StateDecl => !!s);
                for (const r of c.requirements) {
                    checkDeclared(r, rules);
                    checkDecisionExpr(
                        r.expr,
                        `Requirement '${r.name}'`,
                        r.exprAt,
                        cmd,
                        withKind(k),
                        ctx,
                        model,
                        rules,
                        sources,
                        kindOnly(k.name),
                        sink,
                        {
                            owner: k,
                            command: cmd,
                            onCase: c,
                            sourceStates: sources,
                            kind: k,
                        },
                        selfBefore(sourcePairs(k, sources), `'on ${cmd.name}' of kind '${k.name}'`),
                    );
                }
                for (const outcome of c.outcomes)
                    checkChoice(
                        outcome,
                        cmd,
                        withKind(k),
                        ctx,
                        model,
                        rules,
                        sink,
                        { owner: k, command: cmd, onCase: c, targetOutcome: outcome, kind: k },
                        selfBefore(
                            sourcePairs(
                                k,
                                outcome.from.flatMap((r) => (r.target ? [r.target] : [])),
                            ),
                            `outcome '${outcome.name}'`,
                        ),
                    );
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
    self: Ty,
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
        self,
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
    /** `this`: the aggregate before the command (none for a create command). */
    self?: Ty,
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
        hidden: new Map([...hidden, ...(cmd.factory ? [['this', THIS_IN_FACTORY(cmd.name)] as const] : [])]),
        lambdas: [],
        present: new Set(),
        ...(!cmd.factory && self && { frames: new Map([['this', self]]) }),
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
    sink: ExpressionFactsSink | undefined,
    /** `this`: the aggregate before the command, of one of its kinds in one of that kind's source states. */
    self: Ty,
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
    const hidden = new Map<string, Hidden>(cmd.factory ? [['this', THIS_IN_FACTORY(cmd.name)]] : kindHidden);
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
                hint: `bind it in a case of 'match (this)': 'match (this) { ${where[0]} { ${name} } => … }'; or declare '${name}' with the same type in every source state of '${cmd.name}' (or among the common fields)`,
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
            ...(!cmd.factory && { frames: new Map([['this', self]]) }),
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
    /** The subjects of `match`, where `this` may stand. */
    private readonly matchSubjects = new WeakSet<Expr>();
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
                return { k: 'prim', name: 'Decimal', literal: true, scale: e.value.split('.')[1]?.length ?? 0 };
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
                    this.rules.error('M009', `'!= null' and '== null' compare an optional value, but '${showType(t)}' is always present.`, e.operandAt);
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
            case 'round': {
                // `x.round(n)`: `x` rounded half-even to `n` digits after the point, a computed `Decimal(n)`
                const t = this.check(e.operand, scope);
                if (t.k === 'error') return ERROR;
                if (basePrimitive(t) !== 'Decimal' || t.k === 'id') {
                    this.rules.error(
                        'M009',
                        `'.round(n)' rounds a Decimal, but '${e.operand.text}' is a '${showType(t)}'.${basePrimitive(t) === 'Int' ? ' An Int needs no rounding.' : ''}`,
                        e.operandAt,
                    );
                    return ERROR;
                }
                if (e.scale.k !== 'int' || e.scale.negative || !Number.isSafeInteger(e.scale.value)) {
                    this.rules.error(
                        'M009',
                        `'.round(n)' takes the digits after the point as an Int literal of 0 or more, but got '${e.scale.text}'.`,
                        e.scaleAt,
                    );
                    return ERROR;
                }
                if (e.scale.value > MAX_ROUND_SCALE) {
                    this.rules.error('M009', `'.round(n)' rounds to at most ${MAX_ROUND_SCALE} digits after the point, but got '${e.scale.text}'.`, e.scaleAt);
                    return ERROR;
                }
                this.check(e.scale, scope);
                return { k: 'prim', name: 'Decimal', computed: true, scale: e.scale.value };
            }
            case 'match': {
                // `match (u) { V { f } => e, … }`: every variant of the union once, each body of one type
                this.matchSubjects.add(e.subject);
                const subject = this.check(e.subject, scope);
                if (subject.k === 'error') return ERROR;
                if (subject.k === 'frame' && subject.aggregate) return this.matchAggregate(e, subject.aggregate, scope);
                if (subject.k !== 'union') {
                    this.rules.error(
                        'M009',
                        `'match' takes a union value or the aggregate ('this', 'before', 'after'), but '${e.subject.text}' is a '${showType(subject)}'.`,
                        e.subjectAt,
                    );
                    return ERROR;
                }
                const u = subject.decl;
                const seen = new Set<string>();
                let result: Ty | undefined;
                for (const c of e.cases) {
                    const variant = u.variants.find((v) => v.name === c.variant);
                    if (!variant) {
                        this.rules.error(
                            'M009',
                            `Union '${u.name}' has no variant '${c.variant}'.`,
                            c.variantAt,
                            didYouMean(
                                c.variant,
                                u.variants.map((v) => v.name),
                            ),
                        );
                        continue;
                    }
                    if (c.tag && c.tag.key !== discriminatorOf(u))
                        this.rules.error(
                            'M009',
                            `The tag of union '${u.name}' is '${discriminatorOf(u)}', not '${c.tag.key}'.`,
                            c.tag.at,
                            `write '${discriminatorOf(u)}: ${u.name}.${c.variant}'`,
                        );
                    if (c.tag && c.tag.union !== u.name)
                        this.rules.error(
                            'M009',
                            `'${c.tag.union}.${c.variant}' is not a variant of '${u.name}', the union matched.`,
                            c.variantAt,
                            `write '${discriminatorOf(u)}: ${u.name}.${c.variant}'`,
                        );
                    if (seen.has(c.variant)) this.rules.error('M009', `Variant '${c.variant}' has two cases.`, c.variantAt);
                    seen.add(c.variant);
                    const fields = new Map(fieldsOf(variant.members).map((f) => [f.name, f]));
                    const lambdas = [...scope.lambdas];
                    for (const name of c.bindings) {
                        this.reserved(name, c.at);
                        const f = fields.get(name);
                        if (!f) this.rules.error('M009', `Variant '${c.variant}' has no field '${name}'.`, c.at, didYouMean(name, [...fields.keys()]));
                        lambdas.push([name, f ? memberType(f) : ERROR, c.body]);
                    }
                    const t = this.check(c.body, { ...scope, lambdas });
                    if (t.k === 'error') continue;
                    const joined = joinCase(result, t);
                    if (!joined) {
                        this.rules.error(
                            'M009',
                            `The cases of 'match' give '${showType(result!)}' and '${showType(t)}': every case must have the same type.`,
                            c.at,
                        );
                        continue;
                    }
                    result = joined;
                }
                const missing = u.variants.filter((v) => !seen.has(v.name)).map((v) => v.name);
                if (missing.length) {
                    this.rules.error('M009', `'match' over '${u.name}' has no case for ${missing.map((m) => `'${m}'`).join(', ')}.`, e.at);
                    return ERROR;
                }
                return result ?? ERROR;
            }
            case 'call': {
                // `name(args)`: a function of this context or of a shared context, with arguments of its parameters' types
                const f = functionNamed(this.model, scope.ctx, e.name);
                const args = e.args.map((a) => this.check(a, scope));
                if (!f) {
                    this.rules.error('M032', `No function '${e.name}' in context '${scope.ctx}' or a shared context.`, e.nameAt);
                    return ERROR;
                }
                this.symbols.set(e, { kind: 'function', name: e.name, declaration: f, id: f.id });
                if (args.length !== f.params.length) {
                    this.rules.error('M032', `Function '${f.name}' takes ${f.params.length} argument(s), but ${args.length} are given.`, e.at);
                    return ERROR;
                }
                for (const [i, p] of f.params.entries()) {
                    const want = memberType(p);
                    const got = args[i]!;
                    if (got.k !== 'error' && want.k !== 'error' && !assignable(want, got)) {
                        const overflow = scaleOverflow(want, got);
                        const show = overflow ? showScaled : showType;
                        this.rules.error(
                            overflow ? 'M009' : 'M032',
                            `Argument '${p.name}' of '${f.name}' is a '${show(want)}', but '${e.args[i]!.text}' is a '${show(got)}'.`,
                            e.argsAt[i]!,
                            overflow && roundHint(e.args[i]!, overflow),
                        );
                    }
                }
                return returnType(f);
            }
            case 'list': {
                // `[a, b, ...xs]`: the elements, of one type
                let elem: Ty | undefined;
                for (const item of e.items) {
                    const t = this.check(item.value, scope);
                    if (t.k === 'error') return ERROR;
                    const x = item.spread ? (t.k === 'list' ? t.elem : undefined) : t;
                    if (!x) {
                        this.rules.error('M009', `'...' spreads a list, but '${item.value.text}' is a '${showType(t)}'.`, item.value.at);
                        return ERROR;
                    }
                    if (elem && !equatable(elem, x)) {
                        this.rules.error(
                            'M009',
                            `A list holds values of one type, but '${item.value.text}' is a '${showType(x)}', not a '${showType(elem)}'.`,
                            item.value.at,
                        );
                        return ERROR;
                    }
                    elem = elem ? joinScale(elem, x) : x;
                }
                return { k: 'list', elem: elem ?? ERROR };
            }
            case 'listMethod': {
                const coll = this.check(e.collection, scope);
                if (coll.k === 'error') return ERROR;
                if (coll.k !== 'list') {
                    this.rules.error('M009', `'.${e.method}(…)' requires a collection, but got '${showType(coll)}'.`, e.collectionAt);
                    return ERROR;
                }
                let value: Ty = coll.elem;
                if (e.param !== undefined && e.body) {
                    this.recordLambda?.(e.param, e);
                    this.reserved(e.param, e.at);
                    value = this.check(e.body, { ...scope, lambdas: [...scope.lambdas, [e.param, coll.elem, e]] });
                    if (value.k === 'error') return ERROR;
                }
                switch (e.method) {
                    case 'map':
                        return { k: 'list', elem: value };
                    case 'filter':
                        if (!isBool(value)) {
                            this.rules.error('M009', `The predicate of '.filter(…)' must be Bool, but has type '${showType(value)}'.`, e.bodyAt ?? e.at);
                            return ERROR;
                        }
                        return coll;
                    case 'sum': {
                        const base = basePrimitive(value);
                        if (value.k === 'id' || (base !== 'Int' && base !== 'Decimal')) {
                            this.rules.error('M009', `'.sum(…)' adds Int or Decimal values, but got '${showType(value)}'.`, e.bodyAt ?? e.collectionAt);
                            return ERROR;
                        }
                        if (base === 'Int') return COMPUTED_INT;
                        const scale = scaleOf(value);
                        return { k: 'prim', name: 'Decimal', computed: true, ...(scale !== undefined && { scale }) };
                    }
                }
            }
            case 'conditional': {
                // `test ? then : else`: `then` is evaluated when `test` holds, `else` when it does not
                const test = this.check(e.test, scope);
                if (test.k !== 'error' && !isBool(test))
                    this.rules.error('M009', `The condition of '? :' must be Bool, but has type '${showType(test)}'.`, e.testAt);
                const branch = (x: Expr, holds: boolean): Ty => {
                    const paths = guards(e.test, holds);
                    if (paths.length) this.sink?.({ expression: x, paths });
                    return this.check(x, { ...scope, present: new Set([...scope.present, ...paths]) });
                };
                const a = branch(e.ifTrue, true);
                const b = branch(e.ifFalse, false);
                if (a.k === 'error' || b.k === 'error') return ERROR;
                const base = (t: Ty): Ty => (t.k === 'opt' ? t.inner : t);
                if (!equatable(base(a), base(b))) {
                    this.rules.error('M009', `'? :' gives '${showType(a)}' or '${showType(b)}': both branches must have the same type.`, e.at);
                    return ERROR;
                }
                const joined = joinScale(base(a), base(b));
                return a.k === 'opt' || b.k === 'opt' ? { k: 'opt', inner: joined } : joined;
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
                this.reserved(e.param, e.at);
                const coll = this.check(e.collection, scope);
                let elem: Ty = ERROR;
                if (coll.k === 'list') elem = coll.elem;
                else if (coll.k !== 'error') {
                    this.rules.error(
                        'M009',
                        `'.${e.method ?? (e.quantifier === 'all' ? 'every' : 'some')}(…)' requires a collection, but got '${showType(coll)}'.`,
                        e.collectionAt,
                    );
                }
                const inner: Scope = { ...scope, lambdas: [...scope.lambdas, [e.param, elem, e]] };
                const body = this.check(e.body, inner);
                if (body.k !== 'error' && !isBool(body)) {
                    this.rules.error(
                        'M009',
                        `The predicate of '.${e.method ?? (e.quantifier === 'all' ? 'every' : 'some')}(…)' must be Bool, but has type '${showType(body)}'.`,
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
                this.reserved(e.param, e.at);
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
                    const hint = x.k === 'opt' ? ' Optional values must be compared with null first (x != null && …).' : '';
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

    /** M021: `this` is the aggregate in `match (this)`, and names no lambda parameter or binding (as `before` / `after` in contracts). */
    private reserved(name: string, at: import('../source-model.js').Site): void {
        if (name === 'this')
            this.rules.error('M021', `'this' is the aggregate in 'match (this)': it cannot name a lambda parameter or a binding.`, at, `give it another name`);
    }

    /**
     * `match (this) { State { f } => e, … }` (and over `before`, `after`): one case for each state the aggregate can be
     * in there, or for each kind (ADR 0037), never both; a case reads the fields it names (common ones, its state's or
     * its kind's), and in it the subject is in that state or kind, for a `match` inside it.
     */
    private matchAggregate(e: ExprOf<'match'>, frame: AggregateFrame, scope: Scope): Ty {
        const { agg } = frame;
        const subject = e.subject.text;
        const states = statesOf(agg);
        const kinds = kindsOf(agg);
        if (!states.length && !kinds.length) {
            this.rules.error(
                'M009',
                `'match (${subject})' chooses by the state or the kind of '${agg.name}', which has neither.`,
                e.subjectAt,
                `read the fields of '${agg.name}' by name`,
            );
            return ERROR;
        }
        // a name of a state and of a kind is reported by M011 (the generated types); it is the state's here
        const sort = (name: string): 'state' | 'kind' | undefined =>
            states.some((s) => s.name === name) ? 'state' : kinds.some((k) => k.name === name) ? 'kind' : undefined;
        const sorts = new Set(e.cases.map((c) => sort(c.variant)).filter((x) => x !== undefined));
        if (sorts.size > 1) {
            const named = (which: 'state' | 'kind'): string => quoted(e.cases.filter((c) => sort(c.variant) === which).map((c) => c.variant));
            this.rules.error(
                'M009',
                `'match (${subject})' names states (${named('state')}) and kinds (${named('kind')}): one 'match' chooses by the state or by the kind, not both.`,
                e.at,
                `match on one of them, and write a 'match (${subject})' over the other inside a case`,
            );
            return ERROR;
        }
        const by: 'state' | 'kind' = [...sorts][0] ?? (states.length ? 'state' : 'kind');
        const among: readonly { name: string }[] = by === 'state' ? frameStates(frame) : frameKinds(frame);
        const what = by === 'state' ? frame.statesWhat : frame.kindsWhat;
        const Which = by === 'state' ? 'State' : 'Kind';
        const seen = new Set<string>();
        let result: Ty | undefined;
        for (const c of e.cases) {
            const which = sort(c.variant);
            if (!which) {
                const names = [...states, ...kinds].map((x) => x.name);
                const noun = !kinds.length ? 'state' : !states.length ? 'kind' : 'state or kind';
                this.rules.error('M009', `'${agg.name}' has no ${noun} '${c.variant}'.`, c.variantAt, didYouMean(c.variant, names));
                continue;
            }
            if (!among.some((x) => x.name === c.variant)) {
                this.rules.error(
                    'M009',
                    `${Which} '${c.variant}' is not among ${what} (${quoted(among.map((x) => x.name)) || 'none'}): 'match (${subject})' has a case for each of them, and only for them.`,
                    c.variantAt,
                    `remove the case '${c.variant}'`,
                );
                continue;
            }
            if (seen.has(c.variant)) this.rules.error('M009', `${Which} '${c.variant}' has two cases.`, c.variantAt);
            seen.add(c.variant);
            // in the case: the pairs of that state or kind, for the subject and the frames that narrow with it
            const keep = (p: AggregatePair): boolean => (by === 'state' ? p[frame.side]?.name === c.variant : p.kind?.name === c.variant);
            const pairs = frame.pairs.filter(keep);
            const subjectName = e.subject.k === 'name' && (e.subject.name === 'before' || e.subject.name === 'after') ? e.subject.name : 'this';
            const where = `where '${subjectName}' is ${by === 'state' ? 'in' : 'of'} ${by} '${c.variant}'`;
            const narrow = (name: 'before' | 'after' | 'this', a: AggregateFrame, own: boolean): Ty =>
                aggregateFrameTy(name, {
                    ...a,
                    pairs,
                    statesWhat: own && by === 'state' ? `the states of the case '${c.variant}'` : `${a.statesWhat} ${where}`,
                    kindsWhat: own && by === 'kind' ? `the kinds of the case '${c.variant}'` : `${a.kindsWhat} ${where}`,
                });
            const inner = narrow(subjectName, frame, true);
            const fields = inner.k === 'frame' ? inner.fields : new Map<string, FieldDecl | ParamDecl>();
            const lambdas = [...scope.lambdas];
            for (const name of c.bindings) {
                this.reserved(name, c.at);
                const f = fields.get(name);
                if (!f)
                    this.rules.error(
                        'M009',
                        `${Which} '${c.variant}' of '${agg.name}' has no field '${name}'${by === 'state' ? '' : ' that every state it can be in here has'}.`,
                        c.at,
                        didYouMean(name, [...fields.keys()]),
                    );
                const shadowed = scope.fields.get(name);
                if (f && shadowed?.kind === 'param')
                    this.rules.error(
                        'M019',
                        `The binding '${name}' in the case '${c.variant}' of 'match (${subject})' has the name of a parameter, which it would hide.`,
                        c.at,
                        e.subject.k === 'name' && e.subject.name !== 'this'
                            ? `read the field as '${e.subject.name}.${name}' without binding it, or rename the parameter`
                            : `rename the parameter (e.g. 'new${name[0]!.toUpperCase()}${name.slice(1)}'), so that '${name}' in the case means the field`,
                    );
                lambdas.push([name, f ? memberType(f) : ERROR, c.body]);
            }
            const frames = scope.frames
                ? new Map(
                      [...scope.frames].map(([name, ty]): [string, Ty] =>
                          name === subjectName
                              ? [name, inner]
                              : ty.k === 'frame' && ty.aggregate?.group === frame.group
                                ? [name, narrow(ty.name, ty.aggregate, false)]
                                : [name, ty],
                      ),
                  )
                : undefined;
            const t = this.check(c.body, { ...scope, lambdas, ...(frames && { frames }) });
            if (t.k === 'error') continue;
            const joined = joinCase(result, t);
            if (!joined) {
                this.rules.error('M009', `The cases of 'match' give '${showType(result!)}' and '${showType(t)}': every case must have the same type.`, c.at);
                continue;
            }
            result = joined;
        }
        const missing = among.filter((x) => !seen.has(x.name)).map((x) => x.name);
        if (missing.length) {
            this.rules.error(
                'M009',
                `'match (${subject})' has no case for ${quoted(missing)}: it has one case for each of ${what} (${quoted(among.map((x) => x.name))}).`,
                e.at,
            );
            return ERROR;
        }
        return result ?? ERROR;
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
        if (op === '+' || op === '-' || op === '*' || op === '/') return this.arithmetic(e, scope);
        if (op === '??') {
            // `a ?? b`: the value of the optional `a`, else `b`, of the same type
            const l = this.check(e.left, scope);
            const r = this.check(e.right, scope);
            if (l.k === 'error' || r.k === 'error') return ERROR;
            if (l.k !== 'opt') {
                this.rules.error('M009', `'??' gives the left operand when it is present, but '${showType(l)}' is always present.`, e.leftAt);
                return l;
            }
            const right = r.k === 'opt' ? r.inner : r;
            if (!equatable(l.inner, right)) {
                this.rules.error('M009', `'??' gives '${showType(l.inner)}' or '${showType(r)}': both sides must have the same type.`, e.at);
                return ERROR;
            }
            const joined = joinScale(l.inner, right);
            return r.k === 'opt' ? { k: 'opt', inner: joined } : joined;
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
            const hint = l.k === 'opt' || r.k === 'opt' ? ' Optional values must be compared with null first (x != null && …).' : '';
            this.rules.error('M009', `Operator '${op}' cannot be applied to '${showType(l)}' and '${showType(r)}'.${hint}`, e.at);
        }
        return BOOL;
    }

    /**
     * `a + b`, `a - b`, `a * b` over Int and Decimal (a domain primitive gives its base type), and `a / b` over Decimal:
     * an Int with a Decimal is a Decimal. `+ -` keep the larger scale, `*` adds the scales, `/` rounds half-even to the
     * larger declared scale, so both scales must be known, and its divisor must be shown non-zero.
     */
    private arithmetic(e: ExprOf<'binary'>, scope: Scope): Ty {
        const l = this.check(e.left, scope);
        const r = this.check(e.right, scope);
        if (l.k === 'error' || r.k === 'error') return ERROR;
        const op = e.op;
        for (const [t, at] of [
            [l, e.leftAt],
            [r, e.rightAt],
        ] as const) {
            const base = basePrimitive(t);
            if (t.k === 'id' || (base !== 'Int' && base !== 'Decimal')) {
                this.rules.error(
                    'M009',
                    `Operator '${op}' requires Int or Decimal operands, but got '${showType(t)}'.${t.k === 'opt' ? ' Optional values must be compared with null first (x != null && …).' : ''}`,
                    at,
                );
                return ERROR;
            }
        }
        const decimal = basePrimitive(l) === 'Decimal' || basePrimitive(r) === 'Decimal';
        if (op === '/' && !decimal) {
            this.rules.error('M009', `Int has no '/': divide Decimal values, e.g. declare the field 'Decimal(2)'.`, e.at);
            return ERROR;
        }
        const [ls, rs] = [scaleOf(l), scaleOf(r)];
        if (op === '/') {
            if (ls === undefined || rs === undefined) {
                const which = ls === undefined ? e.left : e.right;
                this.rules.error(
                    'M009',
                    `'/' rounds to a declared scale, but '${which.text}' is a Decimal of no declared scale: declare it 'Decimal(n)'.`,
                    which.at,
                );
                return ERROR;
            }
            if ((e.right.k === 'int' || e.right.k === 'decimal') && Number(e.right.value) === 0) this.rules.error('M009', `Division by zero.`, e.rightAt);
            else if (e.right.k !== 'int' && e.right.k !== 'decimal' && !scope.present.has(nonZeroKey(e.right)))
                this.rules.error(
                    'M009',
                    `'${e.right.text}' may be zero: show that it is not where it is divided by (e.g. '${e.right.text} != 0 && …').`,
                    e.rightAt,
                );
        }
        if (!decimal) return COMPUTED_INT;
        const scale = ls === undefined || rs === undefined ? undefined : op === '*' ? ls + rs : Math.max(ls, rs);
        return { k: 'prim', name: 'Decimal', computed: true, ...(scale !== undefined && { scale }) };
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
        // a lambda parameter or binding named `this` is reported where it is declared (M021): read it as that
        // (and a field or parameter named `this` where it is declared, M030), outside a `match` subject
        const declaredThis = name === 'this' && (scope.lambdas.some(([n]) => n === 'this') || (scope.fields.has('this') && !this.matchSubjects.has(node)));
        const frame = declaredThis ? undefined : scope.frames?.get(name);
        if (frame) {
            if (name === 'this' && !this.matchSubjects.has(node)) {
                this.rules.error(
                    'M009',
                    `'this' is the aggregate itself, which is read only as the subject of 'match (this) { … }'.`,
                    node.at,
                    `read the fields by name, or choose by its state or kind with 'match (this) { … }'`,
                );
                return ERROR;
            }
            this.symbols.set(node, { kind: 'frame', name, id: name });
            return frame;
        }
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
            this.rules.error(hidden.code ?? 'M010', hidden.message, node.at, hidden.hint);
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
        // `this.x`: the fields of the aggregate are read by name
        const r = e.receiver;
        if (r.k === 'name' && r.name === 'this' && !scope.lambdas.some(([n]) => n === 'this') && !scope.fields.has('this')) {
            const hidden = scope.hidden.get('this');
            if (scope.frames?.has('this')) {
                this.rules.error('M001', `'this.${e.member}': the fields of the aggregate are read by name here.`, e.at, `write '${e.member}'`);
                return ERROR;
            }
            if (hidden?.memberHint) {
                this.rules.error(hidden.code ?? 'M010', hidden.message, r.at, hidden.memberHint(e.member));
                return ERROR;
            }
        }
        if (!e.optional) return this.memberOf(e, this.infer(e.receiver, scope), scope);
        // `x?.f`: the field of an optional value, absent when the value is
        const recv = this.infer(e.receiver, scope);
        if (recv.k === 'error') return ERROR;
        if (recv.k !== 'opt') {
            this.rules.error('M009', `'?.' reads a field of an optional value, but '${showType(recv)}' is always present: write '.${e.member}'.`, e.memberAt);
            return ERROR;
        }
        const t = this.memberOf(e, recv.inner, scope);
        return t.k === 'error' || t.k === 'opt' ? t : { k: 'opt', inner: t };
    }

    private memberOf(e: ExprOf<'member'>, recv: Ty, scope: Scope): Ty {
        const m = e.member;
        switch (recv.k) {
            case 'error':
                return ERROR;
            case 'frame': {
                // `before.x` / `after.x`: a field the aggregate has before / after the outcome
                const f = recv.fields.get(m);
                if (!f) {
                    this.rules.error(
                        'M001',
                        `'${recv.name}.${m}': the aggregate has no field '${m}' ${recv.name} this outcome.`,
                        e.memberAt,
                        didYouMean(m, [...recv.fields.keys()]),
                    );
                    return ERROR;
                }
                this.symbols.set(e, { kind: 'field', name: m, declaration: f });
                return memberType(f);
            }
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
                this.rules.error('M009', `'${pathOf(e.receiver) ?? 'value'}' is optional; compare it with null first (x != null && …).`, e.at);
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

/**
 * The type of the cases of a `match` so far (`result`) with one more case of type `t`: they agree by type, their scales
 * aside (the join takes the larger, and scale fit checks it where it is placed); `undefined` when they do not agree.
 */
function joinCase(result: Ty | undefined, t: Ty): Ty | undefined {
    if (!result) return t;
    if (!assignable(result, t, false) && !assignable(t, result, false)) return undefined;
    const inner = joinScale(result.k === 'opt' ? result.inner : result, t.k === 'opt' ? t.inner : t);
    return result.k === 'opt' || t.k === 'opt' ? { k: 'opt', inner } : inner;
}

function comparisonKind(l: Ty, r: Ty, ordering: boolean): NonNullable<ExpressionFact['comparison']> {
    if (ordering) return 'ordered';
    if (l.k === 'tag' && r.k === 'tag') return 'enumValue';
    if (l.k === 'struct' && r.k === 'struct' && l.decl === r.decl) return l.decl.kind === 'entity' ? 'entityStructural' : 'valueObjectStructural';
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
/** The key of the fact that an expression is not zero, among the paths of `Scope.present`. */
const nonZeroKey = (e: Expr): string => `≠0 ${e.text}`;

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
        if (!p || !holds) return [];
        // `x?.f != null` shows `x` present too (and each receiver read with `?.`)
        const receivers: string[] = [];
        for (let x: Expr = e.operand; x.k === 'member'; x = x.receiver) {
            const r = x.optional ? pathOf(x.receiver) : undefined;
            if (r) receivers.push(r);
        }
        return [...receivers.reverse(), p];
    }
    // `d != 0` holding (or `d == 0` not holding), `d > 0` / `d < 0` holding: `d` is not zero where it holds
    if (e.k === 'binary' && (e.op === '!=' || e.op === '==' || e.op === '>' || e.op === '<')) {
        const zero = (x: Expr): boolean => (x.k === 'int' || x.k === 'decimal') && Number(x.value) === 0;
        const other = zero(e.right) ? e.left : zero(e.left) ? e.right : undefined;
        if (other && (e.op === '==' ? !holds : holds)) return [nonZeroKey(other)];
        return [];
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

/** The most digits after the point `x.round(n)` rounds to. */
const MAX_ROUND_SCALE = 30;

/**
 * `==`, `!=`, `unique` and `contains` compare by this rule: value objects and owned entities by all their fields
 * (ADR 0042), unions by discriminator and fields. Lists and optionals cannot be compared.
 */
/**
 * Whether a value of type `got` can be passed where `want` is declared (an argument, a function's result); `scaled`
 * false leaves scale fit out (the cases of `match`, which agree by type and join their scales).
 */
function assignable(want: Ty, got: Ty, scaled = true): boolean {
    if (scaled && scaleOverflow(want, got)) return false;
    if (want.k === 'list') return got.k === 'list' && (got.elem.k === 'error' || assignable(want.elem, got.elem, scaled));
    if (want.k === 'opt') return assignable(want.inner, got.k === 'opt' ? got.inner : got, scaled);
    return got.k !== 'list' && got.k !== 'opt' && equatable(want, got);
}

/**
 * Scale fit: a Decimal of known scale placed where a `Decimal(n)` (or a domain primitive over one) is declared has at
 * most `n` digits after the point; a smaller scale widens. The declared and the actual scale when it has more, through
 * lists and optionals; `undefined` when it fits or a scale is not known.
 */
function scaleOverflow(want: Ty, got: Ty): { want: number; got: number; list: boolean } | undefined {
    if (want.k === 'list') {
        const inner = got.k === 'list' ? scaleOverflow(want.elem, got.elem) : undefined;
        return inner && { ...inner, list: true };
    }
    if (want.k === 'opt') return scaleOverflow(want.inner, got.k === 'opt' ? got.inner : got);
    if (want.k === 'id' || got.k === 'id' || basePrimitive(want) !== 'Decimal' || basePrimitive(got) !== 'Decimal') return undefined;
    const [w, g] = [scaleOf(want), scaleOf(got)];
    return w !== undefined && g !== undefined && g > w ? { want: w, got: g, list: false } : undefined;
}

/** The hint of a scale that does not fit: the expression rounded (each element of a list). */
function roundHint(expr: Expr, overflow: { want: number; list: boolean }): string {
    if (overflow.list) return `round each element: '${expr.text}.map(x => x.round(${overflow.want}))'`;
    const atomic = ['name', 'member', 'decimal', 'int', 'call', 'round', 'listMethod'].includes(expr.k);
    return `round it: '${atomic ? expr.text : `(${expr.text})`}.round(${overflow.want})'`;
}

/** A type as `showType` writes it, with the scale of a Decimal: `Decimal(2)`, `Decimal(4)[0..*]`. */
function showScaled(t: Ty): string {
    if (t.k === 'prim' && t.name === 'Decimal' && t.scale !== undefined) return `Decimal(${t.scale})`;
    if (t.k === 'list') return `${showScaled(t.elem)}[0..*]`;
    if (t.k === 'opt') return `${showScaled(t.inner)}?`;
    return showType(t);
}

/**
 * The type of a value that is one of two of one type (the branches of `? :`, the sides of `??`, the elements of a
 * list, the cases of `match`), so that it fits where both fit. Two numbers, one of them a Decimal (a domain primitive
 * over one included; an Int has scale 0), have the larger scale: `a` or else `b` when it has it (a literal aside), else
 * a computed Decimal of that scale; a Decimal of unknown scale makes it unknown. Other types are `a`.
 */
function joinScale(a: Ty, b: Ty): Ty {
    const [x, y] = [basePrimitive(a), basePrimitive(b)];
    if (a.k === 'id' || b.k === 'id' || (x !== 'Decimal' && y !== 'Decimal') || !isNumeric(baseOf(a)) || !isNumeric(baseOf(b))) return a;
    const [sa, sb] = [scaleOf(a), scaleOf(b)];
    const scale = sa === undefined || sb === undefined ? undefined : Math.max(sa, sb);
    if (a.k === 'prim' && b.k === 'prim' && x === 'Decimal' && y === 'Decimal') {
        // two plain Decimals: `a`, with the joined scale
        if (sa === scale) return a;
        return {
            k: 'prim',
            name: 'Decimal',
            ...(a.literal && { literal: true }),
            ...(a.computed && { computed: true }),
            ...(scale !== undefined && { scale }),
        };
    }
    for (const t of [a, b]) if (basePrimitive(t) === 'Decimal' && scaleOf(t) === scale && !(t.k === 'prim' && t.literal)) return t;
    return { k: 'prim', name: 'Decimal', computed: true, ...(scale !== undefined && { scale }) };
}

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
